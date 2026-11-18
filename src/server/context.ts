import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { StorageDriver } from './storage/storage.js';
import type { SettingsService } from './services/settings.js';
import type { AuditService } from './services/audit.js';
import type { MediaProcessor } from './services/media-processing.js';
import type { Realtime } from './realtime.js';
import type { DeviceService } from './services/devices.js';
import type { PlaylistService } from './services/playlists.js';
import type { AuthService } from './auth.js';

/** Dependências compartilhadas entre rotas e serviços */
export interface AppContext {
  config: AppConfig;
  db: Db;
  log: FastifyBaseLogger;
  storage: StorageDriver;
  settings: SettingsService;
  audit: AuditService;
  processor: MediaProcessor;
  realtime: Realtime;
  devices: DeviceService;
  playlists: PlaylistService;
  auth: AuthService;
}
