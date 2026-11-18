import type { AppContext } from '../context.js';
import type { DisplayDevice } from '../db.js';
import { notFound } from '../lib/errors.js';
import { pickActiveSchedule } from '../../shared/schedule-logic.js';
import {
  SocketEvents,
  type AssignmentSource,
  type DeviceConnection,
  type DeviceOverrides,
  type PlayerManifest,
  type VersionSnapshot,
} from '../../shared/types.js';
import { AuditActions } from './audit.js';

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

export class DeviceService {
  constructor(private ctx: AppContext) {}

  async connectionOf(device: Pick<DisplayDevice, 'id' | 'lastSeenAt'>): Promise<DeviceConnection> {
    if (this.ctx.realtime.isDeviceConnected(device.id)) return 'online';
    if (!device.lastSeenAt) return 'never';
    const { offlineAfterSec } = await this.ctx.settings.get();
    return Date.now() - device.lastSeenAt.getTime() < offlineAfterSec * 1000 ? 'reconnecting' : 'offline';
  }

  async resolveTarget(deviceId: string, at = new Date()): Promise<ResolvedTarget> {
    const { db } = this.ctx;
    const device = await db.displayDevice.findUnique({ where: { id: deviceId }, include: { schedules: { where: { enabled: true } } } });
    if (!device) throw notFound('Telão não encontrado.');
    const candidates = [...device.schedules];
    // Tenta agendamentos ativos na ordem de prioridade; ignora playlists que nunca foram publicadas
    while (candidates.length) {
      const active = pickActiveSchedule(candidates, at, this.ctx.config.timezone);
      if (!active) break;
      const latest = await db.playlistVersion.findFirst({ where: { playlistId: active.playlistId }, orderBy: { number: 'desc' }, select: { id: true } });
      if (latest) return { versionId: latest.id, source: 'schedule', scheduleId: active.id, scheduleName: active.name };
      candidates.splice(candidates.indexOf(active), 1);
    }
    if (device.publishedVersionId) return { versionId: device.publishedVersionId, source: 'default', scheduleId: null, scheduleName: null };
    return { versionId: null, source: 'none', scheduleId: null, scheduleName: null };
  }

  /** Recalcula a versão-alvo do telão; notifica o player se mudou */
  async recompute(deviceId: string, at = new Date()) {
    const { db } = this.ctx;
    const device = await db.displayDevice.findUnique({ where: { id: deviceId } });
    if (!device) return;
    const target = await this.resolveTarget(deviceId, at);
    const sourceKey = target.source === 'schedule' ? `schedule:${target.scheduleId}` : target.source;
    if (device.effectiveVersionId === target.versionId && device.effectiveSource === sourceKey) return;
    await db.displayDevice.update({ where: { id: deviceId }, data: { effectiveVersionId: target.versionId, effectiveSource: sourceKey } });
    if (device.effectiveSource !== sourceKey && (device.effectiveSource?.startsWith('schedule:') || target.source === 'schedule')) {
      await this.ctx.audit.record({
        action: AuditActions.ScheduleSwitched,
        deviceId,
        entityType: 'device',
        entityId: deviceId,
        summary:
          target.source === 'schedule'
            ? `${device.name}: agendamento "${target.scheduleName}" entrou em vigor`
            : `${device.name}: voltou para a programação padrão`,
        details: { versionId: target.versionId, source: sourceKey },
      });
    }
    await this.notify(deviceId);
  }

  async recomputeAll(at = new Date()) {
    const devices = await this.ctx.db.displayDevice.findMany({ select: { id: true } });
    for (const d of devices) {
      try {
        await this.recompute(d.id, at);
      } catch (err) {
        this.ctx.log.error({ err, deviceId: d.id }, 'falha ao recalcular programação');
      }
    }
  }

  async notify(deviceId: string) {
    const manifest = await this.manifest(deviceId);
    this.ctx.realtime.toDevice(deviceId, SocketEvents.Sync, manifest);
    this.ctx.realtime.toAdmins(SocketEvents.DeviceStatus, { deviceId });
  }

  async manifest(deviceId: string): Promise<PlayerManifest> {
    const { db } = this.ctx;
    const device = await db.displayDevice.findUnique({ where: { id: deviceId } });
    if (!device) throw notFound('Telão não encontrado.');
    const target = await this.resolveTarget(deviceId);
    let version: VersionSnapshot | null = null;
    if (target.versionId) {
      const v = await db.playlistVersion.findUnique({ where: { id: target.versionId } });
      if (v) {
        const body = v.snapshot as unknown as Omit<VersionSnapshot, 'versionId' | 'number' | 'publishedAt'>;
        version = { ...body, versionId: v.id, number: v.number, publishedAt: v.publishedAt.toISOString() };
      }
    }
    const global = await this.ctx.settings.get();
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
  }

  /** IDs de mídias atualmente necessárias por algum telão (versão-alvo, versão reportada ou padrão) */
  async mediaInActiveUse(): Promise<Map<string, string[]>> {
    const { db } = this.ctx;
    const devices = await db.displayDevice.findMany({
      select: { name: true, effectiveVersionId: true, reportedVersionId: true, publishedVersionId: true, schedules: { where: { enabled: true }, select: { playlistId: true } } },
    });
    const versionIds = new Set<string>();
    const versionDevices = new Map<string, string[]>();
    for (const d of devices)
      for (const id of [d.effectiveVersionId, d.reportedVersionId, d.publishedVersionId]) {
        if (!id) continue;
        versionIds.add(id);
        versionDevices.set(id, [...(versionDevices.get(id) ?? []), d.name]);
      }
    // última versão das playlists com agendamentos ativos (podem entrar em vigor a qualquer momento)
    const schedPlaylists = [...new Set(devices.flatMap((d) => d.schedules.map((s) => s.playlistId)))];
    for (const pid of schedPlaylists) {
      const latest = await db.playlistVersion.findFirst({ where: { playlistId: pid }, orderBy: { number: 'desc' }, select: { id: true } });
      if (latest) {
        versionIds.add(latest.id);
        versionDevices.set(latest.id, [...(versionDevices.get(latest.id) ?? []), 'agendamento']);
      }
    }
    const versions = await db.playlistVersion.findMany({ where: { id: { in: [...versionIds] } }, select: { id: true, mediaIds: true } });
    const usage = new Map<string, string[]>();
    for (const v of versions)
      for (const m of v.mediaIds) usage.set(m, [...new Set([...(usage.get(m) ?? []), ...(versionDevices.get(v.id) ?? [])])]);
    return usage;
  }
}
