import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { parse } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { findConflicts, isScheduleActive, schedulesOverlap, type ScheduleRule } from '../../shared/schedule-logic.js';
import { AuditActions } from '../services/audit.js';

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

export async function scheduleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, audit, devices } = ctx;

  const toRule = (s: { id: string; name: string; deviceId: string; playlistId: string; startDate: string | null; endDate: string | null; daysOfWeek: number[]; startTime: string; endTime: string; priority: number; enabled: boolean; createdAt: Date }): ScheduleRule => s;

  app.get('/api/schedules', { preHandler: auth.requireUser }, async () => {
    const list = await db.schedule.findMany({
      orderBy: [{ deviceId: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
      include: { playlist: { select: { id: true, name: true, versions: { orderBy: { number: 'desc' }, take: 1, select: { number: true } } } }, device: { select: { id: true, name: true } }, createdBy: { select: { name: true } } },
    });
    const now = new Date();
    return {
      timezone: ctx.config.timezone,
      schedules: list.map((s) => ({
        id: s.id,
        name: s.name,
        device: s.device,
        playlist: { id: s.playlist.id, name: s.playlist.name, published: s.playlist.versions.length > 0 },
        startDate: s.startDate,
        endDate: s.endDate,
        daysOfWeek: s.daysOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        priority: s.priority,
        enabled: s.enabled,
        activeNow: isScheduleActive(toRule(s), now, ctx.config.timezone),
        createdBy: s.createdBy?.name ?? null,
        createdAt: s.createdAt,
      })),
      conflicts: findConflicts(list.map(toRule)),
    };
  });

  const validate = async (data: z.infer<typeof scheduleSchema>, excludeId?: string) => {
    const [device, playlist] = await Promise.all([
      db.displayDevice.findUnique({ where: { id: data.deviceId } }),
      db.playlist.findUnique({ where: { id: data.playlistId }, include: { versions: { take: 1, select: { id: true } } } }),
    ]);
    if (!device) throw notFound('Telão não encontrado.');
    if (!playlist) throw notFound('Playlist não encontrada.');
    if (!playlist.versions.length) throw badRequest('Publique a playlist ao menos uma vez antes de agendá-la (o agendamento usa sempre a última versão publicada).');
    const others = await db.schedule.findMany({ where: { deviceId: data.deviceId, enabled: true, ...(excludeId ? { id: { not: excludeId } } : {}) } });
    const candidate: ScheduleRule = { ...data, id: excludeId ?? 'new', createdAt: new Date(), daysOfWeek: [...new Set(data.daysOfWeek)].sort() };
    const overlaps = others.filter((o) => schedulesOverlap(candidate, toRule(o)));
    const blocking = overlaps.filter((o) => o.priority === data.priority);
    if (blocking.length && data.enabled)
      throw conflict('SCHEDULE_CONFLICT', `Conflito de horário com "${blocking.map((b) => b.name).join('", "')}" na mesma prioridade. Ajuste os horários ou defina prioridades diferentes.`, {
        conflicts: blocking.map((b) => ({ id: b.id, name: b.name })),
      });
    return overlaps.map((o) => ({ id: o.id, name: o.name, priority: o.priority }));
  };

  app.post('/api/schedules', { preHandler: auth.requirePublisher }, async (req) => {
    const data = parse(scheduleSchema, req.body);
    const overlaps = await validate(data);
    const s = await db.schedule.create({ data: { ...data, daysOfWeek: [...new Set(data.daysOfWeek)].sort(), createdById: req.user!.id } });
    await audit.record({ action: AuditActions.ScheduleCreated, userId: req.user!.id, deviceId: s.deviceId, entityType: 'schedule', entityId: s.id, summary: `Criou o agendamento "${s.name}"`, details: data, ip: req.ip });
    await devices.recompute(s.deviceId);
    return { schedule: { id: s.id }, overlaps };
  });

  app.put<{ Params: { id: string } }>('/api/schedules/:id', { preHandler: auth.requirePublisher }, async (req) => {
    const existing = await db.schedule.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Agendamento não encontrado.');
    const data = parse(scheduleSchema, req.body);
    const overlaps = await validate(data, existing.id);
    const s = await db.schedule.update({ where: { id: existing.id }, data: { ...data, daysOfWeek: [...new Set(data.daysOfWeek)].sort() } });
    await audit.record({ action: AuditActions.ScheduleUpdated, userId: req.user!.id, deviceId: s.deviceId, entityType: 'schedule', entityId: s.id, summary: `Editou o agendamento "${s.name}"`, details: data, ip: req.ip });
    await devices.recompute(s.deviceId);
    if (existing.deviceId !== s.deviceId) await devices.recompute(existing.deviceId);
    return { schedule: { id: s.id }, overlaps };
  });

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', { preHandler: auth.requirePublisher }, async (req) => {
    const s = await db.schedule.findUnique({ where: { id: req.params.id } });
    if (!s) throw notFound('Agendamento não encontrado.');
    await db.schedule.delete({ where: { id: s.id } });
    await audit.record({ action: AuditActions.ScheduleDeleted, userId: req.user!.id, deviceId: s.deviceId, entityType: 'schedule', entityId: s.id, summary: `Cancelou o agendamento "${s.name}"`, ip: req.ip });
    await devices.recompute(s.deviceId);
    return { ok: true };
  });
}
