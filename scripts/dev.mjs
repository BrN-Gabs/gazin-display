// Desenvolvimento: sobe a API (tsx watch, porta 3000) e o Vite (porta 5173) juntos.
// Acesse http://localhost:5173/admin. O banco deve estar rodando (npm run db:local ou Docker).
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['run', 'dev:server']],
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
