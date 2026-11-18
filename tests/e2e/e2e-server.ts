/**
 * Servidor isolado para os testes end-to-end: PostgreSQL embutido próprio,
 * armazenamento temporário e um administrador de teste. Usa o build de produção (dist/web).
 */
import fs from 'node:fs';
import path from 'node:path';
import { startTestDatabase } from '../test-db.js';
import { loadConfig } from '../../src/server/config.js';
import { buildApp } from '../../src/server/app.js';
import { createDb } from '../../src/server/db.js';
import { hashPassword } from '../../src/server/lib/security.js';

const PORT = Number(process.env.E2E_PORT ?? 3100);

async function main() {
  const { pg, url } = await startTestDatabase({ port: 54331, name: 'gd_e2e', dir: path.resolve('.data/e2e-pg') });
  const storageDir = path.resolve('.data/e2e-storage');
  fs.rmSync(storageDir, { recursive: true, force: true });
  const db = createDb(url);
  await db.user.create({ data: { name: 'Admin E2E', email: 'admin@e2e.local', passwordHash: await hashPassword('Senha-E2E-2026!'), role: 'ADMIN' } });
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, STORAGE_DIR: storageDir, PORT: String(PORT), LOG_LEVEL: 'warn', UPLOAD_CHUNK_MB: '1' });
  const built = await buildApp(config, { db, logger: { level: 'warn' } });
  await built.app.listen({ host: '127.0.0.1', port: PORT });
  await built.startBackground();
  console.log(`E2E server ready on ${PORT}`);
  const stop = async () => {
    await built.close().catch(() => {});
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
