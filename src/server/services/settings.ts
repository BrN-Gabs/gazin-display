import { z } from 'zod';
import type { Db } from '../db.js';
import { DEFAULT_IMAGE_DURATION_SEC } from '../../shared/types.js';

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
});

export type GlobalSettings = z.infer<typeof globalSettingsSchema>;

const KEY = 'global';

export class SettingsService {
  private cache: GlobalSettings | null = null;
  constructor(private db: Db) {}

  async get(): Promise<GlobalSettings> {
    if (this.cache) return this.cache;
    const row = await this.db.appSetting.findUnique({ where: { key: KEY } });
    const parsed = globalSettingsSchema.safeParse(row?.value ?? {});
    this.cache = parsed.success ? parsed.data : globalSettingsSchema.parse({});
    return this.cache;
  }

  async update(patch: Partial<GlobalSettings>, userId?: string) {
    const current = await this.get();
    const next = globalSettingsSchema.parse({ ...current, ...patch });
    await this.db.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: next, updatedById: userId },
      update: { value: next, updatedById: userId },
    });
    this.cache = next;
    return next;
  }
}
