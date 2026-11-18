/**
 * PostgreSQL embutido para DESENVOLVIMENTO local (sem Docker).
 * Os dados ficam em ./.data/postgres e persistem entre execuções.
 *
 * Uso: npm run db:local   (deixe este terminal aberto)
 * Em produção use um PostgreSQL real (docker-compose.yml ou servidor gerenciado).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';

export interface LocalDbOptions {
  dataDir: string;
  port: number;
  password: string;
  database: string;
  log?: boolean;
}

/**
 * Windows: processos filhos do PostgreSQL podem ficar órfãos após uma interrupção abrupta,
 * segurando a memória compartilhada e impedindo um novo start. Remove apenas processos
 * postgres.exe deste projeto cujo processo pai não existe mais.
 */
function killOrphanedPostgres() {
  if (process.platform !== 'win32') return;
  try {
    const script =
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\"; " +
      "foreach ($p in $procs) { if ($p.CommandLine -like '*embedded-postgres*' -and -not (Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 30_000 });
  } catch {
    /* best effort */
  }
}

export async function startLocalDb(opts: LocalDbOptions) {
  killOrphanedPostgres();
  const initialised = fs.existsSync(path.join(opts.dataDir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    port: opts.port,
    user: 'postgres',
    password: opts.password,
    persistent: true,
    authMethod: 'scram-sha-256',
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    // sem io_workers (evita processos órfãos no Windows)
    postgresFlags: ['-c', 'io_method=sync'],
    onLog: opts.log ? (m) => console.log('[pg]', String(m).trim()) : () => {},
    onError: (m) => console.error('[pg]', m),
  });
  if (!initialised) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.database]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${opts.database.replace(/"/g, '')}"`);
  await client.end();
  return pg;
}

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres:gazin-dev@localhost:5433/gazin_display');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    console.error('DATABASE_URL não aponta para localhost — o banco embutido é apenas para desenvolvimento.');
    process.exit(1);
  }
  const dataDir = path.resolve('.data/postgres');
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const pg = await startLocalDb({
    dataDir,
    port: Number(url.port || 5432),
    password: decodeURIComponent(url.password || 'gazin-dev'),
    database: url.pathname.replace(/^\//, '') || 'gazin_display',
  });
  console.log(`PostgreSQL local em execução: ${url.hostname}:${url.port} (dados em ${dataDir})`);
  console.log('Pressione Ctrl+C para encerrar.');
  const shutdown = async () => {
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
