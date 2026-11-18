import type { AppContext } from '../context';
import { mapDevice, mapSchedule, mapVersion, placeholders, now, type DeviceRow, type ScheduleRow } from '../db';
import { notFound } from '../lib/errors';
import type { LiveInfo } from '../realtime/port';
import { pickActiveSchedule } from '../../shared/schedule-logic';
import {
  SocketEvents,
  type AssignmentSource,
  type DeviceConnection,
  type DeviceOverrides,
  type PlayerManifest,
  type VersionSnapshot,
} from '../../shared/types';
import { AuditActions } from './audit';

export interface ResolvedTarget {
  versionId: string | null;
  source: AssignmentSource;
  scheduleId: string | null;
  scheduleName: string | null;
}

export function parseOverrides(raw: unknown): DeviceOverrides {
  const r = (raw ?? {}) as DeviceOverrides;
  const out: DeviceOverrides = {};
  if (r.fitMode === 'contain' || r.fitMode === 'cover') out.fitMode = r.fitMode;
  if (typeof r.audio === 'boolean') out.audio = r.audio;
  return out;
}

/**
 * Dados necessários para decidir o que cada telão deve tocar, carregados em poucas consultas.
 * (O plano gratuito do Workers permite 50 consultas ao D1 por invocação — nada de consultas por telão.)
 */
interface AssignmentData {
  devices: DeviceRow[];
  schedulesByDevice: Map<string, ScheduleRow[]>;
  latestByPlaylist: Map<string, string>;
}

export class DeviceService {
  constructor(private ctx: AppContext) {}

  async loadRow(deviceId: string): Promise<DeviceRow | null> {
    const r = await this.ctx.db.first('SELECT * FROM "DisplayDevice" WHERE "id" = ?', deviceId);
    return r ? mapDevice(r) : null;
  }

  private async loadAssignment(deviceId?: string): Promise<AssignmentData> {
    const { db } = this.ctx;
    const where = deviceId ? 'WHERE "id" = ?' : '';
    const swhere = deviceId ? 'AND "deviceId" = ?' : '';
    const args = deviceId ? [deviceId] : [];
    const [rows, sch, latest] = await db.batch([
      db.prep(`SELECT * FROM "DisplayDevice" ${where}`, ...args),
      db.prep(`SELECT * FROM "Schedule" WHERE "enabled" = 1 ${swhere}`, ...args),
      db.prep(
        `SELECT v."playlistId", v."id" FROM "PlaylistVersion" v
         WHERE v."playlistId" IN (SELECT "playlistId" FROM "Schedule" WHERE "enabled" = 1 ${swhere})
           AND v."number" = (SELECT MAX(x."number") FROM "PlaylistVersion" x WHERE x."playlistId" = v."playlistId")`,
        ...args,
      ),
    ]);
    const schedulesByDevice = new Map<string, ScheduleRow[]>();
    for (const r of (sch!.results ?? []) as Record<string, unknown>[]) {
      const s = mapSchedule(r);
      schedulesByDevice.set(s.deviceId, [...(schedulesByDevice.get(s.deviceId) ?? []), s]);
    }
    return {
      devices: ((rows!.results ?? []) as Record<string, unknown>[]).map(mapDevice),
      schedulesByDevice,
      latestByPlaylist: new Map(((latest!.results ?? []) as Array<{ playlistId: string; id: string }>).map((r) => [r.playlistId, r.id])),
    };
  }

  private resolve(device: DeviceRow, data: AssignmentData, at: Date): ResolvedTarget {
    const candidates = [...(data.schedulesByDevice.get(device.id) ?? [])];
    // Tenta agendamentos ativos na ordem de prioridade; ignora playlists que nunca foram publicadas
    while (candidates.length) {
      const active = pickActiveSchedule(candidates, at, this.ctx.config.timezone);
      if (!active) break;
      const latest = data.latestByPlaylist.get(active.playlistId);
      if (latest) return { versionId: latest, source: 'schedule', scheduleId: active.id, scheduleName: active.name };
      candidates.splice(candidates.indexOf(active), 1);
    }
    if (device.publishedVersionId) return { versionId: device.publishedVersionId, source: 'default', scheduleId: null, scheduleName: null };
    return { versionId: null, source: 'none', scheduleId: null, scheduleName: null };
  }

  /** online = WebSocket ativo no RealtimeHub; senão, decide pelo último sinal recebido */
  async connectionOf(device: Pick<DeviceRow, 'id' | 'lastSeenAt'>, live?: LiveInfo): Promise<DeviceConnection> {
    if (live?.connected) return 'online';
    const candidates = [device.lastSeenAt, live?.at].filter((x): x is string => !!x).sort();
    const lastSeen = candidates.at(-1);
    if (!lastSeen) return 'never';
    const { offlineAfterSec } = await this.ctx.settings.get();
    return Date.now() - new Date(lastSeen).getTime() < offlineAfterSec * 1000 ? 'reconnecting' : 'offline';
  }

  async resolveTarget(deviceId: string, at = new Date()): Promise<ResolvedTarget> {
    const data = await this.loadAssignment(deviceId);
    const device = data.devices[0];
    if (!device) throw notFound('Telão não encontrado.');
    return this.resolve(device, data, at);
  }

  /** Recalcula a versão-alvo do telão; notifica o player se mudou */
  async recompute(deviceId: string, at = new Date()) {
    await this.recomputeMany(await this.loadAssignment(deviceId), at);
  }

  /** Agendamentos são aplicados pelo servidor (cron), independente do painel estar aberto */
  async recomputeAll(at = new Date()) {
    await this.recomputeMany(await this.loadAssignment(), at);
  }

  private async recomputeMany(data: AssignmentData, at: Date) {
    const { db } = this.ctx;
    const changed: Array<{ device: DeviceRow; target: ResolvedTarget; sourceKey: string }> = [];
    for (const device of data.devices) {
      const target = this.resolve(device, data, at);
      const sourceKey = target.source === 'schedule' ? `schedule:${target.scheduleId}` : target.source;
      if (device.effectiveVersionId === target.versionId && device.effectiveSource === sourceKey) continue;
      changed.push({ device, target, sourceKey });
    }
    if (!changed.length) return;
    const ts = now();
    await db.batch(
      changed.map(({ device, target, sourceKey }) =>
        db.prep('UPDATE "DisplayDevice" SET "effectiveVersionId" = ?, "effectiveSource" = ?, "updatedAt" = ? WHERE "id" = ?', target.versionId, sourceKey, ts, device.id),
      ),
    );
    for (const { device, target, sourceKey } of changed) {
      if (device.effectiveSource !== sourceKey && (device.effectiveSource?.startsWith('schedule:') || target.source === 'schedule')) {
        await this.ctx.audit.record({
          action: AuditActions.ScheduleSwitched,
          deviceId: device.id,
          entityType: 'device',
          entityId: device.id,
          summary:
            target.source === 'schedule'
              ? `${device.name}: agendamento "${target.scheduleName}" entrou em vigor`
              : `${device.name}: voltou para a programação padrão`,
          details: { versionId: target.versionId, source: sourceKey },
        });
      }
    }
    await this.notifyMany(changed.map((x) => x.device.id), data, at);
  }

  async notify(deviceId: string) {
    await this.notifyMany([deviceId], await this.loadAssignment(deviceId), new Date());
  }

  async notifyAll() {
    const data = await this.loadAssignment();
    await this.notifyMany(
      data.devices.map((d) => d.id),
      data,
      new Date(),
    );
  }

  private async notifyMany(deviceIds: string[], data: AssignmentData, at: Date) {
    if (!deviceIds.length) return;
    const manifests = await this.buildManifests(deviceIds, data, at);
    for (const m of manifests) {
      this.ctx.realtime.toDevice(m.device.id, SocketEvents.Sync, m);
      this.ctx.realtime.toAdmins(SocketEvents.DeviceStatus, { deviceId: m.device.id });
    }
  }

  private async buildManifests(deviceIds: string[], data: AssignmentData, at: Date): Promise<PlayerManifest[]> {
    // recarrega as linhas (o recálculo pode ter acabado de alterá-las)
    const fresh = await this.ctx.db.all(`SELECT * FROM "DisplayDevice" WHERE "id" IN (${placeholders(deviceIds.length)})`, ...deviceIds);
    const devices = fresh.map(mapDevice);
    const targets = new Map(devices.map((d) => [d.id, this.resolve(d, data, at)]));
    const versionIds = [...new Set([...targets.values()].map((t) => t.versionId).filter((x): x is string => !!x))];
    const versions = new Map<string, VersionSnapshot>();
    if (versionIds.length) {
      for (const r of await this.ctx.db.all(`SELECT * FROM "PlaylistVersion" WHERE "id" IN (${placeholders(versionIds.length)})`, ...versionIds)) {
        const v = mapVersion(r);
        const body = v.snapshot as Omit<VersionSnapshot, 'versionId' | 'number' | 'publishedAt'>;
        versions.set(v.id, { ...body, versionId: v.id, number: v.number, publishedAt: v.publishedAt });
      }
    }
    const global = await this.ctx.settings.get();
    return devices.map((device) => {
      const target = targets.get(device.id)!;
      const version = target.versionId ? (versions.get(target.versionId) ?? null) : null;
      return {
        device: { id: device.id, name: device.name, identifier: device.identifier },
        source: version ? target.source : 'none',
        scheduleName: target.scheduleName,
        version,
        applyMode: device.applyMode === 'immediate' ? 'immediate' : 'next',
        overrides: parseOverrides(device.settings),
        emptyBehavior: global.emptyBehavior,
        serverTime: new Date().toISOString(),
      };
    });
  }

  async manifest(deviceId: string): Promise<PlayerManifest> {
    const data = await this.loadAssignment(deviceId);
    if (!data.devices.length) throw notFound('Telão não encontrado.');
    return (await this.buildManifests([deviceId], data, new Date()))[0]!;
  }

  /** IDs de mídias atualmente necessárias por algum telão (versão-alvo, versão reportada ou padrão) */
  async mediaInActiveUse(): Promise<Map<string, string[]>> {
    const { db } = this.ctx;
    const [devRes, schedRes] = await db.batch([
      db.prep('SELECT "name", "effectiveVersionId", "reportedVersionId", "publishedVersionId" FROM "DisplayDevice"'),
      // última versão das playlists com agendamentos ativos (podem entrar em vigor a qualquer momento)
      db.prep(
        `SELECT v."id" FROM "PlaylistVersion" v
         WHERE v."playlistId" IN (SELECT DISTINCT "playlistId" FROM "Schedule" WHERE "enabled" = 1)
           AND v."number" = (SELECT MAX("number") FROM "PlaylistVersion" x WHERE x."playlistId" = v."playlistId")`,
      ),
    ]);
    const devices = (devRes!.results ?? []) as Array<{ name: string; effectiveVersionId: string | null; reportedVersionId: string | null; publishedVersionId: string | null }>;
    const versionIds = new Set<string>();
    const versionDevices = new Map<string, string[]>();
    for (const d of devices)
      for (const id of [d.effectiveVersionId, d.reportedVersionId, d.publishedVersionId]) {
        if (!id) continue;
        versionIds.add(id);
        versionDevices.set(id, [...(versionDevices.get(id) ?? []), d.name]);
      }
    for (const { id } of (schedRes!.results ?? []) as Array<{ id: string }>) {
      versionIds.add(id);
      versionDevices.set(id, [...(versionDevices.get(id) ?? []), 'agendamento']);
    }
    const usage = new Map<string, string[]>();
    if (!versionIds.size) return usage;
    const ids = [...versionIds];
    const versions = await db.all<{ id: string; mediaIds: string }>(`SELECT "id", "mediaIds" FROM "PlaylistVersion" WHERE "id" IN (${placeholders(ids.length)})`, ...ids);
    for (const v of versions) {
      let mediaIds: string[] = [];
      try {
        mediaIds = JSON.parse(v.mediaIds) as string[];
      } catch {
        mediaIds = [];
      }
      for (const m of mediaIds) usage.set(m, [...new Set([...(usage.get(m) ?? []), ...(versionDevices.get(v.id) ?? [])])]);
    }
    return usage;
  }

  /** Mídias acessíveis ao dispositivo: somente as das versões ligadas a ele */
  async allowedMedia(deviceId: string): Promise<Set<string>> {
    const d = await this.loadRow(deviceId);
    if (!d) return new Set();
    const rows = await this.ctx.db.all<{ mediaIds: string }>(
      `SELECT "mediaIds" FROM "PlaylistVersion" WHERE "id" IN (?, ?, ?)
       UNION ALL
       SELECT v."mediaIds" FROM "PlaylistVersion" v
       WHERE v."playlistId" IN (SELECT "playlistId" FROM "Schedule" WHERE "deviceId" = ? AND "enabled" = 1)
         AND v."number" = (SELECT MAX("number") FROM "PlaylistVersion" x WHERE x."playlistId" = v."playlistId")`,
      d.effectiveVersionId,
      d.publishedVersionId,
      d.reportedVersionId,
      deviceId,
    );
    const out = new Set<string>();
    for (const r of rows) {
      try {
        for (const id of JSON.parse(r.mediaIds) as string[]) out.add(id);
      } catch {
        /* ignora */
      }
    }
    return out;
  }
}
