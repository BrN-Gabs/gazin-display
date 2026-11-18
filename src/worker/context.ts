import { loadConfig, type AppConfig, type Env } from './env';
import { Db } from './db';
import { SettingsService } from './services/settings';
import { AuditService } from './services/audit';
import { DeviceService } from './services/devices';
import { PlaylistService } from './services/playlists';
import { AuthService } from './auth';
import { StubRealtime, type RealtimePort } from './realtime/port';

/** Dependências compartilhadas entre rotas e serviços (criadas por requisição — o Worker não mantém estado entre requisições) */
export interface AppContext {
  env: Env;
  config: AppConfig;
  db: Db;
  bucket: R2Bucket;
  realtime: RealtimePort;
  settings: SettingsService;
  audit: AuditService;
  devices: DeviceService;
  playlists: PlaylistService;
  auth: AuthService;
  waitUntil(p: Promise<unknown>): void;
}

export function createContext(env: Env, waitUntil: (p: Promise<unknown>) => void, realtime?: RealtimePort): AppContext {
  const config = loadConfig(env);
  const db = new Db(env.DB);
  const ctx = { env, config, db, bucket: env.MEDIA, waitUntil } as AppContext;
  ctx.realtime = realtime ?? new StubRealtime(env, waitUntil);
  ctx.settings = new SettingsService(db, config.storageLimitGbDefault);
  ctx.audit = new AuditService(db);
  ctx.auth = new AuthService(ctx);
  ctx.devices = new DeviceService(ctx);
  ctx.playlists = new PlaylistService(ctx);
  return ctx;
}
