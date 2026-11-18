import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { SESSION_COOKIE, clientIp, rateLimit, requireUser, type HonoEnv } from '../auth';
import { mapUser, now } from '../db';
import { parse } from '../lib/http';
import { badRequest, AppError } from '../lib/errors';
import { dummyHash, hashPassword, needsRehash, passwordProblems, verifyPassword } from '../lib/security';
import { AuditActions } from '../services/audit';
import { readBody } from './util';

const loginSchema = z.object({
  login: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

export function authRoutes(app: Hono<HonoEnv>) {
  app.post('/api/auth/login', rateLimit('login', 20, 300), async (c) => {
    const { db, auth, audit, config } = c.var.ctx;
    const body = parse(loginSchema, await readBody(c));
    const login = body.login.toLowerCase();
    const row = await db.first('SELECT * FROM "User" WHERE "email" = ? OR "username" = ? LIMIT 1', login, login);
    const user = row ? mapUser(row) : null;
    const ok = user ? await verifyPassword(user.passwordHash, body.password) : (await verifyPassword(dummyHash(config.passwordIterations), body.password), false);
    const ip = clientIp(c);
    if (!user || !ok || !user.active) {
      await audit.record({ action: AuditActions.LoginFailed, userId: user?.id, summary: `Tentativa de login sem sucesso (${login.slice(0, 80)})`, ip });
      throw new AppError(401, 'INVALID_CREDENTIALS', user && ok && !user.active ? 'Usuário desativado. Procure um administrador.' : 'E-mail/usuário ou senha incorretos.');
    }
    const token = await auth.createSession(user.id, ip, c.req.header('user-agent'));
    // senhas migradas da versão 1 (Argon2) passam a usar PBKDF2 após o primeiro login válido
    const rehash = needsRehash(user.passwordHash, config.passwordIterations) ? await hashPassword(body.password, config.passwordIterations) : null;
    await db.run(
      `UPDATE "User" SET "lastLoginAt" = ?${rehash ? ', "passwordHash" = ?' : ''} WHERE "id" = ?`,
      ...(rehash ? [now(), rehash, user.id] : [now(), user.id]),
    );
    await audit.record({ action: AuditActions.LoginSuccess, userId: user.id, summary: `${user.name} entrou no sistema`, ip });
    auth.setSessionCookie(c, token);
    return c.json({ user: { id: user.id, name: user.name, email: user.email, username: user.username, role: user.role, canPublish: user.role === 'ADMIN' || user.canPublish } });
  });

  app.post('/api/auth/logout', async (c) => {
    const { auth, audit } = c.var.ctx;
    const token = getCookie(c, SESSION_COOKIE);
    const user = await auth.userFromToken(token);
    await auth.destroySession(token);
    if (user) await audit.record({ action: AuditActions.Logout, userId: user.id, summary: `${user.name} saiu do sistema`, ip: clientIp(c) });
    auth.clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', requireUser, (c) => c.json({ user: c.var.user }));

  app.post('/api/auth/password', requireUser, rateLimit('password', 10, 300, 'user'), async (c) => {
    const { db, audit, realtime, config } = c.var.ctx;
    const me = c.var.user;
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) }), await readBody(c));
    const user = mapUser((await db.first('SELECT * FROM "User" WHERE "id" = ?', me.id))!);
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) throw badRequest('Senha atual incorreta.');
    const problem = passwordProblems(body.newPassword);
    if (problem) throw badRequest(problem);
    const ts = now();
    await db.batch([
      db.prep('UPDATE "User" SET "passwordHash" = ?, "passwordChangedAt" = ?, "updatedAt" = ? WHERE "id" = ?', await hashPassword(body.newPassword, config.passwordIterations), ts, ts, user.id),
      // encerra todas as outras sessões
      db.prep('DELETE FROM "Session" WHERE "userId" = ? AND "id" <> ?', user.id, me.sessionId),
    ]);
    realtime.disconnectUserSessions(user.id, me.sessionId);
    await audit.record({ action: AuditActions.PasswordChanged, userId: user.id, summary: `${user.name} alterou a própria senha`, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.get('/api/auth/sessions', requireUser, async (c) => {
    const me = c.var.user;
    const sessions = await c.var.ctx.db.all<{ id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null }>(
      'SELECT "id", "createdAt", "lastSeenAt", "ip", "userAgent" FROM "Session" WHERE "userId" = ? AND "expiresAt" > ? ORDER BY "lastSeenAt" DESC',
      me.id,
      now(),
    );
    return c.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === me.sessionId })) });
  });

  app.delete('/api/auth/sessions', requireUser, async (c) => {
    const { db, audit, realtime } = c.var.ctx;
    const me = c.var.user;
    const res = await db.run('DELETE FROM "Session" WHERE "userId" = ? AND "id" <> ?', me.id, me.sessionId);
    const count = res.meta.changes ?? 0;
    realtime.disconnectUserSessions(me.id, me.sessionId);
    await audit.record({ action: AuditActions.SessionsRevoked, userId: me.id, summary: `${me.name} encerrou ${count} outra(s) sessão(ões)`, ip: clientIp(c) });
    return c.json({ revoked: count });
  });

  app.delete('/api/auth/sessions/:id', requireUser, async (c) => {
    const res = await c.var.ctx.db.run('DELETE FROM "Session" WHERE "id" = ? AND "userId" = ?', c.req.param('id'), c.var.user.id);
    return c.json({ revoked: res.meta.changes ?? 0 });
  });
}
