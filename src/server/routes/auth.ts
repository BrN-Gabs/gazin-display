import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { SESSION_COOKIE } from '../auth.js';
import { parse } from '../lib/http.js';
import { badRequest, AppError } from '../lib/errors.js';
import { getDummyHash, hashPassword, passwordProblems, verifyPassword } from '../lib/security.js';
import { AuditActions } from '../services/audit.js';

const loginSchema = z.object({
  login: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, audit } = ctx;

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const body = parse(loginSchema, req.body);
      const login = body.login.toLowerCase();
      const user = await db.user.findFirst({ where: { OR: [{ email: login }, { username: login }] } });
      const ok = user ? await verifyPassword(user.passwordHash, body.password) : (await verifyPassword(await getDummyHash(), body.password), false);
      if (!user || !ok || !user.active) {
        await audit.record({
          action: AuditActions.LoginFailed,
          userId: user?.id,
          summary: `Tentativa de login sem sucesso (${login.slice(0, 80)})`,
          ip: req.ip,
        });
        throw new AppError(401, 'INVALID_CREDENTIALS', user && ok && !user.active ? 'Usuário desativado. Procure um administrador.' : 'E-mail/usuário ou senha incorretos.');
      }
      const token = await auth.createSession(user.id, req.ip, req.headers['user-agent']);
      await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await audit.record({ action: AuditActions.LoginSuccess, userId: user.id, summary: `${user.name} entrou no sistema`, ip: req.ip });
      reply.setCookie(SESSION_COOKIE, token, auth.sessionCookieOptions());
      return { user: { id: user.id, name: user.name, email: user.email, username: user.username, role: user.role, canPublish: user.role === 'ADMIN' || user.canPublish } };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = await auth.userFromToken(token);
    await auth.destroySession(token);
    if (user) await audit.record({ action: AuditActions.Logout, userId: user.id, summary: `${user.name} saiu do sistema`, ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: auth.requireUser }, async (req) => ({ user: req.user }));

  app.post('/api/auth/password', { preHandler: auth.requireUser, config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) }), req.body);
    const user = await db.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) throw badRequest('Senha atual incorreta.');
    const problem = passwordProblems(body.newPassword);
    if (problem) throw badRequest(problem);
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date() } });
    // encerra todas as outras sessões
    await db.session.deleteMany({ where: { userId: user.id, id: { not: req.user!.sessionId } } });
    ctx.realtime.disconnectUserSessions(user.id, req.user!.sessionId);
    await audit.record({ action: AuditActions.PasswordChanged, userId: user.id, summary: `${user.name} alterou a própria senha`, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/auth/sessions', { preHandler: auth.requireUser }, async (req) => {
    const sessions = await db.session.findMany({ where: { userId: req.user!.id, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    return {
      sessions: sessions.map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: s.id === req.user!.sessionId })),
    };
  });

  app.delete('/api/auth/sessions', { preHandler: auth.requireUser }, async (req) => {
    const { count } = await db.session.deleteMany({ where: { userId: req.user!.id, id: { not: req.user!.sessionId } } });
    ctx.realtime.disconnectUserSessions(req.user!.id, req.user!.sessionId);
    await audit.record({ action: AuditActions.SessionsRevoked, userId: req.user!.id, summary: `${req.user!.name} encerrou ${count} outra(s) sessão(ões)`, ip: req.ip });
    return { revoked: count };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', { preHandler: auth.requireUser }, async (req) => {
    const { count } = await db.session.deleteMany({ where: { id: req.params.id, userId: req.user!.id } });
    return { revoked: count };
  });
}
