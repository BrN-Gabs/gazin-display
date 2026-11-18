/**
 * Servidor isolado para os testes end-to-end: o Worker real em `wrangler dev`, com D1, R2 e
 * Durable Object locais próprios (.data/e2e-worker) e o build de produção do painel/player (dist/web).
 */
import { startWorker } from '../worker-server';

const PORT = Number(process.env.E2E_PORT ?? 3100);

const w = await startWorker({ name: 'e2e-worker', port: PORT });
console.log(`E2E server ready on ${PORT}`);
const stop = async () => {
  await w.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
