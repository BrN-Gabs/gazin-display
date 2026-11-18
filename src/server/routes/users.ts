import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { parse } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { hashPassword, passwordProblems } from '../lib/security.js';
import { AuditActions } from '../services/audit.js';

const userDto = (u: { id: string; name: string; email: string; username: string | null; role: string; canPublish: boolean; active: boolean; createdAt: Date; lastLoginAt: Date | null }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  username: u.username,
  role: u.role,
  canPublish: u.role === 'ADMIN' || u.canPublish,
  active: u.active,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});

export async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, audit } = ctx;

  // lista simples (para filtros) — disponível a qualquer usuário autenticado
  app.get('/api/users/options', { preHandler: auth.requireUser }, async () => ({
    users: await db.user.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  }));

  app.get('/api/users', { preHandler: auth.requireAdmin }, async () => ({
    users: (await db.user.findMany({ orderBy: { createdAt: 'asc' } })).map(userDto),
  }));

  app.post('/api/users', { preHandler: auth.requireAdmin }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().toLowerCase().email().max(200),
        username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'use letras, números, ponto, hífen ou _').optional().or(z.literal('').transform(() => undefined)),
        role: z.enum(['ADMIN', 'EDITOR']),
        canPublish: z.boolean().default(true),
        password: z.string().min(1).max(200),
      }),
      req.body,
    );
    const problem = passwordProblems(body.password);
    if (problem) throw badRequest(problem);
    const exists = await db.user.findFirst({ where: { OR: [{ email: body.email }, ...(body.username ? [{ username: body.username }] : [])] } });
    if (exists) throw conflict('USER_EXISTS', 'Já existe um usuário com este e-mail ou nome de usuário.');
    const user = await db.user.create({
      data: { name: body.name, email: body.email, username: body.username ?? null, role: body.role, canPublish: body.canPublish, passwordHash: await hashPassword(body.password) },
    });
    await audit.record({ action: AuditActions.UserCreated, userId: req.user!.id, entityType: 'user', entityId: user.id, summary: `Criou o usuário ${user.name} (${user.role})`, ip: req.ip });
    return { user: userDto(user) };
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', { preHandler: auth.requireAdmin }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        role: z.enum(['ADMIN', 'EDITOR']).optional(),
        canPublish: z.boolean().optional(),
        active: z.boolean().optional(),
        password: z.string().min(1).max(200).optional(),
      }),
      req.body,
    );
    const user = await db.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw notFound('Usuário não encontrado.');
    const demoting = (body.role && body.role !== 'ADMIN') || body.active === false;
    if (user.role === 'ADMIN' && demoting) {
      const admins = await db.user.count({ where: { role: 'ADMIN', active: true } });
      if (admins <= 1) throw conflict('LAST_ADMIN', 'Não é possível remover o último administrador ativo.');
    }
    if (body.password) {
      const problem = passwordProblems(body.password);
      if (problem) throw badRequest(problem);
    }
    const updated = await db.user.update({
      where: { id: user.id },
      data: {
        name: body.name,
        role: body.role,
        canPublish: body.canPublish,
        active: body.active,
        ...(body.password ? { passwordHash: await hashPassword(body.password), passwordChangedAt: new Date() } : {}),
      },
    });
    if (body.active === false || body.password) {
      await db.session.deleteMany({ where: { userId: user.id } });
      ctx.realtime.disconnectUserSessions(user.id);
    }
    await audit.record({
      action: AuditActions.UserUpdated,
      userId: req.user!.id,
      entityType: 'user',
      entityId: user.id,
      summary: `Atualizou o usuário ${updated.name}`,
      details: { changed: Object.keys(body).filter((k) => k !== 'password'), passwordReset: !!body.password },
      ip: req.ip,
    });
    return { user: userDto(updated) };
  });
}
