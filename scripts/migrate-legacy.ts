/**
 * Migração dos dados da versão 1 (Node + PostgreSQL + disco local/S3) para a versão Cloudflare (D1 + R2).
 *
 * Não altera nem apaga nada no sistema antigo: apenas LÊ o PostgreSQL e os arquivos.
 *
 *   1) Suba o banco antigo (ex.: na versão 1: `npm run db:local`, ou deixe o servidor antigo ligado).
 *   2) Gere o SQL e envie os arquivos ao R2:
 *        $env:DATABASE_URL="postgresql://postgres:SENHA@localhost:5433/gazin_display"
 *        $env:STORAGE_DIR="C:\caminho\do\gazin-display-v1\storage"
 *        $env:R2_ACCOUNT_ID="..."; $env:R2_ACCESS_KEY_ID="..."; $env:R2_SECRET_ACCESS_KEY="..."
 *        npm run migrate:legacy -- --out migracao.sql --upload
 *      (sem --upload, só gera o SQL e confere os arquivos)
 *   3) Importe no D1 (banco vazio, com as migrations aplicadas):
 *        npx wrangler d1 execute DB --remote --file migracao.sql
 *
 * Se a versão 1 usava STORAGE_DRIVER=s3, informe também S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, S3_REGION e S3_PREFIX (os mesmos do .env antigo): os arquivos são lidos de lá.
 *
 * Observações:
 *  - Senhas (Argon2id) são preservadas e convertidas para PBKDF2 no primeiro login de cada usuário.
 *  - Sessões, uploads em andamento e códigos de vinculação pendentes não são migrados (são temporários).
 *  - Credenciais dos telões são migradas, mas só continuam válidas se o endereço (domínio) do sistema for o mesmo;
 *    em um domínio novo (ex.: *.workers.dev), vincule cada telão novamente pelo painel.
 *  - Mídias cujo arquivo não for encontrado são migradas como "falha" (com aviso), sem quebrar as playlists.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = process.env;

const OUT = opt('out') ?? 'migracao.sql';
const UPLOAD = flag('upload');

// Ordem respeita as chaves estrangeiras
const TABLES = ['User', 'Media', 'Playlist', 'PlaylistItem', 'PlaylistVersion', 'DisplayDevice', 'DeviceCredential', 'DeviceCommand', 'Schedule', 'AuditLog', 'AppSetting'] as const;
const ARRAY_COLS = new Set(['mediaIds', 'daysOfWeek']);

function pgArray(v: string) {
  const inner = v.trim().replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
}

function lit(col: string, v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (ARRAY_COLS.has(col)) {
    const arr = Array.isArray(v) ? v : pgArray(String(v));
    const vals = col === 'daysOfWeek' ? arr.map(Number) : arr;
    return `'${JSON.stringify(vals).replace(/'/g, "''")}'`;
  }
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  // int8 chega como string no driver pg
  if (/^(sizeBytes|originalSize|totalBytes|totalDurationMs)$/.test(col) && /^\d+$/.test(String(v))) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function legacyS3() {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    endpoint: env.S3_ENDPOINT || undefined,
    region: env.S3_REGION || 'us-east-1',
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
}

function r2() {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new Error('Para --upload, defina R2_ACCOUNT_ID, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY.');
  return new S3Client({
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
}

/** Localiza o arquivo da versão 1 (disco local) */
function localFile(key: string) {
  const dir = path.resolve(env.STORAGE_DIR ?? './storage');
  for (const c of [path.join(dir, key), path.join(dir, 'files', key), path.join(dir, 'objects', key), path.join(dir, 'media', key.replace(/^media\//, ''))]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

async function main() {
  if (!env.DATABASE_URL) throw new Error('Defina DATABASE_URL (PostgreSQL da versão 1).');
  const db = new pg.Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  const source = legacyS3();
  const prefix = env.S3_PREFIX ?? 'gazin-display/';
  const target = UPLOAD ? r2() : null;
  const bucket = env.R2_BUCKET_NAME || 'gazin-display-media';

  const out: string[] = ['-- Migração GAZIN DISPLAY v1 → Cloudflare D1', `-- Gerado em ${new Date().toISOString()}`, 'PRAGMA defer_foreign_keys = true;'];
  const missing: string[] = [];
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;

  async function ensureObject(key: string, contentType: string) {
    const local = source ? null : localFile(key);
    if (!source && !local) return false;
    if (!target) return true;
    try {
      await target.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      skipped++; // já enviado anteriormente (execução repetida)
      return true;
    } catch {
      /* não existe no R2 */
    }
    let body: Readable | fs.ReadStream;
    if (source) {
      try {
        body = (await source.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: prefix + key }))).Body as Readable;
      } catch {
        return false;
      }
    } else body = fs.createReadStream(local!);
    // multipart automático (partes de 16 MB) — suporta arquivos grandes
    await new Upload({ client: target, params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType }, partSize: 16 * 1024 * 1024, queueSize: 4 }).done();
    uploaded++;
    if (local) bytes += fs.statSync(local).size;
    process.stdout.write(`  enviado ${key}\n`);
    return true;
  }

  for (const table of TABLES) {
    const { rows } = await db.query(`SELECT * FROM "${table}"`);
    console.log(`${table}: ${rows.length} registro(s)`);
    for (const row of rows) {
      if (table === 'Media') {
        const ok =
          !row.storageKey ||
          ((await ensureObject(row.storageKey, row.mimeType)) &&
            (!row.originalKey || row.originalKey === row.storageKey || (await ensureObject(row.originalKey, 'application/octet-stream'))));
        if (row.thumbnailKey) await ensureObject(row.thumbnailKey, 'image/webp');
        if (row.previewKey) await ensureObject(row.previewKey, 'image/webp');
        if (!ok) {
          missing.push(`${row.name} (${row.storageKey})`);
          row.status = 'FAILED';
          row.error = 'Arquivo não encontrado na migração. Envie novamente.';
        } else if (row.status === 'PROCESSING') {
          row.status = 'FAILED';
          row.error = 'Processamento interrompido na migração. Envie novamente.';
        }
      }
      const cols = Object.keys(row);
      out.push(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(c, row[c])).join(', ')});`);
    }
  }
  await db.end();
  fs.writeFileSync(OUT, out.join('\n') + '\n');
  console.log(`\nSQL gravado em ${OUT}. Importe com: npx wrangler d1 execute DB --remote --file ${OUT}`);
  if (UPLOAD) console.log(`Arquivos enviados ao R2: ${uploaded} (${(bytes / 1024 ** 3).toFixed(2)} GB), já existentes: ${skipped}.`);
  if (missing.length) {
    console.warn(`\nATENÇÃO: ${missing.length} mídia(s) sem arquivo de origem (migradas como "falha"):`);
    for (const m of missing) console.warn(`  - ${m}`);
  }
}

main().catch((err) => {
  console.error(`Erro: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
