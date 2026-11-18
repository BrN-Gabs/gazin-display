// Desenvolvimento: sobe o Worker local (wrangler dev, porta 8787 — D1, R2 e Durable Object simulados)
// e o Vite (porta 5173) com recarga automática. Acesse http://localhost:5173/admin.
// Na primeira vez: npm run db:migrate:local && npm run create-admin -- --local
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// o wrangler exige o diretório dos Static Assets; no desenvolvimento quem serve o painel é o Vite
fs.mkdirSync('dist/web', { recursive: true });
if (!fs.existsSync('dist/web/index.html')) fs.writeFileSync('dist/web/index.html', '<!doctype html><p>Use http://localhost:5173/admin (ou npm run build)</p>');

const procs = [
  ['api', ['run', 'dev:worker']],
  ['web', ['run', 'dev:web']],
].map(([name, args]) => {
  const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = name === 'api' ? '\x1b[36m[api]\x1b[0m ' : '\x1b[35m[web]\x1b[0m ';
  const pipe = (stream, out) => stream.on('data', (d) => out.write(String(d).replace(/^(?=.)/gm, prefix)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}encerrado (${code})`);
    procs.forEach((x) => x.kill());
    process.exit(code ?? 0);
  });
  return p;
});
process.on('SIGINT', () => procs.forEach((p) => p.kill()));
