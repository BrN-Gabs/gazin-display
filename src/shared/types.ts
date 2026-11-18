/**
 * Tipos compartilhados entre servidor, painel administrativo e player.
 * Não importar nada de Node ou do navegador aqui.
 */

export type FitMode = 'contain' | 'cover';
export type MediaKind = 'image' | 'video';
export type EmptyBehavior = 'black' | 'standby';
export type ApplyMode = 'next' | 'immediate';

export interface PlaylistSettings {
  loop: boolean;
  audio: boolean;
  fitMode: FitMode;
  /** Duração padrão das imagens desta playlist; null = padrão global */
  imageDurationSec: number | null;
  /** Mídia exibida quando nenhuma outra puder ser reproduzida */
  fallbackMediaId: string | null;
}

export interface SnapshotItem {
  /** ID do PlaylistItem (estável entre versões — usado para manter a posição ao atualizar) */
  itemId: string;
  mediaId: string;
  type: MediaKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  /** Imagens: tempo de exibição configurado. Vídeos: duração real (informativa) */
  durationMs: number;
  width: number | null;
  height: number | null;
  /** Imagens: true quando a duração foi definida individualmente */
  customDuration?: boolean;
}

export interface VersionSnapshot {
  versionId: string;
  playlistId: string;
  playlistName: string;
  number: number;
  publishedAt: string;
  settings: { loop: boolean; audio: boolean; fitMode: FitMode; imageDurationMs: number };
  fallback: SnapshotItem | null;
  items: SnapshotItem[];
}

export interface DeviceOverrides {
  fitMode?: FitMode;
  audio?: boolean;
}

export type AssignmentSource = 'default' | 'schedule' | 'none';

export interface PlayerManifest {
  device: { id: string; name: string; identifier: string };
  source: AssignmentSource;
  scheduleName: string | null;
  version: VersionSnapshot | null;
  applyMode: ApplyMode;
  overrides: DeviceOverrides;
  emptyBehavior: EmptyBehavior;
  serverTime: string;
}

export type PlaybackStatus = 'playing' | 'paused' | 'error' | 'idle' | 'starting';

export interface PlayerStateReport {
  status: PlaybackStatus;
  versionId: string | null;
  versionNumber: number | null;
  playlistName: string | null;
  index: number;
  total: number;
  itemId: string | null;
  mediaId: string | null;
  mediaName: string | null;
  mediaType: MediaKind | null;
  elapsedMs: number;
  durationMs: number;
  pendingVersionId: string | null;
  preparing: { versionId: string; doneItems: number; totalItems: number; doneBytes: number; totalBytes: number } | null;
  prepareError: string | null;
  cache: { usageBytes: number | null; quotaBytes: number | null; persisted: boolean | null; cachedItems: number };
  fitMode: FitMode;
  audio: boolean;
  audioBlocked: boolean;
  lastError: string | null;
  screen: { width: number; height: number; dpr: number };
  appVersion: string;
  uptimeSec: number;
}

export const COMMAND_TYPES = [
  'pause',
  'resume',
  'next',
  'previous',
  'restart',
  'goto',
  'reload',
  'set_audio',
  'set_fit',
  'sync',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export interface DeviceCommandMessage {
  id: string;
  type: CommandType;
  payload?: { index?: number; enabled?: boolean; fitMode?: FitMode } | null;
}

export interface CommandAck {
  ok: boolean;
  error?: string;
  state?: PlayerStateReport;
}

export type DeviceConnection = 'online' | 'reconnecting' | 'offline' | 'never';

/** Eventos Socket.IO */
export const SocketEvents = {
  // servidor -> player
  Sync: 'sync',
  Command: 'command',
  Revoked: 'revoked',
  // player -> servidor
  State: 'state',
  PlayerEvent: 'player:event',
  // servidor -> admin
  DeviceStatus: 'device:status',
  DeviceState: 'device:state',
  MediaUpdated: 'media:updated',
  Published: 'playlist:published',
  PlaylistChanged: 'playlist:changed',
  CommandResult: 'command:result',
  PairingPending: 'pairing:pending',
} as const;

export interface PlayerEventMessage {
  type: 'playback_error' | 'prepare_error' | 'version_applied' | 'storage_insufficient' | 'audio_blocked';
  message: string;
  versionId?: string | null;
  mediaId?: string | null;
  details?: Record<string, unknown>;
}

export const DEFAULT_IMAGE_DURATION_SEC = 30;

export const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ACCEPTED_VIDEO_MIME = ['video/mp4', 'video/webm'] as const;
/** Formatos aceitos apenas porque são convertidos para MP4/H.264 no servidor */
export const TRANSCODABLE_VIDEO_MIME = ['video/quicktime', 'video/x-matroska', 'video/vnd.avi', 'video/x-msvideo', 'video/mpeg', 'video/mp2t'] as const;
