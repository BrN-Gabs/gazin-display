/**
 * Cria (ou redefine a senha de) um administrador.
 * Não existem credenciais padrão: este script é a única forma de criar o primeiro acesso.
 *
 * Interativo:      npm run create-admin
 * Não interativo:  ADMIN_NAME="..." ADMIN_EMAIL="..." ADMIN_PASSWORD="..." npm run create-admin
 *   (em produção / Docker: npm run create-admin:prod ou `docker compose exec app node dist/server/scripts/create-admin.js`)
 */
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createDb } from '../server/db.js';
import { hashPassword, passwordProblems } from '../server/lib/security.js';

async function promptHidden(rl: readline.Interface, question: string) {
  const out = stdout as NodeJS.WriteStream & { _origWrite?: typeof stdout.write };
  const write = out.write.bind(out);
  let muted = false;
  out.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (muted && typeof chunk === 'string' && chunk !== '\n' && chunk !== '\r\n') return true;
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stdout.write;
  const p = rl.question(question);
  muted = true;
  try {
    return await p;
  } finally {
    muted = false;
    out.write = write;
    stdout.write('\n');
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definido.');
  let name = process.env.ADMIN_NAME;
  let email = process.env.ADMIN_EMAIL;
  let password = process.env.ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (!name) name = (await rl.question('Nome do administrador: ')).trim();
    if (!email) email = (await rl.question('E-mail: ')).trim();
    if (!password) {
      password = await promptHidden(rl, 'Senha (mín. 10 caracteres, 3 tipos): ');
      const confirm = await promptHidden(rl, 'Confirme a senha: ');
      if (password !== confirm) throw new Error('As senhas não conferem.');
    }
  } finally {
    rl.close();
  }
  email = email!.toLowerCase();
  if (!name || name.length < 2) throw new Error('Nome inválido.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-mail inválido.');
  const problem = passwordProblems(password!);
  if (problem) throw new Error(problem);

  const db = createDb(url);
  try {
    const passwordHash = await hashPassword(password!);
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      await db.user.update({ where: { id: existing.id }, data: { name, passwordHash, role: 'ADMIN', active: true, passwordChangedAt: new Date() } });
      await db.session.deleteMany({ where: { userId: existing.id } });
      console.log(`Administrador ${email} atualizado (senha redefinida e sessões encerradas).`);
    } else {
      await db.user.create({ data: { name, email, passwordHash, role: 'ADMIN', canPublish: true } });
      console.log(`Administrador ${email} criado com sucesso.`);
    }
    await db.auditLog.create({ data: { action: 'user.created', summary: `Administrador ${email} configurado via linha de comando` } });
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error('Erro:', e instanceof Error ? e.message : e);
  process.exit(1);
});
