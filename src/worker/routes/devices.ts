import type { Hono } from 'hono';
import { z } from 'zod';
import { clientIp, rateLimit, requireAdmin, requirePublisher, requireUser, type HonoEnv } from '../auth';
import type { AppContext } from '../context';
import { json, mapDevice, now, placeholders, uuid, type DeviceRow } from '../db';
import { parse } from '../lib/http';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { newIdentifier, normalizePairingCode } from '../lib/security';
import { parseOverrides } from '../services/devices';
import { AuditActions } from '../services/audit';
import { COMMAND_TYPES, SocketEvents, type DeviceCommandMessage } from '../../shared/types';
import { readBody } from './util';

interface CredRow {
  id: string;
  deviceId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** DTOs dos telões em lote: 3 consultas + 1 chamada ao tempo real, independente da quantidade */
export async function deviceDtos(ctx: AppContext, devices: DeviceRow[]) {
  if (!devices.length) return [];
  const { db } = ctx;
  const ids = devices.map((d) => d.id);
  const versionIds = [...new Set(devices.flatMap((d) => [d.publishedVersionId, d.effectiveVersionId, d.reportedVersionId]).filter((x): x is string => !!x))];
  const [versions, creds, playlists, live] = await Promise.all([
    versionIds.length
      ? db.all<{ id: string; number: number; itemCount: number; publishedAt: string; playlistId: string; playlistName: string }>(
          `SELECT v."id", v."number", v."itemCount", v."publishedAt", p."id" AS "playlistId", p."name" AS "playlistName"
           FROM "PlaylistVersion" v JOIN "Playlist" p ON p."id" = v."playlistId" WHERE v."id" IN (${placeholders(versionIds.length)})`,
          ...versionIds,
        )
      : Promise.resolve([]),
    db.all<CredRow>(
      `SELECT * FROM (SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c."deviceId" ORDER BY c."createdAt" DESC) AS "rn" FROM "DeviceCredential" c WHERE c."deviceId" IN (${placeholders(ids.length)})) WHERE "rn" <= 10`,
      ...ids,
    ),
    db.all<{ id: string; name: string }>(
      `SELECT "id", "name" FROM "Playlist" WHERE "id" IN (SELECT "playlistId" FROM "DisplayDevice" WHERE "id" IN (${placeholders(ids.length)}))`,
      ...ids,
    ),
    ctx.realtime.live(ids),
  ]);
  const vmap = new Map(versions.map((v) => [v.id, v]));
  const pmap = new Map(playlists.map((p) => [p.id, p]));
  const nowIso = now();
  return Promise.all(
    devices.map(async (d) => {
      const l = live[d.id];
      const dc = creds.filter((c) => c.deviceId === d.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return {
        id: d.id,
        name: d.name,
        identifier: d.identifier,
        location: d.location,
        createdAt: d.createdAt,
        connection: await ctx.devices.connectionOf(d, l),
        lastSeenAt: l?.at && (!d.lastSeenAt || l.at > d.lastSeenAt) ? l.at : d.lastSeenAt,
        connectedAt: d.connectedAt,
        disconnectedAt: d.disconnectedAt,
        applyMode: d.applyMode,
        overrides: parseOverrides(d.settings),
        playlist: d.playlistId ? (pmap.get(d.playlistId) ?? null) : null,
        publishedVersion: d.publishedVersionId ? (vmap.get(d.publishedVersionId) ?? null) : null,
        effectiveVersion: d.effectiveVersionId ? (vmap.get(d.effectiveVersionId) ?? null) : null,
        effectiveSource: d.effectiveSource,
        reportedVersion: d.reportedVersionId ? (vmap.get(d.reportedVersionId) ?? null) : null,
        inSync: d.effectiveVersionId === d.reportedVersionId,
        state: l?.state ?? d.lastState ?? null,
        stateAt: l?.at ?? d.lastSeenAt,
        lastError: d.lastError,
        authorized: dc.some((c) => !c.revokedAt && c.expiresAt > nowIso),
        credentials: dc.map((c) => ({ id: c.id, createdAt: c.createdAt, expiresAt: c.expiresAt, revokedAt: c.revokedAt, lastUsedAt: c.lastUsedAt })),
      };
    }),
  );
}

const commandDto = (c: Record<string, unknown>) => ({
  id: c.id,
  type: c.type,
  payload: json(c.payload, null),
  status: c.status,
  error: c.error,
  createdAt: c.createdAt,
  respondedAt: c.respondedAt,
  createdBy: c.createdByName ?? null,
});

const LABELS: Record<string, string> = {
  pause: 'Pausar',
  resume: 'Continuar',
  next: 'Próxima mídia',
  previous: 'Mídia anterior',
  restart: 'Reiniciar playlist',
  goto: 'Ir para item',
  reload: 'Recarregar player',
  set_audio: 'Áudio',
  set_fit: 'Ajuste de tela',
  sync: 'Sincronizar',
};

export function deviceRoutes(app: Hono<HonoEnv>) {
  const loadDevice = async (ctx: AppContext, id: string) => {
    const d = await ctx.devices.loadRow(id);
    if (!d) throw notFound('Telão não encontrado.');
    return d;
  };
  const one = async (ctx: AppContext, id: string) => (await deviceDtos(ctx, [await loadDevice(ctx, id)]))[0]!;
  const listCommands = (ctx: AppContext, deviceId: string, take: number) =>
    ctx.db.all(
      `SELECT c.*, u."name" AS "createdByName" FROM "DeviceCommand" c LEFT JOIN "User" u ON u."id" = c."createdById" WHERE c."deviceId" = ? ORDER BY c."createdAt" DESC LIMIT ?`,
      deviceId,
      take,
    );

  app.get('/api/devices', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const list = (await ctx.db.all('SELECT * FROM "DisplayDevice" ORDER BY "createdAt" ASC')).map(mapDevice);
    return c.json({ devices: await deviceDtos(ctx, list) });
  });

  // ---------------- Vinculação ---------------- (antes de /:id)

  app.get('/api/devices/pairings', requireAdmin, async (c) => {
    const pending = await c.var.ctx.db.all(
      'SELECT "id", "code", "createdAt", "expiresAt", "userAgent" FROM "PairingRequest" WHERE "approvedAt" IS NULL AND "expiresAt" > ? ORDER BY "createdAt" DESC LIMIT 20',
      now(),
    );
    return c.json({ pairings: pending });
  });

  app.post('/api/devices/pair', requireAdmin, rateLimit('pair', 20, 300), async (c) => {
    const ctx = c.var.ctx;
    const { db, audit, realtime } = ctx;
    const body = parse(
      z.object({ code: z.string().trim().min(4).max(20), deviceId: z.string().uuid().optional(), name: z.string().trim().min(2).max(80).optional(), location: z.string().trim().max(120).optional() }),
      await readBody(c),
    );
    if (!body.deviceId && !body.name) throw badRequest('Informe o telão existente ou o nome do novo telão.');
    const code = normalizePairingCode(body.code);
    const pairing = await db.first<{ id: string; expiresAt: string; consumedAt: string | null; approvedAt: string | null }>('SELECT * FROM "PairingRequest" WHERE "code" = ?', code);
    if (!pairing || pairing.expiresAt < now() || pairing.consumedAt) throw new AppError(404, 'PAIRING_NOT_FOUND', 'Código inválido ou expirado. Confira o código exibido no telão.');
    if (pairing.approvedAt) throw conflict('PAIRING_USED', 'Este código já foi utilizado.');
    const ip = clientIp(c);
    let device: DeviceRow;
    if (body.deviceId) {
      device = await loadDevice(ctx, body.deviceId);
      // o novo computador substitui o anterior: revoga credenciais antigas
      await db.run('UPDATE "DeviceCredential" SET "revokedAt" = ? WHERE "deviceId" = ? AND "revokedAt" IS NULL', now(), device.id);
      realtime.disconnectDevice(device.id, 'replaced');
    } else {
      const id = uuid();
      const ts = now();
      await db.run(
        'INSERT INTO "DisplayDevice" ("id", "name", "identifier", "location", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        id,
        body.name!,
        newIdentifier(),
        body.location || null,
        ts,
        ts,
      );
      device = (await ctx.devices.loadRow(id))!;
      await audit.record({ action: AuditActions.DeviceCreated, userId: c.var.user.id, deviceId: device.id, entityType: 'device', entityId: device.id, summary: `Cadastrou o telão "${device.name}"`, ip });
    }
    await db.run('UPDATE "PairingRequest" SET "approvedAt" = ?, "approvedById" = ?, "approvedDeviceId" = ? WHERE "id" = ?', now(), c.var.user.id, device.id, pairing.id);
    await audit.record({ action: AuditActions.DevicePaired, userId: c.var.user.id, deviceId: device.id, entityType: 'device', entityId: device.id, summary: `Vinculou um computador ao telão "${device.name}" (código ${code})`, ip });
    return c.json({ device: await one(ctx, device.id) });
  });

  app.get('/api/devices/:id', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const device = await one(ctx, c.req.param('id'));
    return c.json({ device, commands: (await listCommands(ctx, device.id, 15)).map(commandDto) });
  });

  /** Programação que o telão deve reproduzir agora (para prévia no painel) */
  app.get('/api/devices/:id/manifest', requireUser, async (c) => c.json({ manifest: await c.var.ctx.devices.manifest(c.req.param('id')) }));

  app.post('/api/devices', requireAdmin, async (c) => {
    const ctx = c.var.ctx;
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), location: z.string().trim().max(120).optional() }), await readBody(c));
    const id = uuid();
    const ts = now();
    await ctx.db.run('INSERT INTO "DisplayDevice" ("id", "name", "identifier", "location", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)', id, body.name, newIdentifier(), body.location || null, ts, ts);
    await ctx.audit.record({ action: AuditActions.DeviceCreated, userId: c.var.user.id, deviceId: id, entityType: 'device', entityId: id, summary: `Cadastrou o telão "${body.name}"`, ip: clientIp(c) });
    return c.json({ device: await one(ctx, id) });
  });

  app.patch('/api/devices/:id', requireAdmin, async (c) => {
    const ctx = c.var.ctx;
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        location: z.string().trim().max(120).nullable().optional(),
        applyMode: z.enum(['next', 'immediate']).optional(),
        overrides: z.object({ fitMode: z.enum(['contain', 'cover']).optional(), audio: z.boolean().optional() }).optional(),
      }),
      await readBody(c),
    );
    const d = await loadDevice(ctx, c.req.param('id'));
    await ctx.db.run(
      'UPDATE "DisplayDevice" SET "name" = ?, "location" = ?, "applyMode" = ?, "settings" = ?, "updatedAt" = ? WHERE "id" = ?',
      body.name ?? d.name,
      body.location === undefined ? d.location : body.location,
      body.applyMode ?? d.applyMode,
      JSON.stringify(body.overrides ?? d.settings ?? {}),
      now(),
      d.id,
    );
    await ctx.audit.record({ action: AuditActions.DeviceUpdated, userId: c.var.user.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Atualizou o telão "${body.name ?? d.name}"`, details: body, ip: clientIp(c) });
    await ctx.devices.notify(d.id);
    return c.json({ device: await one(ctx, d.id) });
  });

  app.delete('/api/devices/:id', requireAdmin, async (c) => {
    const ctx = c.var.ctx;
    const d = await loadDevice(ctx, c.req.param('id'));
    ctx.realtime.disconnectDevice(d.id, 'deleted');
    await ctx.db.run('DELETE FROM "DisplayDevice" WHERE "id" = ?', d.id);
    await ctx.audit.record({ action: AuditActions.DeviceDeleted, userId: c.var.user.id, entityType: 'device', entityId: d.id, summary: `Excluiu o telão "${d.name}"`, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post('/api/devices/:id/revoke', requireAdmin, async (c) => {
    const ctx = c.var.ctx;
    const d = await loadDevice(ctx, c.req.param('id'));
    const res = await ctx.db.run('UPDATE "DeviceCredential" SET "revokedAt" = ? WHERE "deviceId" = ? AND "revokedAt" IS NULL', now(), d.id);
    const count = res.meta.changes ?? 0;
    ctx.realtime.disconnectDevice(d.id, 'revoked');
    await ctx.audit.record({ action: AuditActions.DeviceRevoked, userId: c.var.user.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Revogou o acesso do telão "${d.name}"`, details: { credentials: count }, ip: clientIp(c) });
    return c.json({ revoked: count });
  });

  app.post('/api/devices/:id/renew', requireAdmin, async (c) => {
    const ctx = c.var.ctx;
    const d = await loadDevice(ctx, c.req.param('id'));
    const expiresAt = new Date(Date.now() + ctx.config.deviceTtlMs);
    const res = await ctx.db.run('UPDATE "DeviceCredential" SET "expiresAt" = ? WHERE "deviceId" = ? AND "revokedAt" IS NULL AND "expiresAt" > ?', expiresAt.toISOString(), d.id, now());
    if (!res.meta.changes) throw conflict('NO_CREDENTIAL', 'Este telão não possui credencial ativa. Vincule-o novamente com um código.');
    await ctx.audit.record({
      action: AuditActions.DeviceRenewed,
      userId: c.var.user.id,
      deviceId: d.id,
      entityType: 'device',
      entityId: d.id,
      summary: `Renovou a autorização do telão "${d.name}" até ${expiresAt.toLocaleDateString('pt-BR', { timeZone: ctx.config.timezone })}`,
      ip: clientIp(c),
    });
    return c.json({ expiresAt: expiresAt.toISOString() });
  });

  app.post('/api/devices/:id/unassign', requirePublisher, async (c) => {
    const ctx = c.var.ctx;
    const d = await loadDevice(ctx, c.req.param('id'));
    await ctx.db.run('UPDATE "DisplayDevice" SET "playlistId" = NULL, "publishedVersionId" = NULL, "updatedAt" = ? WHERE "id" = ?', now(), d.id);
    await ctx.devices.recompute(d.id);
    await ctx.audit.record({ action: AuditActions.DeviceUnassigned, userId: c.var.user.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Desvinculou a playlist do telão "${d.name}"`, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  // ---------------- Controle remoto ----------------

  app.get('/api/devices/:id/commands', requireUser, async (c) => c.json({ commands: (await listCommands(c.var.ctx, c.req.param('id'), 30)).map(commandDto) }));

  app.post('/api/devices/:id/commands', requirePublisher, rateLimit('commands', 60, 60, 'user'), async (c) => {
    const ctx = c.var.ctx;
    const { db, audit, realtime } = ctx;
    const ip = clientIp(c);
    const body = parse(
      z.object({
        type: z.enum(COMMAND_TYPES),
        payload: z.object({ index: z.number().int().min(0).optional(), enabled: z.boolean().optional(), fitMode: z.enum(['contain', 'cover']).optional() }).nullable().optional(),
      }),
      await readBody(c),
    );
    const d = await loadDevice(ctx, c.req.param('id'));
    if (body.type === 'goto' && body.payload?.index === undefined) throw badRequest('Informe o item (index).');
    if (body.type === 'set_audio' && typeof body.payload?.enabled !== 'boolean') throw badRequest('Informe enabled.');
    if (body.type === 'set_fit' && !body.payload?.fitMode) throw badRequest('Informe fitMode.');

    // ajustes persistentes: valem também após recarregar o player
    let persisted = false;
    if (body.type === 'set_audio' || body.type === 'set_fit') {
      const overrides = { ...parseOverrides(d.settings), ...(body.type === 'set_audio' ? { audio: body.payload!.enabled } : { fitMode: body.payload!.fitMode }) };
      await db.run('UPDATE "DisplayDevice" SET "settings" = ?, "updatedAt" = ? WHERE "id" = ?', JSON.stringify(overrides), now(), d.id);
      persisted = true;
    }

    const label = `${LABELS[body.type]}${body.type === 'goto' ? ` #${body.payload!.index! + 1}` : ''}${body.type === 'set_audio' ? (body.payload!.enabled ? ' ligado' : ' desligado') : ''}${body.type === 'set_fit' ? ` (${body.payload!.fitMode === 'cover' ? 'preencher' : 'mostrar completo'})` : ''}`;
    const cmdId = uuid();
    await db.run(
      'INSERT INTO "DeviceCommand" ("id", "deviceId", "type", "payload", "status", "createdById", "createdAt") VALUES (?, ?, ?, ?, \'PENDING\', ?, ?)',
      cmdId,
      d.id,
      body.type,
      body.payload ? JSON.stringify(body.payload) : null,
      c.var.user.id,
      now(),
    );
    const finish = (status: string, error: string | null, result?: unknown) =>
      db.run('UPDATE "DeviceCommand" SET "status" = ?, "error" = ?, "respondedAt" = ?, "result" = ? WHERE "id" = ?', status, error, now(), result ? JSON.stringify(result) : null, cmdId);

    const msg: DeviceCommandMessage = { id: cmdId, type: body.type, payload: body.payload ?? null };
    try {
      const ack = await realtime.sendCommand(d.id, msg);
      await finish(ack.ok ? 'ACKED' : 'FAILED', ack.error ?? null, ack.state);
      await audit.record({
        action: AuditActions.DeviceCommand,
        userId: c.var.user.id,
        deviceId: d.id,
        entityType: 'device',
        entityId: d.id,
        summary: `Comando "${label}" ${ack.ok ? 'executado' : 'recusado'} em ${d.name}${ack.error ? `: ${ack.error}` : ''}`,
        details: { commandId: cmdId, type: body.type, payload: body.payload },
        ip,
      });
      realtime.toAdmins(SocketEvents.CommandResult, { deviceId: d.id, commandId: cmdId, ok: ack.ok });
      if (!ack.ok) throw new AppError(422, 'COMMAND_REJECTED', ack.error ?? 'O telão não pôde executar o comando.');
      return c.json({ status: 'acked', commandId: cmdId, state: ack.state ?? null });
    } catch (err) {
      if (err instanceof AppError && err.code === 'DEVICE_OFFLINE') {
        await finish('FAILED', 'Telão offline');
        await audit.record({ action: AuditActions.DeviceCommand, userId: c.var.user.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Comando "${label}" não enviado: ${d.name} offline`, details: { commandId: cmdId, type: body.type }, ip });
        if (persisted) return c.json({ status: 'saved', message: 'Telão offline: o ajuste foi salvo e será aplicado quando ele reconectar.', commandId: cmdId }, 202);
        throw new AppError(409, 'DEVICE_OFFLINE', `${d.name} está offline. O comando não foi executado.`);
      }
      if (err instanceof AppError && err.code === 'DEVICE_TIMEOUT') {
        await finish('TIMEOUT', err.message);
        await audit.record({ action: AuditActions.DeviceCommand, userId: c.var.user.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Comando "${label}" sem confirmação de ${d.name}`, details: { commandId: cmdId }, ip });
      }
      throw err;
    }
  });
}
