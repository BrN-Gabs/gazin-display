/**
 * Inicialização "somente Node": banco embutido (opcional), migrations e administrador do .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { hashPassword, passwordProblems } from './lib/security.js';

const require = createRequire(import.meta.url);
type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

async function canConnect(url: string) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

/** Sobe o PostgreSQL embutido (dados em EMBEDDED_DB_DIR). Se já houver um rodando com as mesmas credenciais, reutiliza. */
export async function startEmbeddedDb(config: AppConfig, log: Log): Promise<{ stop(): Promise<void> } | null> {
  if (!config.EMBEDDED_DB) return null;
  const url = new URL(config.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('EMBEDDED_DB=true exige DATABASE_URL apontando para localhost.');
  if (await canConnect(config.DATABASE_URL)) {
    log.info('PostgreSQL embutido já está em execução — reutilizando.');
    return null;
  }
  const { startLocalDb } = await import('../scripts/local-db.js');
  const dataDir = path.resolve(config.EMBEDDED_DB_DIR);
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  log.info(`Iniciando PostgreSQL embutido (porta ${url.port || 5432}, dados em ${dataDir})...`);
  const instance = await startLocalDb({
    dataDir,
    port: Number(url.port || 5432),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  });
  return { stop: () => instance.stop() };
}

/** Aplica migrations pendentes (prisma migrate deploy) */
export function runMigrations(config: AppConfig, log: Log) {
  const cli = require.resolve('prisma/build/index.js');
  log.info('Aplicando migrations do banco...');
  execFileSync(process.execPath, [cli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: config.DATABASE_URL },
    stdio: 'pipe',
    cwd: path.resolve(path.dirname(cli), '..', '..', '..'),
  });
}

export const DEFAULT_ADMIN_PASSWORD = 'Trocar-Esta-Senha-1';

/**
 * Cria o administrador definido no .env (ADMIN_EMAIL / ADMIN_PASSWORD) se ele ainda não existir.
 * Não sobrescreve a senha de um usuário existente (a troca é feita pelo painel), exceto com ADMIN_RESET_PASSWORD=true.
 */
export async function ensureEnvAdmin(config: AppConfig, db: Db, log: Log) {
  const email = config.ADMIN_EMAIL?.trim().toLowerCase();
  const password = config.ADMIN_PASSWORD;
  if (!email || !password) return 'skipped' as const;
  const problem = passwordProblems(password);
  if (problem) {
    log.error(`ADMIN_PASSWORD inválida no .env (${problem}) — administrador não criado.`);
    return 'invalid' as const;
  }
  const existing = await db.user.findUnique({ where: { email } });
  if (existing && !config.ADMIN_RESET_PASSWORD) return 'exists' as const;
  const passwordHash = await hashPassword(password);
  if (existing) {
    await db.user.update({ where: { id: existing.id }, data: { passwordHash, role: 'ADMIN', active: true, passwordChangedAt: new Date() } });
    await db.session.deleteMany({ where: { userId: existing.id } });
    log.warn(`Senha do administrador ${email} redefinida pelo .env (ADMIN_RESET_PASSWORD=true). Volte a opção para false.`);
    return 'reset' as const;
  }
  await db.user.create({ data: { name: config.ADMIN_NAME || 'Administrador', email, passwordHash, role: 'ADMIN', canPublish: true } });
  await db.auditLog.create({ data: { action: 'user.created', summary: `Administrador ${email} criado a partir do .env` } });
  log.info(`Administrador ${email} criado a partir do .env.`);
  if (password === DEFAULT_ADMIN_PASSWORD) log.warn('ATENÇÃO: o administrador está com a senha de exemplo do .env.example. Troque-a no painel (Configurações → Segurança).');
  return 'created' as const;
}
