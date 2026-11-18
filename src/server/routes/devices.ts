import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { Prisma, type DisplayDevice } from '../db.js';
import { parse } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizePairingCode } from '../lib/security.js';
import { parseOverrides } from '../services/devices.js';
import { AuditActions } from '../services/audit.js';
import { COMMAND_TYPES, SocketEvents, type DeviceCommandMessage } from '../../shared/types.js';

export function newIdentifier() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return `GD-${Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('')}`;
}

export async function deviceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, audit, realtime, devices } = ctx;

  const versionInfo = async (ids: Array<string | null>) => {
    const list = await db.playlistVersion.findMany({
      where: { id: { in: ids.filter((x): x is string => !!x) } },
      select: { id: true, number: true, itemCount: true, publishedAt: true, playlist: { select: { id: true, name: true } } },
    });
    return new Map(list.map((v) => [v.id, { id: v.id, number: v.number, itemCount: v.itemCount, publishedAt: v.publishedAt, playlistId: v.playlist.id, playlistName: v.playlist.name }]));
  };

  const deviceDto = async (d: DisplayDevice & { playlist?: { id: string; name: string } | null; credentials?: Array<{ id: string; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date }> }) => {
    const versions = await versionInfo([d.publishedVersionId, d.effectiveVersionId, d.reportedVersionId]);
    const live = realtime.liveState(d.id);
    const activeCreds = (d.credentials ?? []).filter((c) => !c.revokedAt && c.expiresAt > new Date());
    return {
      id: d.id,
      name: d.name,
      identifier: d.identifier,
      location: d.location,
      createdAt: d.createdAt,
      connection: await devices.connectionOf(d),
      lastSeenAt: d.lastSeenAt,
      connectedAt: d.connectedAt,
      disconnectedAt: d.disconnectedAt,
      applyMode: d.applyMode,
      overrides: parseOverrides(d.settings),
      playlist: d.playlist ?? null,
      publishedVersion: d.publishedVersionId ? (versions.get(d.publishedVersionId) ?? null) : null,
      effectiveVersion: d.effectiveVersionId ? (versions.get(d.effectiveVersionId) ?? null) : null,
      effectiveSource: d.effectiveSource,
      reportedVersion: d.reportedVersionId ? (versions.get(d.reportedVersionId) ?? null) : null,
      inSync: d.effectiveVersionId === d.reportedVersionId,
      state: live?.state ?? d.lastState ?? null,
      stateAt: live?.at ?? d.lastSeenAt,
      lastError: d.lastError,
      authorized: activeCreds.length > 0,
      credentials: (d.credentials ?? []).map((c) => ({ id: c.id, createdAt: c.createdAt, expiresAt: c.expiresAt, revokedAt: c.revokedAt, lastUsedAt: c.lastUsedAt })),
    };
  };

  const loadDevice = async (id: string) => {
    const d = await db.displayDevice.findUnique({
      where: { id },
      include: { playlist: { select: { id: true, name: true } }, credentials: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    if (!d) throw notFound('Telão não encontrado.');
    return d;
  };

  app.get('/api/devices', { preHandler: auth.requireUser }, async () => {
    const list = await db.displayDevice.findMany({
      orderBy: { createdAt: 'asc' },
      include: { playlist: { select: { id: true, name: true } }, credentials: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    return { devices: await Promise.all(list.map(deviceDto)) };
  });

  app.get<{ Params: { id: string } }>('/api/devices/:id', { preHandler: auth.requireUser }, async (req) => {
    const d = await loadDevice(req.params.id);
    const commands = await db.deviceCommand.findMany({ where: { deviceId: d.id }, orderBy: { createdAt: 'desc' }, take: 15, include: { createdBy: { select: { name: true } } } });
    return {
      device: await deviceDto(d),
      commands: commands.map((c) => ({ id: c.id, type: c.type, payload: c.payload, status: c.status, error: c.error, createdAt: c.createdAt, respondedAt: c.respondedAt, createdBy: c.createdBy?.name ?? null })),
    };
  });

  /** Programação que o telão deve reproduzir agora (para prévia no painel) */
  app.get<{ Params: { id: string } }>('/api/devices/:id/manifest', { preHandler: auth.requireUser }, async (req) => ({ manifest: await devices.manifest(req.params.id) }));

  app.post('/api/devices', { preHandler: auth.requireAdmin }, async (req) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), location: z.string().trim().max(120).optional() }), req.body);
    const d = await db.displayDevice.create({ data: { name: body.name, location: body.location || null, identifier: newIdentifier() } });
    await audit.record({ action: AuditActions.DeviceCreated, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Cadastrou o telão "${d.name}"`, ip: req.ip });
    return { device: await deviceDto(d) };
  });

  app.patch<{ Params: { id: string } }>('/api/devices/:id', { preHandler: auth.requireAdmin }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        location: z.string().trim().max(120).nullable().optional(),
        applyMode: z.enum(['next', 'immediate']).optional(),
        overrides: z.object({ fitMode: z.enum(['contain', 'cover']).optional(), audio: z.boolean().optional() }).optional(),
      }),
      req.body,
    );
    const d = await loadDevice(req.params.id);
    const updated = await db.displayDevice.update({
      where: { id: d.id },
      data: { name: body.name, location: body.location, applyMode: body.applyMode, settings: body.overrides ? (body.overrides as Prisma.InputJsonValue) : undefined },
    });
    await audit.record({ action: AuditActions.DeviceUpdated, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Atualizou o telão "${updated.name}"`, details: body, ip: req.ip });
    await devices.notify(d.id);
    return { device: await deviceDto(await loadDevice(d.id)) };
  });

  app.delete<{ Params: { id: string } }>('/api/devices/:id', { preHandler: auth.requireAdmin }, async (req) => {
    const d = await loadDevice(req.params.id);
    realtime.disconnectDevice(d.id, 'deleted');
    await db.displayDevice.delete({ where: { id: d.id } });
    await audit.record({ action: AuditActions.DeviceDeleted, userId: req.user!.id, entityType: 'device', entityId: d.id, summary: `Excluiu o telão "${d.name}"`, ip: req.ip });
    return { ok: true };
  });

  // ---------------- Vinculação ----------------

  app.get('/api/devices/pairings', { preHandler: auth.requireAdmin }, async () => {
    const pending = await db.pairingRequest.findMany({ where: { approvedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 20 });
    return { pairings: pending.map((p) => ({ id: p.id, code: p.code, createdAt: p.createdAt, expiresAt: p.expiresAt, userAgent: p.userAgent })) };
  });

  app.post('/api/devices/pair', { preHandler: auth.requireAdmin, config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req) => {
    const body = parse(
      z.object({ code: z.string().trim().min(4).max(20), deviceId: z.string().uuid().optional(), name: z.string().trim().min(2).max(80).optional(), location: z.string().trim().max(120).optional() }),
      req.body,
    );
    if (!body.deviceId && !body.name) throw badRequest('Informe o telão existente ou o nome do novo telão.');
    const code = normalizePairingCode(body.code);
    const pairing = await db.pairingRequest.findUnique({ where: { code } });
    if (!pairing || pairing.expiresAt < new Date() || pairing.consumedAt) throw new AppError(404, 'PAIRING_NOT_FOUND', 'Código inválido ou expirado. Confira o código exibido no telão.');
    if (pairing.approvedAt) throw conflict('PAIRING_USED', 'Este código já foi utilizado.');
    let device: DisplayDevice;
    if (body.deviceId) {
      device = await loadDevice(body.deviceId);
      // o novo computador substitui o anterior: revoga credenciais antigas
      await db.deviceCredential.updateMany({ where: { deviceId: device.id, revokedAt: null }, data: { revokedAt: new Date() } });
      realtime.disconnectDevice(device.id, 'replaced');
    } else {
      device = await db.displayDevice.create({ data: { name: body.name!, location: body.location || null, identifier: newIdentifier() } });
      await audit.record({ action: AuditActions.DeviceCreated, userId: req.user!.id, deviceId: device.id, entityType: 'device', entityId: device.id, summary: `Cadastrou o telão "${device.name}"`, ip: req.ip });
    }
    await db.pairingRequest.update({ where: { id: pairing.id }, data: { approvedAt: new Date(), approvedById: req.user!.id, approvedDeviceId: device.id } });
    await audit.record({ action: AuditActions.DevicePaired, userId: req.user!.id, deviceId: device.id, entityType: 'device', entityId: device.id, summary: `Vinculou um computador ao telão "${device.name}" (código ${code})`, ip: req.ip });
    return { device: await deviceDto(await loadDevice(device.id)) };
  });

  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', { preHandler: auth.requireAdmin }, async (req) => {
    const d = await loadDevice(req.params.id);
    const { count } = await db.deviceCredential.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: new Date() } });
    realtime.disconnectDevice(d.id, 'revoked');
    await audit.record({ action: AuditActions.DeviceRevoked, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Revogou o acesso do telão "${d.name}"`, details: { credentials: count }, ip: req.ip });
    return { revoked: count };
  });

  app.post<{ Params: { id: string } }>('/api/devices/:id/renew', { preHandler: auth.requireAdmin }, async (req) => {
    const d = await loadDevice(req.params.id);
    const expiresAt = new Date(Date.now() + ctx.config.DEVICE_TOKEN_TTL_DAYS * 86400_000);
    const { count } = await db.deviceCredential.updateMany({ where: { deviceId: d.id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { expiresAt } });
    if (!count) throw conflict('NO_CREDENTIAL', 'Este telão não possui credencial ativa. Vincule-o novamente com um código.');
    await audit.record({ action: AuditActions.DeviceRenewed, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Renovou a autorização do telão "${d.name}" até ${expiresAt.toLocaleDateString('pt-BR')}`, ip: req.ip });
    return { expiresAt };
  });

  app.post<{ Params: { id: string } }>('/api/devices/:id/unassign', { preHandler: auth.requirePublisher }, async (req) => {
    const d = await loadDevice(req.params.id);
    await db.displayDevice.update({ where: { id: d.id }, data: { playlistId: null, publishedVersionId: null } });
    await devices.recompute(d.id);
    await audit.record({ action: AuditActions.DeviceUnassigned, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Desvinculou a playlist do telão "${d.name}"`, ip: req.ip });
    return { ok: true };
  });

  // ---------------- Controle remoto ----------------

  app.get<{ Params: { id: string } }>('/api/devices/:id/commands', { preHandler: auth.requireUser }, async (req) => {
    const commands = await db.deviceCommand.findMany({ where: { deviceId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 30, include: { createdBy: { select: { name: true } } } });
    return { commands: commands.map((c) => ({ id: c.id, type: c.type, payload: c.payload, status: c.status, error: c.error, createdAt: c.createdAt, respondedAt: c.respondedAt, createdBy: c.createdBy?.name ?? null })) };
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

  app.post<{ Params: { id: string } }>('/api/devices/:id/commands', { preHandler: auth.requirePublisher, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(
      z.object({
        type: z.enum(COMMAND_TYPES),
        payload: z.object({ index: z.number().int().min(0).optional(), enabled: z.boolean().optional(), fitMode: z.enum(['contain', 'cover']).optional() }).nullable().optional(),
      }),
      req.body,
    );
    const d = await loadDevice(req.params.id);
    if (body.type === 'goto' && body.payload?.index === undefined) throw badRequest('Informe o item (index).');
    if (body.type === 'set_audio' && typeof body.payload?.enabled !== 'boolean') throw badRequest('Informe enabled.');
    if (body.type === 'set_fit' && !body.payload?.fitMode) throw badRequest('Informe fitMode.');

    // ajustes persistentes: valem também após recarregar o player
    let persisted = false;
    if (body.type === 'set_audio' || body.type === 'set_fit') {
      const overrides = { ...parseOverrides(d.settings), ...(body.type === 'set_audio' ? { audio: body.payload!.enabled } : { fitMode: body.payload!.fitMode }) };
      await db.displayDevice.update({ where: { id: d.id }, data: { settings: overrides } });
      persisted = true;
    }

    const label = `${LABELS[body.type]}${body.type === 'goto' ? ` #${body.payload!.index! + 1}` : ''}${body.type === 'set_audio' ? (body.payload!.enabled ? ' ligado' : ' desligado') : ''}${body.type === 'set_fit' ? ` (${body.payload!.fitMode === 'cover' ? 'preencher' : 'mostrar completo'})` : ''}`;
    const cmd = await db.deviceCommand.create({ data: { deviceId: d.id, type: body.type, payload: body.payload ?? undefined, createdById: req.user!.id } });

    if (!realtime.isDeviceConnected(d.id)) {
      await db.deviceCommand.update({ where: { id: cmd.id }, data: { status: 'FAILED', error: 'Telão offline', respondedAt: new Date() } });
      await audit.record({ action: AuditActions.DeviceCommand, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Comando "${label}" não enviado: ${d.name} offline`, details: { commandId: cmd.id, type: body.type }, ip: req.ip });
      if (persisted) {
        reply.code(202);
        return { status: 'saved', message: 'Telão offline: o ajuste foi salvo e será aplicado quando ele reconectar.', commandId: cmd.id };
      }
      throw new AppError(409, 'DEVICE_OFFLINE', `${d.name} está offline. O comando não foi executado.`);
    }

    const msg: DeviceCommandMessage = { id: cmd.id, type: body.type, payload: body.payload ?? null };
    try {
      const ack = await realtime.sendCommand(d.id, msg);
      await db.deviceCommand.update({
        where: { id: cmd.id },
        data: { status: ack.ok ? 'ACKED' : 'FAILED', error: ack.error ?? null, respondedAt: new Date(), result: ack.state ? (JSON.parse(JSON.stringify(ack.state)) as Prisma.InputJsonValue) : undefined },
      });
      await audit.record({
        action: AuditActions.DeviceCommand,
        userId: req.user!.id,
        deviceId: d.id,
        entityType: 'device',
        entityId: d.id,
        summary: `Comando "${label}" ${ack.ok ? 'executado' : 'recusado'} em ${d.name}${ack.error ? `: ${ack.error}` : ''}`,
        details: { commandId: cmd.id, type: body.type, payload: body.payload },
        ip: req.ip,
      });
      realtime.toAdmins(SocketEvents.CommandResult, { deviceId: d.id, commandId: cmd.id, ok: ack.ok });
      if (!ack.ok) throw new AppError(422, 'COMMAND_REJECTED', ack.error ?? 'O telão não pôde executar o comando.');
      return { status: 'acked', commandId: cmd.id, state: ack.state ?? null };
    } catch (err) {
      if (err instanceof AppError && (err.code === 'DEVICE_TIMEOUT' || err.code === 'DEVICE_OFFLINE')) {
        await db.deviceCommand.update({ where: { id: cmd.id }, data: { status: err.code === 'DEVICE_TIMEOUT' ? 'TIMEOUT' : 'FAILED', error: err.message, respondedAt: new Date() } });
        await audit.record({ action: AuditActions.DeviceCommand, userId: req.user!.id, deviceId: d.id, entityType: 'device', entityId: d.id, summary: `Comando "${label}" sem confirmação de ${d.name}`, details: { commandId: cmd.id }, ip: req.ip });
      }
      throw err;
    }
  });
}
