import type { RealtimeHub } from './realtime/hub';

/** Bindings e variáveis do Worker (wrangler.jsonc). Segredos: R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY. */
export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  REALTIME: DurableObjectNamespace<RealtimeHub>;
  ASSETS: Fetcher;

  PUBLIC_URL?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** Somente testes/desenvolvimento: endpoint S3 alternativo para as URLs pré-assinadas */
  R2_S3_ENDPOINT?: string;
  SESSION_TTL_HOURS?: string;
  DEVICE_TOKEN_TTL_DAYS?: string;
  MAX_UPLOAD_MB?: string;
  UPLOAD_CHUNK_MB?: string;
  STORAGE_LIMIT_GB?: string;
  PASSWORD_ITERATIONS?: string;
  /** auto (padrão) = Secure quando a requisição é HTTPS | true | false */
  COOKIE_SECURE?: string;
}

const MiB = 1024 * 1024;
const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : def;
};

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: Env) {
  const accountId = env.R2_ACCOUNT_ID?.trim() || '';
  const directUpload = !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && (accountId || env.R2_S3_ENDPOINT));
  let publicOrigin: string | undefined;
  try {
    publicOrigin = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : undefined;
  } catch {
    publicOrigin = undefined;
  }
  const SESSION_TTL_HOURS = num(env.SESSION_TTL_HOURS, 12);
  const DEVICE_TOKEN_TTL_DAYS = Math.min(400, num(env.DEVICE_TOKEN_TTL_DAYS, 365));
  const MAX_UPLOAD_MB = num(env.MAX_UPLOAD_MB, 20480);
  // R2: todas as partes (exceto a última) precisam ter o mesmo tamanho e no mínimo 5 MiB
  const UPLOAD_CHUNK_MB = Math.min(95, Math.max(5, num(env.UPLOAD_CHUNK_MB, 16)));
  return {
    SESSION_TTL_HOURS,
    DEVICE_TOKEN_TTL_DAYS,
    MAX_UPLOAD_MB,
    UPLOAD_CHUNK_MB,
    sessionTtlMs: SESSION_TTL_HOURS * 3600_000,
    deviceTtlMs: DEVICE_TOKEN_TTL_DAYS * 86400_000,
    maxUploadBytes: Math.floor(MAX_UPLOAD_MB * MiB),
    chunkBytes: Math.floor(UPLOAD_CHUNK_MB * MiB),
    storageLimitGbDefault: num(env.STORAGE_LIMIT_GB, 30),
    passwordIterations: Math.min(100_000, Math.max(10_000, Math.floor(num(env.PASSWORD_ITERATIONS, 50_000)))),
    cookieSecureMode: (env.COOKIE_SECURE ?? 'auto').toLowerCase(),
    publicOrigin,
    directUpload,
    r2: {
      accountId,
      bucket: env.R2_BUCKET_NAME || 'gazin-display-media',
      endpoint: env.R2_S3_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''),
    },
    timezone: 'America/Sao_Paulo' as const,
  };
}
