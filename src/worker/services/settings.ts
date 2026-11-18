import { z } from 'zod';
import type { Db } from '../db';
import { now } from '../db';
import { DEFAULT_IMAGE_DURATION_SEC } from '../../shared/types';

export const globalSettingsSchema = z.object({
  imageDurationSec: z.number().int().min(1).max(86400).default(DEFAULT_IMAGE_DURATION_SEC),
  loop: z.boolean().default(true),
  audio: z.boolean().default(false),
  fitMode: z.enum(['contain', 'cover']).default('contain'),
  emptyBehavior: z.enum(['black', 'standby']).default('standby'),
  /** Limite operacional por arquivo (MB). Sempre limitado por MAX_UPLOAD_MB do ambiente */
  maxUploadMb: z.number().int().min(1).max(1024 * 1024).default(20480),
  /** Tempo (s) sem sinal após o qual o telão é considerado offline */
  offlineAfterSec: z.number().int().min(15).max(3600).default(45),
  /** Limite lógico de armazenamento das mídias (GB). Padrão: STORAGE_LIMIT_GB. Não é uma trava de faturamento da Cloudflare. */
  storageLimitGb: z.number().min(1).max(100_000).optional(),
});

export type GlobalSettings = z.infer<typeof globalSettingsSchema> & { storageLimitGb: number };

const KEY = 'global';

/**
 * Configurações globais (tabela AppSetting). Cache curto por instância: várias instâncias
 * do Worker podem existir ao mesmo tempo, então o cache não pode ser longo.
 */
export class SettingsService {
  private cache: { value: GlobalSettings; at: number } | null = null;
  constructor(
    private db: Db,
    private storageLimitGbDefault: number,
  ) {}

  private complete(v: z.infer<typeof globalSettingsSchema>): GlobalSettings {
    return { ...v, storageLimitGb: v.storageLimitGb ?? this.storageLimitGbDefault };
  }

  async get(): Promise<GlobalSettings> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.value;
    const row = await this.db.first<{ value: string }>('SELECT "value" FROM "AppSetting" WHERE "key" = ?', KEY);
    let raw: unknown = {};
    try {
      raw = row ? JSON.parse(row.value) : {};
    } catch {
      raw = {};
    }
    const parsed = globalSettingsSchema.safeParse(raw);
    const value = this.complete(parsed.success ? parsed.data : globalSettingsSchema.parse({}));
    this.cache = { value, at: Date.now() };
    return value;
  }

  async update(patch: Partial<GlobalSettings>, userId?: string) {
    const current = await this.get();
    const next = this.complete(globalSettingsSchema.parse({ ...current, ...patch }));
    await this.db.run(
      `INSERT INTO "AppSetting" ("key", "value", "updatedAt", "updatedById") VALUES (?, ?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt", "updatedById" = excluded."updatedById"`,
      KEY,
      JSON.stringify(next),
      now(),
      userId ?? null,
    );
    this.cache = { value: next, at: Date.now() };
    return next;
  }
}
