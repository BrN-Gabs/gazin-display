import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createDb } from './db.js';
import { ensureEnvAdmin, runMigrations, startEmbeddedDb } from './bootstrap.js';

async function main() {
  const config = loadConfig();
  const bootLog = {
    info: (m: string) => console.log(`[gazin-display] ${m}`),
    warn: (m: string) => console.warn(`[gazin-display] AVISO: ${m}`),
    error: (m: string) => console.error(`[gazin-display] ERRO: ${m}`),
  };

  // 1) banco (PostgreSQL embutido, quando EMBEDDED_DB=true)
  const embedded = await startEmbeddedDb(config, bootLog);
  // 2) migrations
  if (config.AUTO_MIGRATE) runMigrations(config, bootLog);
  // 3) administrador definido no .env
  const db = createDb(config.DATABASE_URL);
  await ensureEnvAdmin(config, db, bootLog);

  // 4) servidor
  const built = await buildApp(config, { db });
  const { app } = built;
  await app.listen({ host: config.HOST, port: config.PORT });
  await built.startBackground();
  app.log.info(`GAZIN DISPLAY em execução — painel: http://localhost:${config.PORT}/admin · player: http://localhost:${config.PORT}/player`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'encerrando...');
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    try {
      await built.close();
      await db.$disconnect();
      await embedded?.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'promise rejeitada sem tratamento'));
}

main().catch((err) => {
  console.error('Falha ao iniciar o servidor:', err?.stderr?.toString?.() || err);
  process.exit(1);
});
