/**
 * Sobe uma instância isolada do Worker com `wrangler dev` (D1, R2 e Durable Object locais em .data/<nome>),
 * aplica as migrations e cadastra os usuários de teste. Usado pelos testes de integração e end-to-end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { argon2id } from '@noble/hashes/argon2.js';
import { hashPassword } from '../src/worker/lib/security';

export const ADMIN = { email: 'admin@teste.local', password: 'Senha-Forte-123' };
export const EDITOR = { email: 'editor@teste.local', password: 'Senha-Forte-456' };
/** Usuário com hash Argon2id da versão 1 (migrado) */
export const LEGACY = { email: 'legado@teste.local', password: 'Senha-Legada-789' };

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';

function run(args: string[]) {
  const r = spawnSync(npx, args, { encoding: 'utf8', shell: isWin });
  if (r.status !== 0) throw new Error(`falhou: npx ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function legacyArgon2(password: string) {
  // mesmo formato do @node-rs/argon2 (m=19456, t=2, p=1); parâmetros menores para o teste ser rápido
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const out = argon2id(new TextEncoder().encode(password), salt, { m: 1024, t: 2, p: 1, dkLen: 32 });
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=1024,t=2,p=1$${b64(salt)}$${b64(out)}`;
}

export async function startWorker(opts: { name: string; port: number; vars?: Record<string, string> }) {
  const state = path.resolve('.data', opts.name);
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync('dist/web', { recursive: true });
  if (!fs.existsSync('dist/web/index.html')) fs.writeFileSync('dist/web/index.html', '<!doctype html><title>GAZIN DISPLAY</title>');

  run(['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
  const ts = new Date().toISOString();
  const user = async (email: string, name: string, role: string, canPublish: number, hash?: string) =>
    `INSERT INTO "User" ("id","name","email","passwordHash","role","canPublish","active","createdAt","updatedAt") VALUES ('${crypto.randomUUID()}','${name}','${email}','${hash ?? ''}','${role}',${canPublish},1,'${ts}','${ts}');`;
  const seed = [
    await user(ADMIN.email, 'Admin Teste', 'ADMIN', 1, await hashPassword(ADMIN.password)),
    await user(EDITOR.email, 'Editor Teste', 'EDITOR', 0, await hashPassword(EDITOR.password)),
    await user(LEGACY.email, 'Usuário Legado', 'EDITOR', 1, legacyArgon2(LEGACY.password)),
  ].join('\n');
  const seedFile = path.join(state, 'seed.sql');
  fs.writeFileSync(seedFile, seed);
  run(['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--file', seedFile, '--yes']);

  const vars = { UPLOAD_CHUNK_MB: '5', ...(opts.vars ?? {}) };
  const args = ['wrangler', 'dev', '--port', String(opts.port), '--ip', '127.0.0.1', '--persist-to', state, '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', 'warn'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const proc: ChildProcess = spawn(npx, args, { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout?.on('data', (d) => (log += d));
  proc.stderr?.on('data', (d) => (log += d));
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) break;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() - start > 120_000) throw new Error(`wrangler dev não respondeu:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    baseUrl,
    log: () => log,
    async stop() {
      if (isWin && proc.pid) {
        // encerra toda a árvore (npx → node/wrangler → workerd); só taskkill /T deixava workerd órfão
        const ps = `$ids=@(${proc.pid}); $all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; ` +
          `for($i=0;$i -lt $ids.Count;$i++){ $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $_.ProcessId }) }; ` +
          `$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
        spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
      } else proc.kill('SIGTERM');
    },
  };
}
