import type { Hono } from 'hono';
import { z } from 'zod';
import { clientIp, requireAdmin, requireUser, type HonoEnv } from '../auth';
import { mapUser, now, uuid, type UserRow } from '../db';
import { parse } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { hashPassword, passwordProblems } from '../lib/security';
import { AuditActions } from '../services/audit';
import { readBody } from './util';

const userDto = (u: UserRow) => ({
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

export function userRoutes(app: Hono<HonoEnv>) {
  // lista simples (para filtros) — disponível a qualquer usuário autenticado
  app.get('/api/users/options', requireUser, async (c) =>
    c.json({ users: await c.var.ctx.db.all('SELECT "id", "name" FROM "User" ORDER BY "name" ASC') }),
  );

  app.get('/api/users', requireAdmin, async (c) => c.json({ users: (await c.var.ctx.db.all('SELECT * FROM "User" ORDER BY "createdAt" ASC')).map((r) => userDto(mapUser(r))) }));

  app.post('/api/users', requireAdmin, async (c) => {
    const { db, audit, config } = c.var.ctx;
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().toLowerCase().email().max(200),
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9._-]{3,40}$/, 'use letras, números, ponto, hífen ou _')
          .optional()
          .or(z.literal('').transform(() => undefined)),
        role: z.enum(['ADMIN', 'EDITOR']),
        canPublish: z.boolean().default(true),
        password: z.string().min(1).max(200),
      }),
      await readBody(c),
    );
    const problem = passwordProblems(body.password);
    if (problem) throw badRequest(problem);
    const exists = await db.first('SELECT "id" FROM "User" WHERE "email" = ? OR ("username" IS NOT NULL AND "username" = ?)', body.email, body.username ?? null);
    if (exists) throw conflict('USER_EXISTS', 'Já existe um usuário com este e-mail ou nome de usuário.');
    const id = uuid();
    const ts = now();
    await db.run(
      'INSERT INTO "User" ("id", "name", "email", "username", "passwordHash", "role", "canPublish", "active", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
      id,
      body.name,
      body.email,
      body.username ?? null,
      await hashPassword(body.password, config.passwordIterations),
      body.role,
      body.canPublish,
      ts,
      ts,
    );
    const user = mapUser((await db.first('SELECT * FROM "User" WHERE "id" = ?', id))!);
    await audit.record({ action: AuditActions.UserCreated, userId: c.var.user.id, entityType: 'user', entityId: user.id, summary: `Criou o usuário ${user.name} (${user.role})`, ip: clientIp(c) });
    return c.json({ user: userDto(user) });
  });

  app.patch('/api/users/:id', requireAdmin, async (c) => {
    const { db, audit, realtime, config } = c.var.ctx;
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        role: z.enum(['ADMIN', 'EDITOR']).optional(),
        canPublish: z.boolean().optional(),
        active: z.boolean().optional(),
        password: z.string().min(1).max(200).optional(),
      }),
      await readBody(c),
    );
    const row = await db.first('SELECT * FROM "User" WHERE "id" = ?', c.req.param('id'));
    if (!row) throw notFound('Usuário não encontrado.');
    const user = mapUser(row);
    const demoting = (body.role && body.role !== 'ADMIN') || body.active === false;
    if (user.role === 'ADMIN' && demoting) {
      const admins = await db.first<{ n: number }>('SELECT COUNT(*) AS "n" FROM "User" WHERE "role" = \'ADMIN\' AND "active" = 1');
      if ((admins?.n ?? 0) <= 1) throw conflict('LAST_ADMIN', 'Não é possível remover o último administrador ativo.');
    }
    if (body.password) {
      const problem = passwordProblems(body.password);
      if (problem) throw badRequest(problem);
    }
    const ts = now();
    const stmts = [
      db.prep(
        `UPDATE "User" SET "name" = COALESCE(?, "name"), "role" = COALESCE(?, "role"), "canPublish" = COALESCE(?, "canPublish"), "active" = COALESCE(?, "active"),
         "passwordHash" = COALESCE(?, "passwordHash"), "passwordChangedAt" = COALESCE(?, "passwordChangedAt"), "updatedAt" = ? WHERE "id" = ?`,
        body.name ?? null,
        body.role ?? null,
        body.canPublish ?? null,
        body.active ?? null,
        body.password ? await hashPassword(body.password, config.passwordIterations) : null,
        body.password ? ts : null,
        ts,
        user.id,
      ),
    ];
    const endSessions = body.active === false || !!body.password;
    if (endSessions) stmts.push(db.prep('DELETE FROM "Session" WHERE "userId" = ?', user.id));
    await db.batch(stmts);
    if (endSessions) realtime.disconnectUserSessions(user.id);
    const updated = mapUser((await db.first('SELECT * FROM "User" WHERE "id" = ?', user.id))!);
    await audit.record({
      action: AuditActions.UserUpdated,
      userId: c.var.user.id,
      entityType: 'user',
      entityId: user.id,
      summary: `Atualizou o usuário ${updated.name}`,
      details: { changed: Object.keys(body).filter((k) => k !== 'password'), passwordReset: !!body.password },
      ip: clientIp(c),
    });
    return c.json({ user: userDto(updated) });
  });
}
