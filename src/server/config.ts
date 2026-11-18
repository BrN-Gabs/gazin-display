import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_URL: z.string().optional(),
  TRUST_PROXY: bool(false),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  COOKIE_SECURE: z.string().default('auto'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  DEVICE_TOKEN_TTL_DAYS: z.coerce.number().positive().max(400).default(365),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_PREFIX: z.string().default('gazin-display/'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(20480),
  UPLOAD_CHUNK_MB: z.coerce.number().positive().max(64).default(8),
  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
  WEB_DIST_DIR: z.string().optional(),
  EMBEDDED_DB: bool(false),
  EMBEDDED_DB_DIR: z.string().default('./.data/postgres'),
  AUTO_MIGRATE: bool(true),
  ADMIN_NAME: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_RESET_PASSWORD: bool(false),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Partial<Record<string, string>> = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${msg}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === 'production';
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 exige S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY');
  }
  return {
    ...env,
    production,
    // auto: cookies Secure quando a URL pública é HTTPS (ou em produção sem PUBLIC_URL)
    cookieSecure: env.COOKIE_SECURE === 'auto' ? (env.PUBLIC_URL ? env.PUBLIC_URL.startsWith('https://') : production) : env.COOKIE_SECURE === 'true',
    storageDir: path.resolve(env.STORAGE_DIR),
    maxUploadBytes: Math.floor(env.MAX_UPLOAD_MB * 1024 * 1024),
    chunkBytes: Math.floor(env.UPLOAD_CHUNK_MB * 1024 * 1024),
    publicOrigin: env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : undefined,
    webDistDir: path.resolve(env.WEB_DIST_DIR ?? 'dist/web'),
    timezone: 'America/Sao_Paulo' as const,
  };
}
