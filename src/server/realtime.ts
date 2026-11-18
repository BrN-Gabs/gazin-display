import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { DEVICE_COOKIE, SESSION_COOKIE } from './auth.js';
import { AuditActions } from './services/audit.js';
import {
  SocketEvents,
  type CommandAck,
  type DeviceCommandMessage,
  type PlayerEventMessage,
  type PlayerStateReport,
} from '../shared/types.js';
import { AppError } from './lib/errors.js';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const stateSchema = z
  .object({
    status: z.enum(['playing', 'paused', 'error', 'idle', 'starting']),
    versionId: z.string().nullable(),
    index: z.number(),
    total: z.number(),
  })
  .passthrough();

interface DeviceLive {
  sockets: Set<Socket>;
  lastState: PlayerStateReport | null;
  lastStateAt: number;
  lastPersistAt: number;
  offlineTimer: NodeJS.Timeout | null;
}

export class Realtime {
  io: Server | null = null;
  private live = new Map<string, DeviceLive>();
  private recentErrors = new Map<string, number>();

  constructor(private ctx: AppContext) {}

  attach(server: HttpServer) {
    const io = new Server(server, { path: '/socket.io', serveClient: false, pingInterval: 10_000, pingTimeout: 8_000, maxHttpBufferSize: 1e6 });
    this.io = io;
    const allowedOrigin = this.ctx.config.publicOrigin;

    const originOk = (socket: Socket) => {
      const origin = socket.handshake.headers.origin;
      if (!origin) return true;
      const host = socket.handshake.headers.host;
      try {
        const o = new URL(origin);
        return o.host === host || (allowedOrigin !== undefined && o.origin === allowedOrigin);
      } catch {
        return false;
      }
    };

    // ---------- painel administrativo ----------
    const admin = io.of('/admin');
    admin.use(async (socket, next) => {
      if (!originOk(socket)) return next(new Error('origem não permitida'));
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const user = await this.ctx.auth.userFromToken(cookies[SESSION_COOKIE]).catch(() => null);
      if (!user) return next(new Error('não autenticado'));
      socket.data.user = user;
      next();
    });
    admin.on('connection', (socket) => {
      void socket.join('admins');
    });

    // ---------- player (dispositivo) ----------
    const player = io.of('/player');
    player.use(async (socket, next) => {
      if (!originOk(socket)) return next(new Error('origem não permitida'));
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const res = await this.ctx.auth.deviceFromCookie(cookies[DEVICE_COOKIE]).catch(() => null);
      if (!res) return next(new Error('dispositivo não autorizado'));
      socket.data.device = res.device;
      next();
    });
    player.on('connection', (socket) => void this.onPlayerConnect(socket));
  }

  private liveOf(deviceId: string) {
    let l = this.live.get(deviceId);
    if (!l) {
      l = { sockets: new Set(), lastState: null, lastStateAt: 0, lastPersistAt: 0, offlineTimer: null };
      this.live.set(deviceId, l);
    }
    return l;
  }

  private async onPlayerConnect(socket: Socket) {
    const device = socket.data.device as { id: string; name: string; credentialId: string };
    const live = this.liveOf(device.id);
    const wasConnected = live.sockets.size > 0;
    live.sockets.add(socket);
    if (live.offlineTimer) {
      clearTimeout(live.offlineTimer);
      live.offlineTimer = null;
    }
    void socket.join(`device:${device.id}`);
    const { db, log } = this.ctx;
    const before = await db.displayDevice.findUnique({ where: { id: device.id }, select: { disconnectedAt: true, connectedAt: true } });
    await db.displayDevice.update({ where: { id: device.id }, data: { connectedAt: new Date(), lastSeenAt: new Date() } }).catch(() => {});
    log.info({ deviceId: device.id }, 'player conectado');
    // registra conexão apenas se estava offline (evita poluir o histórico com reconexões rápidas)
    const offlineFor = before?.disconnectedAt ? Date.now() - before.disconnectedAt.getTime() : Infinity;
    if (!wasConnected && (offlineFor > 60_000 || !before?.connectedAt)) {
      await this.ctx.audit.record({ action: AuditActions.DeviceConnected, deviceId: device.id, entityType: 'device', entityId: device.id, summary: `${device.name} conectou-se` });
    }
    this.toAdmins(SocketEvents.DeviceStatus, { deviceId: device.id });
    // envia o estado atual da programação imediatamente (reconciliação na reconexão)
    try {
      socket.emit(SocketEvents.Sync, await this.ctx.devices.manifest(device.id));
    } catch (err) {
      log.error({ err }, 'falha ao enviar manifest');
    }

    socket.on(SocketEvents.State, (raw: unknown) => void this.onState(device.id, raw));
    socket.on(SocketEvents.PlayerEvent, (raw: unknown) => void this.onPlayerEvent(device.id, device.name, raw));
    socket.on('disconnect', () => {
      live.sockets.delete(socket);
      if (live.sockets.size > 0) return;
      void db.displayDevice.update({ where: { id: device.id }, data: { disconnectedAt: new Date() } }).catch(() => {});
      this.toAdmins(SocketEvents.DeviceStatus, { deviceId: device.id });
      void this.ctx.settings.get().then(({ offlineAfterSec }) => {
        live.offlineTimer = setTimeout(() => {
          live.offlineTimer = null;
          if (live.sockets.size > 0) return;
          void this.ctx.audit.record({
            action: AuditActions.DeviceDisconnected,
            deviceId: device.id,
            entityType: 'device',
            entityId: device.id,
            summary: `${device.name} desconectou-se`,
          });
          this.toAdmins(SocketEvents.DeviceStatus, { deviceId: device.id });
        }, offlineAfterSec * 1000);
        live.offlineTimer.unref();
      });
    });
  }

  private async onState(deviceId: string, raw: unknown) {
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) return;
    const state = parsed.data as unknown as PlayerStateReport;
    const live = this.liveOf(deviceId);
    const prev = live.lastState;
    live.lastState = state;
    live.lastStateAt = Date.now();
    this.toAdmins(SocketEvents.DeviceState, { deviceId, state, at: new Date().toISOString() });
    const versionChanged = prev?.versionId !== state.versionId;
    const now = Date.now();
    if (versionChanged || prev?.status !== state.status || now - live.lastPersistAt > 15_000) {
      live.lastPersistAt = now;
      await this.ctx.db.displayDevice
        .update({
          where: { id: deviceId },
          data: {
            lastSeenAt: new Date(),
            lastState: JSON.parse(JSON.stringify(state)),
            reportedVersionId: state.versionId && /^[0-9a-f-]{36}$/.test(state.versionId) ? state.versionId : null,
            lastError: state.lastError ?? null,
          },
        })
        .catch((err) => this.ctx.log.warn({ err }, 'falha ao salvar estado do player'));
    }
  }

  private async onPlayerEvent(deviceId: string, deviceName: string, raw: unknown) {
    const ev = raw as PlayerEventMessage;
    if (!ev || typeof ev.type !== 'string' || typeof ev.message !== 'string') return;
    const map: Record<string, string> = {
      playback_error: AuditActions.DevicePlaybackError,
      prepare_error: AuditActions.DevicePrepareError,
      storage_insufficient: AuditActions.DevicePrepareError,
      version_applied: AuditActions.DeviceVersionApplied,
    };
    const action = map[ev.type];
    if (!action) return;
    // limita repetição do mesmo erro (1 registro a cada 10 min por telão/mensagem)
    const key = `${deviceId}:${ev.type}:${ev.message}`;
    if (ev.type !== 'version_applied') {
      const last = this.recentErrors.get(key) ?? 0;
      if (Date.now() - last < 10 * 60_000) return;
      this.recentErrors.set(key, Date.now());
      if (this.recentErrors.size > 2000) this.recentErrors.clear();
    }
    await this.ctx.audit.record({
      action,
      deviceId,
      entityType: 'device',
      entityId: deviceId,
      summary: `${deviceName}: ${ev.message.slice(0, 300)}`,
      details: { type: ev.type, versionId: ev.versionId, mediaId: ev.mediaId, ...(ev.details ?? {}) },
    });
    this.toAdmins(SocketEvents.DeviceStatus, { deviceId, event: ev });
  }

  isDeviceConnected(deviceId: string) {
    return (this.live.get(deviceId)?.sockets.size ?? 0) > 0;
  }

  liveState(deviceId: string) {
    const l = this.live.get(deviceId);
    return l?.lastState ? { state: l.lastState, at: new Date(l.lastStateAt).toISOString() } : null;
  }

  toDevice(deviceId: string, event: string, payload: unknown) {
    this.io?.of('/player').to(`device:${deviceId}`).emit(event, payload);
  }

  toAdmins(event: string, payload: unknown) {
    this.io?.of('/admin').to('admins').emit(event, payload);
  }

  /** Envia comando ao telão e aguarda confirmação real do dispositivo */
  async sendCommand(deviceId: string, msg: DeviceCommandMessage, timeoutMs = 10_000): Promise<CommandAck> {
    const sockets = [...(this.live.get(deviceId)?.sockets ?? [])];
    const socket = sockets.at(-1);
    if (!socket) throw new AppError(409, 'DEVICE_OFFLINE', 'O telão está offline. O comando não foi enviado.');
    try {
      const ack = (await socket.timeout(timeoutMs).emitWithAck(SocketEvents.Command, msg)) as CommandAck;
      return ack && typeof ack.ok === 'boolean' ? ack : { ok: false, error: 'Resposta inválida do telão.' };
    } catch {
      throw new AppError(504, 'DEVICE_TIMEOUT', 'O telão não confirmou o comando a tempo.');
    }
  }

  disconnectDevice(deviceId: string, reason = 'revoked') {
    const l = this.live.get(deviceId);
    if (!l) return;
    for (const s of l.sockets) {
      s.emit(SocketEvents.Revoked, { reason });
      s.disconnect(true);
    }
  }

  /** Desconecta sessões administrativas de um usuário (ex.: troca de senha) */
  disconnectUserSessions(userId: string, exceptSessionId?: string) {
    if (!this.io) return;
    for (const [, s] of this.io.of('/admin').sockets) {
      const u = s.data.user as { id: string; sessionId: string } | undefined;
      if (u?.id === userId && u.sessionId !== exceptSessionId) s.disconnect(true);
    }
  }

  async close() {
    for (const l of this.live.values()) if (l.offlineTimer) clearTimeout(l.offlineTimer);
    await new Promise<void>((r) => (this.io ? this.io.close(() => r()) : r()));
  }
}
