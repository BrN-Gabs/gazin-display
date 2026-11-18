/**
 * Cria um administrador no D1 ou redefine a senha de um existente.
 *
 *   npm run create-admin -- --local                 (banco local do `wrangler dev`)
 *   npm run create-admin -- --remote                (banco de produção na Cloudflare)
 *
 * Opções: --email admin@gazin.com.br --name "Administrador"
 * A senha é pedida no terminal (oculta) ou lida de ADMIN_PASSWORD. Ela nunca é enviada em texto puro:
 * o hash PBKDF2 é calculado aqui e somente o hash é gravado no D1 (via `wrangler d1 execute`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { hashPassword, passwordProblems } from '../src/worker/lib/security';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
        else out.output.write('*');
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

const sql = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);

async function main() {
  const target = flag('remote') ? '--remote' : '--local';
  const email = (opt('email') ?? (await ask('E-mail do administrador: '))).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('E-mail inválido.');
  const name = opt('name') ?? 'Administrador';
  let password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    password = await ask('Senha (mín. 10 caracteres, 3 tipos): ', true);
    const again = await ask('Repita a senha: ', true);
    if (password !== again) throw new Error('As senhas não conferem.');
  }
  const problem = passwordProblems(password);
  if (problem) throw new Error(problem);
  // mesmo valor de PASSWORD_ITERATIONS em wrangler.jsonc
  const iterations = Number(process.env.PASSWORD_ITERATIONS ?? 50_000);
  const hash = await hashPassword(password, iterations);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const statement = `
INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "canPublish", "active", "createdAt", "updatedAt", "passwordChangedAt")
VALUES (${sql(id)}, ${sql(name)}, ${sql(email)}, ${sql(hash)}, 'ADMIN', 1, 1, ${sql(now)}, ${sql(now)}, ${sql(now)})
ON CONFLICT("email") DO UPDATE SET "passwordHash" = excluded."passwordHash", "role" = 'ADMIN', "active" = 1, "passwordChangedAt" = excluded."passwordChangedAt", "updatedAt" = excluded."updatedAt";
DELETE FROM "Session" WHERE "userId" = (SELECT "id" FROM "User" WHERE "email" = ${sql(email)});
INSERT INTO "AuditLog" ("id", "action", "summary", "createdAt") VALUES (${sql(crypto.randomUUID())}, 'user.created', ${sql(`Administrador ${email} criado/redefinido pelo terminal`)}, ${sql(now)});
`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gd-admin-')), 'admin.sql');
  fs.writeFileSync(file, statement, { mode: 0o600 });
  try {
    const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--file', file, '--yes'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error('Falha ao executar no D1 (verifique se as migrations foram aplicadas e se você está autenticado no wrangler).');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  console.log(`\nAdministrador ${email} pronto (${target === '--remote' ? 'produção' : 'local'}). Sessões anteriores dele foram encerradas.`);
}

main().catch((err) => {
  console.error(`Erro: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
