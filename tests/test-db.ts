import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startLocalDb } from '../src/scripts/local-db.js';

/**
 * Sobe um PostgreSQL embutido isolado para testes, recria o banco e aplica as migrations.
 */
export async function startTestDatabase(opts: { port: number; name: string; dir: string }) {
  fs.mkdirSync(path.dirname(opts.dir), { recursive: true });
  const pg = await startLocalDb({ dataDir: opts.dir, port: opts.port, password: 'test', database: 'postgres', log: !!process.env.PG_LOG });
  const client = pg.getPgClient();
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${opts.name}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${opts.name}"`);
  await client.end();
  const url = `postgresql://postgres:test@localhost:${opts.port}/${opts.name}`;
  const prismaBin = path.resolve('node_modules/prisma/build/index.js');
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  return { pg, url };
}
