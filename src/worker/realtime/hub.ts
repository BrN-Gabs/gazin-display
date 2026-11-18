/**
 * RealtimeHub — Durable Object único que substitui o Socket.IO da versão 1.
 *
 *  - Painel (/api/realtime/admin) e telões (/api/realtime/player) conectam por WebSocket.
 *  - WebSocket Hibernation: sem mensagens, o objeto sai da memória e não gera custo de duração.
 *    O "ping" dos clientes é respondido automaticamente pela Cloudflare sem acordar o objeto.
 *  - Comandos remotos com confirmação real do telão (ack) e timeout, como o emitWithAck anterior.
 *  - Estado ao vivo dos telões em memória; persistido no D1 em mudanças ou a cada 15 s.
 *  - Telões informam o estado a cada 5 s apenas enquanto houver painel aberto; sem painel, a cada 30 s
 *    (reduz requisições e mantém o objeto hibernando a maior parte do tempo).
 *
 * A autenticação é feita pelo Worker antes de encaminhar a conexão: o DO só recebe conexões já validadas.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { createContext, type AppContext } from '../context';
import { isUuid, now } from '../db';
import { AuditActions } from '../services/audit';
import { SocketEvents, type CommandAck, type DeviceCommandMessage, type PlayerEventMessage, type PlayerStateReport } from '../../shared/types';
import type { CommandOutcome, LiveInfo, RealtimePort } from './port';
import { outcomeToAck } from './port';

type Attachment = { role: 'admin'; userId: string; sessionId: string } | { role: 'player'; deviceId: string; deviceName: string; connectedAt: number };

const REPORT_ACTIVE_MS = 5_000;
const REPORT_IDLE_MS = 30_000;
const STALE_AFTER_MS = 90_000;
const OFFLINE_KEY = 'offline';

export class RealtimeHub extends DurableObject<Env> {
  private liveStates = new Map<string, { state: PlayerStateReport; at: number; lastPersistAt: number }>();
  private lastActivity = new Map<WebSocket, number>();
  private pending = new Map<string, (ack: CommandAck) => void>();
  private recentErrors = new Map<string, number>();
  private _app: AppContext | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Contexto da aplicação (D1, auditoria, serviços) com tempo real local (sem RPC para si mesmo) */
  private get app(): AppContext {
    this._app ??= createContext(this.env, (p) => this.ctx.waitUntil(p), this.localPort());
    return this._app;
  }

  private localPort(): RealtimePort {
    return {
      toAdmins: (e, p) => this.toAdmins(e, p),
      toDevice: (id, e, p) => this.toDevice(id, e, p),
      live: (ids) => this.live_(ids),
      sendCommand: async (id, msg, t) => outcomeToAck(await this.sendCommand(id, msg, t)),
      disconnectDevice: (id, r) => this.disconnectDevice(id, r),
      disconnectUserSessions: (u, s) => this.disconnectUserSessions(u, s),
    };
  }

  // ---------------- conexões ----------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('esperado WebSocket', { status: 426 });
    const role = request.headers.get('x-gd-role');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (role === 'admin') {
      const att: Attachment = { role: 'admin', userId: request.headers.get('x-gd-user')!, sessionId: request.headers.get('x-gd-session')! };
      const firstAdmin = this.ctx.getWebSockets('admin').length === 0;
      this.ctx.acceptWebSocket(server, ['admin', `user:${att.userId}`]);
      server.serializeAttachment(att);
      if (firstAdmin) this.broadcastPlayerConfig();
    } else if (role === 'player') {
      const att: Attachment = { role: 'player', deviceId: request.headers.get('x-gd-device')!, deviceName: decodeURIComponent(request.headers.get('x-gd-device-name') ?? ''), connectedAt: Date.now() };
      const wasConnected = this.deviceSockets(att.deviceId).length > 0;
      this.ctx.acceptWebSocket(server, ['player', `device:${att.deviceId}`]);
      server.serializeAttachment(att);
      this.lastActivity.set(server, Date.now());
      this.ctx.waitUntil(this.onPlayerConnect(server, att, wasConnected));
    } else {
      return new Response('papel inválido', { status: 400 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* conexão encerrada */
    }
  }

  private reportMs() {
    return this.ctx.getWebSockets('admin').length ? REPORT_ACTIVE_MS : REPORT_IDLE_MS;
  }

  private broadcastPlayerConfig() {
    const reportMs = this.reportMs();
    for (const ws of this.ctx.getWebSockets('player')) this.send(ws, { t: 'config', reportMs });
  }

  /** Sockets "vivos" do telão (descarta conexões sem atividade há muito tempo) */
  private deviceSockets(deviceId: string) {
    return this.ctx.getWebSockets(`device:${deviceId}`).filter((ws) => {
      const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const last = Math.max(auto, this.lastActivity.get(ws) ?? 0);
      // após hibernar, a atividade em memória se perde: sem registro, considera ativo
      return last === 0 || Date.now() - last < STALE_AFTER_MS;
    });
  }

  private async onPlayerConnect(ws: WebSocket, att: Extract<Attachment, { role: 'player' }>, wasConnected: boolean) {
    const { db, audit, devices } = this.app;
    this.send(ws, { t: 'config', reportMs: this.reportMs() });
    await this.clearOffline(att.deviceId);
    try {
      const before = await db.first<{ disconnectedAt: string | null; connectedAt: string | null }>('SELECT "disconnectedAt", "connectedAt" FROM "DisplayDevice" WHERE "id" = ?', att.deviceId);
      await db.run('UPDATE "DisplayDevice" SET "connectedAt" = ?, "lastSeenAt" = ? WHERE "id" = ?', now(), now(), att.deviceId);
      // registra conexão apenas se estava offline (evita poluir o histórico com reconexões rápidas)
      const offlineFor = before?.disconnectedAt ? Date.now() - new Date(before.disconnectedAt).getTime() : Infinity;
      if (!wasConnected && (offlineFor > 60_000 || !before?.connectedAt))
        await audit.record({ action: AuditActions.DeviceConnected, deviceId: att.deviceId, entityType: 'device', entityId: att.deviceId, summary: `${att.deviceName} conectou-se` });
      this.toAdmins(SocketEvents.DeviceStatus, { deviceId: att.deviceId });
      // envia o estado atual da programação imediatamente (reconciliação na reconexão)
      this.send(ws, { t: 'event', e: SocketEvents.Sync, d: await devices.manifest(att.deviceId) });
    } catch (err) {
      console.error('falha ao registrar conexão do player', err);
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 256_000) return;
    this.lastActivity.set(ws, Date.now());
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.role !== 'player') return; // o painel só recebe eventos
    let msg: { t?: string; id?: string; d?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'state') await this.onState(att.deviceId, msg.d);
    else if (msg.t === 'event') await this.onPlayerEvent(att.deviceId, att.deviceName, msg.d);
    else if (msg.t === 'ack' && typeof msg.id === 'string') {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg.d as CommandAck);
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'encerrado');
    } catch {
      /* já fechado */
    }
    await this.onSocketGone(ws);
  }

  override async webSocketError(ws: WebSocket) {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket) {
    this.lastActivity.delete(ws);
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (att.role === 'admin') {
      if (this.ctx.getWebSockets('admin').filter((s) => s !== ws).length === 0) this.broadcastPlayerConfig();
      return;
    }
    if (this.deviceSockets(att.deviceId).some((s) => s !== ws)) return;
    const { db, settings } = this.app;
    await db.run('UPDATE "DisplayDevice" SET "disconnectedAt" = ? WHERE "id" = ?', now(), att.deviceId).catch(() => {});
    this.toAdmins(SocketEvents.DeviceStatus, { deviceId: att.deviceId });
    // registra a desconexão só se o telão não voltar dentro do limite configurado
    const { offlineAfterSec } = await settings.get();
    const map = ((await this.ctx.storage.get<Record<string, { dueAt: number; name: string }>>(OFFLINE_KEY)) ?? {}) as Record<string, { dueAt: number; name: string }>;
    map[att.deviceId] = { dueAt: Date.now() + offlineAfterSec * 1000, name: att.deviceName };
    await this.ctx.storage.put(OFFLINE_KEY, map);
    await this.scheduleAlarm(map);
  }

  private async clearOffline(deviceId: string) {
    const map = await this.ctx.storage.get<Record<string, { dueAt: number; name: string }>>(OFFLINE_KEY);
    if (map?.[deviceId]) {
      delete map[deviceId];
      await this.ctx.storage.put(OFFLINE_KEY, map);
    }
  }

  private async scheduleAlarm(map: Record<string, { dueAt: number }>) {
    const next = Math.min(...Object.values(map).map((v) => v.dueAt));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  override async alarm() {
    const map = (await this.ctx.storage.get<Record<string, { dueAt: number; name: string }>>(OFFLINE_KEY)) ?? {};
    const t = Date.now();
    for (const [deviceId, v] of Object.entries(map)) {
      if (v.dueAt > t) continue;
      delete map[deviceId];
      if (this.deviceSockets(deviceId).length) continue;
      await this.app.audit.record({ action: AuditActions.DeviceDisconnected, deviceId, entityType: 'device', entityId: deviceId, summary: `${v.name} desconectou-se` });
      this.toAdmins(SocketEvents.DeviceStatus, { deviceId });
    }
    await this.ctx.storage.put(OFFLINE_KEY, map);
    await this.scheduleAlarm(map);
  }

  // ---------------- mensagens do player ----------------

  private async onState(deviceId: string, raw: unknown) {
    const s = raw as PlayerStateReport | null;
    if (!s || typeof s !== 'object' || !['playing', 'paused', 'error', 'idle', 'starting'].includes(s.status) || typeof s.index !== 'number' || typeof s.total !== 'number') return;
    const prev = this.liveStates.get(deviceId);
    const t = Date.now();
    const entry = { state: s, at: t, lastPersistAt: prev?.lastPersistAt ?? 0 };
    this.liveStates.set(deviceId, entry);
    this.toAdmins(SocketEvents.DeviceState, { deviceId, state: s, at: new Date(t).toISOString() });
    if (prev?.state.versionId !== s.versionId || prev?.state.status !== s.status || t - entry.lastPersistAt > 15_000) {
      entry.lastPersistAt = t;
      await this.app.db
        .run(
          'UPDATE "DisplayDevice" SET "lastSeenAt" = ?, "lastState" = ?, "reportedVersionId" = ?, "lastError" = ? WHERE "id" = ?',
          new Date(t).toISOString(),
          JSON.stringify(s),
          s.versionId && isUuid(s.versionId) ? s.versionId : null,
          s.lastError ?? null,
          deviceId,
        )
        .catch((err) => console.warn('falha ao salvar estado do player', err));
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
    await this.app.audit.record({
      action,
      deviceId,
      entityType: 'device',
      entityId: deviceId,
      summary: `${deviceName}: ${ev.message.slice(0, 300)}`,
      details: { type: ev.type, versionId: ev.versionId, mediaId: ev.mediaId, ...(ev.details ?? {}) },
    });
    this.toAdmins(SocketEvents.DeviceStatus, { deviceId, event: ev });
  }

  // ---------------- RPC (chamado pelo Worker) ----------------

  toAdmins(event: string, payload: unknown) {
    const data = JSON.stringify({ t: 'event', e: event, d: payload });
    for (const ws of this.ctx.getWebSockets('admin')) {
      try {
        ws.send(data);
      } catch {
        /* encerrado */
      }
    }
  }

  toDevice(deviceId: string, event: string, payload: unknown) {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) this.send(ws, { t: 'event', e: event, d: payload });
  }

  async live_(deviceIds: string[]): Promise<Record<string, LiveInfo>> {
    const out: Record<string, LiveInfo> = {};
    for (const id of deviceIds) {
      const l = this.liveStates.get(id);
      out[id] = { connected: this.deviceSockets(id).length > 0, state: l?.state ?? null, at: l ? new Date(l.at).toISOString() : null };
    }
    return out;
  }

  /** RPC: mesmo que live_ (nome público) */
  async live(deviceIds: string[]): Promise<Record<string, LiveInfo>> {
    return this.live_(deviceIds);
  }

  /** Envia comando ao telão e aguarda confirmação real do dispositivo */
  async sendCommand(deviceId: string, msg: DeviceCommandMessage, timeoutMs = 10_000): Promise<CommandOutcome> {
    const ws = this.deviceSockets(deviceId).at(-1);
    if (!ws) return { kind: 'offline' };
    const result = await new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      this.pending.set(msg.id, (ack) => {
        clearTimeout(timer);
        resolve({ kind: 'ack', ack });
      });
      this.send(ws, { t: 'cmd', id: msg.id, d: msg });
    });
    return result;
  }

  disconnectDevice(deviceId: string, reason = 'revoked') {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      this.send(ws, { t: 'event', e: SocketEvents.Revoked, d: { reason } });
      try {
        ws.close(4001, reason);
      } catch {
        /* já fechado */
      }
    }
  }

  /** Desconecta sessões administrativas de um usuário (ex.: troca de senha) */
  disconnectUserSessions(userId: string, exceptSessionId?: string) {
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.role === 'admin' && att.sessionId !== exceptSessionId) {
        try {
          ws.close(4001, 'sessão encerrada');
        } catch {
          /* já fechado */
        }
      }
    }
  }
}
