import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureEnvAdmin } from '../../src/server/bootstrap.js';
import { loadConfig } from '../../src/server/config.js';
import { Client, startTestApp, type TestEnv } from '../helpers.js';

let env: TestEnv;
const log = { info: () => {}, warn: () => {}, error: () => {} };
const cfg = (o: Record<string, string>) => loadConfig({ DATABASE_URL: 'postgresql://x:y@localhost:1/z', ...o });

beforeAll(async () => {
  env = await startTestApp();
});
afterAll(() => env.close());

describe('administrador definido no .env', () => {
  it('cria o administrador se não existir e permite login', async () => {
    const r = await ensureEnvAdmin(cfg({ ADMIN_EMAIL: 'Admin@Env.Local', ADMIN_PASSWORD: 'Senha-Do-Env-1', ADMIN_NAME: 'Admin Env' }), env.db, log);
    expect(r).toBe('created');
    const user = await env.db.user.findUniqueOrThrow({ where: { email: 'admin@env.local' } });
    expect(user.role).toBe('ADMIN');
    await new Client(env.baseUrl).login('admin@env.local', 'Senha-Do-Env-1');
  });

  it('não sobrescreve a senha de um administrador existente', async () => {
    const r = await ensureEnvAdmin(cfg({ ADMIN_EMAIL: 'admin@env.local', ADMIN_PASSWORD: 'Outra-Senha-22' }), env.db, log);
    expect(r).toBe('exists');
    await new Client(env.baseUrl).login('admin@env.local', 'Senha-Do-Env-1');
  });

  it('redefine a senha somente com ADMIN_RESET_PASSWORD=true', async () => {
    const r = await ensureEnvAdmin(cfg({ ADMIN_EMAIL: 'admin@env.local', ADMIN_PASSWORD: 'Outra-Senha-22', ADMIN_RESET_PASSWORD: 'true' }), env.db, log);
    expect(r).toBe('reset');
    await new Client(env.baseUrl).login('admin@env.local', 'Outra-Senha-22');
  });

  it('recusa senha fraca e ignora quando não configurado', async () => {
    expect(await ensureEnvAdmin(cfg({ ADMIN_EMAIL: 'fraco@env.local', ADMIN_PASSWORD: '123' }), env.db, log)).toBe('invalid');
    expect(await env.db.user.count({ where: { email: 'fraco@env.local' } })).toBe(0);
    expect(await ensureEnvAdmin(cfg({ ADMIN_EMAIL: '', ADMIN_PASSWORD: '' }), env.db, log)).toBe('skipped');
  });
});
