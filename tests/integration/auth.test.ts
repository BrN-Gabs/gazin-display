import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, EDITOR, seedUsers, startTestApp, type TestEnv } from '../helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await startTestApp();
  await seedUsers(env.db);
});
afterAll(() => env.close());

describe('autenticação', () => {
  it('login válido cria sessão HttpOnly e /me retorna o usuário', async () => {
    const c = new Client(env.baseUrl);
    const r = await c.login(ADMIN.email, ADMIN.password);
    const setCookie = r.headers.getSetCookie().join(';');
    expect(setCookie).toMatch(/gd_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(r.body.user).toMatchObject({ email: ADMIN.email, role: 'ADMIN' });
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|argon/);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ADMIN.email);
  });

  it('login inválido retorna 401 com mensagem clara e registra auditoria', async () => {
    const c = new Client(env.baseUrl);
    const r = await c.post('/api/auth/login', { login: ADMIN.email, password: 'errada-123' });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/incorretos/);
    const r2 = await c.post('/api/auth/login', { login: 'naoexiste@x.com', password: 'qualquer' });
    expect(r2.status).toBe(401);
    expect(await env.db.auditLog.count({ where: { action: 'auth.login_failed' } })).toBeGreaterThanOrEqual(2);
    const log = await env.db.auditLog.findFirst({ where: { action: 'auth.login_failed' } });
    expect(JSON.stringify(log)).not.toMatch(/errada-123/);
  });

  it('logout invalida a sessão no servidor', async () => {
    const c = new Client(env.baseUrl);
    await c.login(ADMIN.email, ADMIN.password);
    const token = c.cookies.get('gd_session')!;
    await c.post('/api/auth/logout');
    const stale = new Client(env.baseUrl);
    stale.cookies.set('gd_session', token);
    expect((await stale.get('/api/auth/me')).status).toBe(401);
  });

  it('rotas protegidas exigem autenticação', async () => {
    const anon = new Client(env.baseUrl);
    for (const url of ['/api/media', '/api/playlists', '/api/devices', '/api/dashboard', '/api/audit', '/api/settings', '/api/users']) {
      expect((await anon.get(url)).status, url).toBe(401);
    }
    expect((await anon.post('/api/playlists', { name: 'x' })).status).toBe(401);
  });

  it('bloqueia requisições sem cabeçalho CSRF ou com origem externa', async () => {
    const c = new Client(env.baseUrl);
    await c.login(ADMIN.email, ADMIN.password);
    const noCsrf = await fetch(`${env.baseUrl}/api/playlists`, { method: 'POST', headers: { cookie: c.cookieHeader, 'content-type': 'application/json' }, body: '{"name":"x"}' });
    expect(noCsrf.status).toBe(403);
    const evil = await c.req('POST', '/api/playlists', { name: 'x' }, { origin: 'https://site-malicioso.com' });
    expect(evil.status).toBe(403);
  });

  it('editor não acessa funções exclusivas de administrador', async () => {
    const c = new Client(env.baseUrl);
    await c.login(EDITOR.email, EDITOR.password);
    expect((await c.get('/api/users')).status).toBe(403);
    expect((await c.put('/api/settings', { imageDurationSec: 10 })).status).toBe(403);
    expect((await c.post('/api/devices', { name: 'Telão X' })).status).toBe(403);
    // pode criar playlists
    expect((await c.post('/api/playlists', { name: 'Do editor' })).status).toBe(200);
  });

  it('troca de senha exige a senha atual, valida a política e encerra outras sessões', async () => {
    const a = new Client(env.baseUrl);
    const b = new Client(env.baseUrl);
    await a.login(EDITOR.email, EDITOR.password);
    await b.login(EDITOR.email, EDITOR.password);
    expect((await a.post('/api/auth/password', { currentPassword: 'errada', newPassword: 'Nova-Senha-789' })).status).toBe(400);
    expect((await a.post('/api/auth/password', { currentPassword: EDITOR.password, newPassword: 'curta' })).status).toBe(400);
    expect((await a.post('/api/auth/password', { currentPassword: EDITOR.password, newPassword: 'Nova-Senha-789' })).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
  });

  it('aplica rate limiting no login', async () => {
    const c = new Client(env.baseUrl);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await c.post('/api/auth/login', { login: 'x@y.com', password: 'z' })).status;
    expect(last).toBe(429);
  });
});
