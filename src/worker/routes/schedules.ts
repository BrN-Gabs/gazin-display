import type { Hono } from 'hono';
import { z } from 'zod';
import { clientIp, requirePublisher, requireUser, type HonoEnv } from '../auth';
import type { AppContext } from '../context';
import { mapSchedule, now, uuid, type ScheduleRow } from '../db';
import { parse } from '../lib/http';
import { badRequest, conflict, notFound } from '../lib/errors';
import { findConflicts, isScheduleActive, schedulesOverlap, type ScheduleRule } from '../../shared/schedule-logic';
import { AuditActions } from '../services/audit';
import { readBody } from './util';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:mm');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');

const scheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    deviceId: z.string().uuid(),
    playlistId: z.string().uuid(),
    startDate: date.nullable().default(null),
    endDate: date.nullable().default(null),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1, 'selecione ao menos um dia').max(7),
    startTime: time,
    endTime: time,
    priority: z.number().int().min(1).max(100).default(10),
    enabled: z.boolean().default(true),
  })
  .refine((s) => !s.startDate || !s.endDate || s.startDate <= s.endDate, { message: 'a data final deve ser posterior à inicial', path: ['endDate'] });

type ScheduleInput = z.infer<typeof scheduleSchema>;
const toRule = (s: ScheduleRow): ScheduleRule => s;

export function scheduleRoutes(app: Hono<HonoEnv>) {
  app.get('/api/schedules', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const rows = await ctx.db.all<Record<string, unknown>>(
      `SELECT s.*, p."name" AS "playlistName", d."name" AS "deviceName", u."name" AS "createdByName",
              EXISTS (SELECT 1 FROM "PlaylistVersion" v WHERE v."playlistId" = s."playlistId") AS "published"
       FROM "Schedule" s JOIN "Playlist" p ON p."id" = s."playlistId" JOIN "DisplayDevice" d ON d."id" = s."deviceId" LEFT JOIN "User" u ON u."id" = s."createdById"
       ORDER BY s."deviceId" ASC, s."priority" DESC, s."createdAt" DESC`,
    );
    const list = rows.map((r) => ({ row: r, s: mapSchedule(r) }));
    const at = new Date();
    return c.json({
      timezone: ctx.config.timezone,
      schedules: list.map(({ row, s }) => ({
        id: s.id,
        name: s.name,
        device: { id: s.deviceId, name: row.deviceName },
        playlist: { id: s.playlistId, name: row.playlistName, published: !!row.published },
        startDate: s.startDate,
        endDate: s.endDate,
        daysOfWeek: s.daysOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        priority: s.priority,
        enabled: s.enabled,
        activeNow: isScheduleActive(toRule(s), at, ctx.config.timezone),
        createdBy: (row.createdByName as string) ?? null,
        createdAt: s.createdAt,
      })),
      conflicts: findConflicts(list.map(({ s }) => toRule(s))),
    });
  });

  const validate = async (ctx: AppContext, data: ScheduleInput, excludeId?: string) => {
    const [device, playlist, published] = await Promise.all([
      ctx.db.first('SELECT "id" FROM "DisplayDevice" WHERE "id" = ?', data.deviceId),
      ctx.db.first('SELECT "id" FROM "Playlist" WHERE "id" = ?', data.playlistId),
      ctx.db.first('SELECT "id" FROM "PlaylistVersion" WHERE "playlistId" = ? LIMIT 1', data.playlistId),
    ]);
    if (!device) throw notFound('Telão não encontrado.');
    if (!playlist) throw notFound('Playlist não encontrada.');
    if (!published) throw badRequest('Publique a playlist ao menos uma vez antes de agendá-la (o agendamento usa sempre a última versão publicada).');
    const others = (await ctx.db.all('SELECT * FROM "Schedule" WHERE "deviceId" = ? AND "enabled" = 1 AND "id" <> ?', data.deviceId, excludeId ?? '')).map(mapSchedule);
    const candidate: ScheduleRule = { ...data, id: excludeId ?? 'new', createdAt: new Date(), daysOfWeek: [...new Set(data.daysOfWeek)].sort() };
    const overlaps = others.filter((o) => schedulesOverlap(candidate, toRule(o)));
    const blocking = overlaps.filter((o) => o.priority === data.priority);
    if (blocking.length && data.enabled)
      throw conflict('SCHEDULE_CONFLICT', `Conflito de horário com "${blocking.map((b) => b.name).join('", "')}" na mesma prioridade. Ajuste os horários ou defina prioridades diferentes.`, {
        conflicts: blocking.map((b) => ({ id: b.id, name: b.name })),
      });
    return overlaps.map((o) => ({ id: o.id, name: o.name, priority: o.priority }));
  };

  app.post('/api/schedules', requirePublisher, async (c) => {
    const ctx = c.var.ctx;
    const data = parse(scheduleSchema, await readBody(c));
    const overlaps = await validate(ctx, data);
    const id = uuid();
    const ts = now();
    await ctx.db.run(
      `INSERT INTO "Schedule" ("id", "name", "deviceId", "playlistId", "startDate", "endDate", "daysOfWeek", "startTime", "endTime", "priority", "enabled", "createdById", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      data.name,
      data.deviceId,
      data.playlistId,
      data.startDate,
      data.endDate,
      JSON.stringify([...new Set(data.daysOfWeek)].sort()),
      data.startTime,
      data.endTime,
      data.priority,
      data.enabled,
      c.var.user.id,
      ts,
      ts,
    );
    await ctx.audit.record({ action: AuditActions.ScheduleCreated, userId: c.var.user.id, deviceId: data.deviceId, entityType: 'schedule', entityId: id, summary: `Criou o agendamento "${data.name}"`, details: data, ip: clientIp(c) });
    await ctx.devices.recompute(data.deviceId);
    return c.json({ schedule: { id }, overlaps });
  });

  app.put('/api/schedules/:id', requirePublisher, async (c) => {
    const ctx = c.var.ctx;
    const r = await ctx.db.first('SELECT * FROM "Schedule" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Agendamento não encontrado.');
    const existing = mapSchedule(r);
    const data = parse(scheduleSchema, await readBody(c));
    const overlaps = await validate(ctx, data, existing.id);
    await ctx.db.run(
      `UPDATE "Schedule" SET "name" = ?, "deviceId" = ?, "playlistId" = ?, "startDate" = ?, "endDate" = ?, "daysOfWeek" = ?, "startTime" = ?, "endTime" = ?, "priority" = ?, "enabled" = ?, "updatedAt" = ? WHERE "id" = ?`,
      data.name,
      data.deviceId,
      data.playlistId,
      data.startDate,
      data.endDate,
      JSON.stringify([...new Set(data.daysOfWeek)].sort()),
      data.startTime,
      data.endTime,
      data.priority,
      data.enabled,
      now(),
      existing.id,
    );
    await ctx.audit.record({ action: AuditActions.ScheduleUpdated, userId: c.var.user.id, deviceId: data.deviceId, entityType: 'schedule', entityId: existing.id, summary: `Editou o agendamento "${data.name}"`, details: data, ip: clientIp(c) });
    await ctx.devices.recompute(data.deviceId);
    if (existing.deviceId !== data.deviceId) await ctx.devices.recompute(existing.deviceId);
    return c.json({ schedule: { id: existing.id }, overlaps });
  });

  app.delete('/api/schedules/:id', requirePublisher, async (c) => {
    const ctx = c.var.ctx;
    const r = await ctx.db.first('SELECT * FROM "Schedule" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Agendamento não encontrado.');
    const s = mapSchedule(r);
    await ctx.db.run('DELETE FROM "Schedule" WHERE "id" = ?', s.id);
    await ctx.audit.record({ action: AuditActions.ScheduleDeleted, userId: c.var.user.id, deviceId: s.deviceId, entityType: 'schedule', entityId: s.id, summary: `Cancelou o agendamento "${s.name}"`, ip: clientIp(c) });
    await ctx.devices.recompute(s.deviceId);
    return c.json({ ok: true });
  });
}
