import { describe, expect, it } from 'vitest';
import { ADMIN, Client, EDITOR, LEGACY } from '../helpers';

describe('autenticação e controle de acesso', () => {
  it('login válido define cookie HttpOnly/SameSite e /me retorna o usuário', async () => {
    const c = new Client();
    const r = await c.post('/api/auth/login', { login: ADMIN.email, password: ADMIN.password });
    expect(r.status).toBe(200);
    const setCookie = r.headers.getSetCookie().join(';');
    expect(setCookie).toMatch(/gd_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const me = await c.get('/api/auth/me');
    expect(me.body.user.email).toBe(ADMIN.email);
    expect(me.body.user.role).toBe('ADMIN');
  });

  it('login inválido retorna 401 com mensagem genérica (inclusive para usuário inexistente)', async () => {
    const c = new Client();
    const a = await c.post('/api/auth/login', { login: ADMIN.email, password: 'errada-123456' });
    const b = await c.post('/api/auth/login', { login: 'ninguem@teste.local', password: 'errada-123456' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('rotas protegidas exigem sessão', async () => {
    const c = new Client();
    for (const url of ['/api/media', '/api/playlists', '/api/devices', '/api/dashboard', '/api/settings', '/api/audit', '/api/uploads/config']) {
      expect((await c.get(url)).status, url).toBe(401);
    }
    expect((await c.get('/api/media/00000000-0000-0000-0000-000000000000/file')).status).toBe(401);
  });

  it('proteção CSRF: sem cabeçalho X-GD-CSRF ou com origem externa a requisição é bloqueada', async () => {
    const c = new Client();
    await c.login(ADMIN.email, ADMIN.password);
    const noHeader = await fetch(`${c.baseUrl}/api/playlists`, { method: 'POST', headers: { cookie: c.cookieHeader, 'content-type': 'application/json' }, body: '{"name":"x"}' });
    expect(noHeader.status).toBe(403);
    const foreign = await c.req('POST', '/api/playlists', { name: 'x' }, { origin: 'https://site-malicioso.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('CSRF');
  });

  it('editor sem permissão de publicar não acessa rotas de administrador nem publica', async () => {
    const c = new Client();
    await c.login(EDITOR.email, EDITOR.password);
    expect((await c.get('/api/users')).status).toBe(403);
    expect((await c.put('/api/settings', { loop: false })).status).toBe(403);
    expect((await c.post('/api/devices', { name: 'Telão X' })).status).toBe(403);
    const pl = await c.post('/api/playlists', { name: 'Do editor' });
    expect(pl.status).toBe(200);
    expect((await c.post(`/api/playlists/${pl.body.playlist.id}/publish`, {})).status).toBe(403);
  });

  it('logout invalida a sessão no servidor', async () => {
    const c = new Client();
    await c.login(ADMIN.email, ADMIN.password);
    const token = c.cookies.get('gd_session')!;
    await c.post('/api/auth/logout');
    const reuse = await fetch(`${c.baseUrl}/api/auth/me`, { headers: { cookie: `gd_session=${token}` } });
    expect(reuse.status).toBe(401);
  });

  it('senha migrada da versão 1 (Argon2id) é aceita e convertida para PBKDF2', async () => {
    const c = new Client();
    const r = await c.post('/api/auth/login', { login: LEGACY.email, password: LEGACY.password });
    expect(r.status).toBe(200);
    const again = new Client();
    expect((await again.post('/api/auth/login', { login: LEGACY.email, password: LEGACY.password })).status).toBe(200);
    expect((await again.post('/api/auth/login', { login: LEGACY.email, password: 'outra-Senha-1' })).status).toBe(401);
  });

  it('limita tentativas excessivas de login (429)', async () => {
    const c = new Client();
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await c.post('/api/auth/login', { login: 'x@y.z', password: 'nada-nada-1' })).status;
    expect(last).toBe(429);
    // outro IP continua podendo entrar
    const other = new Client();
    expect((await other.post('/api/auth/login', { login: ADMIN.email, password: ADMIN.password })).status).toBe(200);
  });

  it('troca de senha encerra as outras sessões', async () => {
    const a = new Client();
    const b = new Client();
    await a.login(EDITOR.email, EDITOR.password);
    await b.login(EDITOR.email, EDITOR.password);
    const novo = 'Nova-Senha-2026!';
    expect((await a.post('/api/auth/password', { currentPassword: EDITOR.password, newPassword: novo })).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    // volta a senha original para os demais testes
    expect((await a.post('/api/auth/password', { currentPassword: novo, newPassword: EDITOR.password })).status).toBe(200);
  });

  it('administrador cria usuário e não pode remover o último administrador ativo', async () => {
    const c = new Client();
    await c.login(ADMIN.email, ADMIN.password);
    const weak = await c.post('/api/users', { name: 'Fraco', email: 'fraco@teste.local', role: 'EDITOR', password: '123' });
    expect(weak.status).toBe(400);
    const created = await c.post('/api/users', { name: 'Operador', email: `op${Date.now()}@teste.local`, role: 'EDITOR', canPublish: true, password: 'Operador-Forte-1' });
    expect(created.status).toBe(200);
    const users = await c.get('/api/users');
    const admin = users.body.users.find((u: any) => u.email === ADMIN.email);
    const r = await c.patch(`/api/users/${admin.id}`, { role: 'EDITOR' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('LAST_ADMIN');
  });
});
