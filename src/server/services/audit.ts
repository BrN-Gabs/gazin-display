import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db.js';

export const AuditActions = {
  LoginSuccess: 'auth.login',
  LoginFailed: 'auth.login_failed',
  Logout: 'auth.logout',
  PasswordChanged: 'auth.password_changed',
  SessionsRevoked: 'auth.sessions_revoked',
  UserCreated: 'user.created',
  UserUpdated: 'user.updated',
  MediaUploaded: 'media.uploaded',
  MediaProcessed: 'media.processed',
  MediaFailed: 'media.failed',
  MediaUpdated: 'media.updated',
  MediaDeleted: 'media.deleted',
  PlaylistCreated: 'playlist.created',
  PlaylistUpdated: 'playlist.updated',
  PlaylistDuplicated: 'playlist.duplicated',
  PlaylistDeleted: 'playlist.deleted',
  PlaylistPublished: 'playlist.published',
  DeviceCreated: 'device.created',
  DeviceUpdated: 'device.updated',
  DeviceDeleted: 'device.deleted',
  DevicePaired: 'device.paired',
  DeviceRevoked: 'device.revoked',
  DeviceRenewed: 'device.renewed',
  DeviceUnassigned: 'device.unassigned',
  DeviceConnected: 'device.connected',
  DeviceDisconnected: 'device.disconnected',
  DeviceVersionApplied: 'device.version_applied',
  DevicePlaybackError: 'device.playback_error',
  DevicePrepareError: 'device.prepare_error',
  DeviceCommand: 'device.command',
  ScheduleCreated: 'schedule.created',
  ScheduleUpdated: 'schedule.updated',
  ScheduleDeleted: 'schedule.deleted',
  ScheduleSwitched: 'schedule.switched',
  SettingsUpdated: 'settings.updated',
} as const;

const SENSITIVE = /pass(word)?|secret|token|cookie|authorization|hash/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[removido]' : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '…';
  return value;
}

export interface AuditEntry {
  action: string;
  summary: string;
  userId?: string | null;
  deviceId?: string | null;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export class AuditService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  /** Nunca lança: falhas de auditoria não podem derrubar a operação principal */
  async record(entry: AuditEntry) {
    try {
      await this.db.auditLog.create({
        data: {
          action: entry.action,
          summary: entry.summary.slice(0, 500),
          userId: entry.userId ?? null,
          deviceId: entry.deviceId ?? null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          details: entry.details ? (scrub(entry.details) as object) : undefined,
          ip: entry.ip,
        },
      });
    } catch (err) {
      this.log.error({ err, action: entry.action }, 'falha ao registrar auditoria');
    }
  }
}
