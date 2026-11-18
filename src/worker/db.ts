/**
 * Acesso ao Cloudflare D1. Substitui o Prisma da versão 1: consultas SQL explícitas
 * (leves em CPU, importante no limite do plano gratuito) e conversão das linhas
 * para os mesmos formatos usados pelas rotas (booleanos, JSON, datas ISO).
 *
 * O D1 não tem transações interativas: operações que precisam ser atômicas usam
 * `batch()` (executado como uma única transação) com condições de guarda no SQL.
 */
export type Param = string | number | boolean | null | undefined;

export class Db {
  constructor(public readonly d1: D1Database) {}

  prep(sql: string, ...params: Param[]): D1PreparedStatement {
    const stmt = this.d1.prepare(sql);
    return params.length ? stmt.bind(...params.map(norm)) : stmt;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]> {
    return (await this.prep(sql, ...params).all<T>()).results ?? [];
  }

  async first<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | null> {
    return (await this.prep(sql, ...params).first<T>()) ?? null;
  }

  async run(sql: string, ...params: Param[]) {
    return this.prep(sql, ...params).run();
  }

  /** Executa em uma única transação (se um comando falhar, nada é aplicado) */
  async batch(stmts: D1PreparedStatement[]) {
    if (!stmts.length) return [];
    return this.d1.batch(stmts);
  }
}

function norm(v: Param): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const bool = (v: unknown) => v === 1 || v === true || v === '1';
export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
export const toJson = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
/** "?, ?, ?" para cláusulas IN */
export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ---------------- Linhas tipadas ----------------

export interface UserRow {
  id: string;
  name: string;
  email: string;
  username: string | null;
  passwordHash: string;
  role: 'ADMIN' | 'EDITOR';
  canPublish: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
}
export const mapUser = (r: Record<string, unknown>): UserRow => ({ ...(r as unknown as UserRow), canPublish: bool(r.canPublish), active: bool(r.active) });

export interface MediaRow {
  id: string;
  name: string;
  description: string | null;
  originalFilename: string;
  type: 'IMAGE' | 'VIDEO';
  status: 'PROCESSING' | 'READY' | 'FAILED';
  mimeType: string;
  sizeBytes: number;
  originalSize: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  checksum: string | null;
  storageKey: string | null;
  originalKey: string | null;
  thumbnailKey: string | null;
  previewKey: string | null;
  transcoded: boolean;
  error: string | null;
  uploadedById: string | null;
  createdAt: string;
  updatedAt: string;
}
export const mapMedia = (r: Record<string, unknown>): MediaRow => ({ ...(r as unknown as MediaRow), transcoded: bool(r.transcoded) });

export interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  settings: unknown;
  revision: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}
export const mapPlaylist = (r: Record<string, unknown>): PlaylistRow => ({ ...(r as unknown as PlaylistRow), settings: json(r.settings, {}) });

export interface VersionRow {
  id: string;
  playlistId: string;
  number: number;
  snapshot: unknown;
  sourceRevision: number;
  itemCount: number;
  totalDurationMs: number;
  totalBytes: number;
  publishedAt: string;
  publishedById: string | null;
  mediaIds: string[];
}
export const mapVersion = (r: Record<string, unknown>): VersionRow => ({
  ...(r as unknown as VersionRow),
  snapshot: json(r.snapshot, {}),
  mediaIds: json<string[]>(r.mediaIds, []),
});

export interface DeviceRow {
  id: string;
  name: string;
  identifier: string;
  location: string | null;
  settings: unknown;
  playlistId: string | null;
  publishedVersionId: string | null;
  applyMode: string;
  effectiveVersionId: string | null;
  effectiveSource: string | null;
  reportedVersionId: string | null;
  lastState: unknown;
  lastError: string | null;
  lastSeenAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export const mapDevice = (r: Record<string, unknown>): DeviceRow => ({
  ...(r as unknown as DeviceRow),
  settings: json(r.settings, {}),
  lastState: json(r.lastState, null),
});

export interface ScheduleRow {
  id: string;
  name: string;
  deviceId: string;
  playlistId: string;
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priority: number;
  enabled: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}
export const mapSchedule = (r: Record<string, unknown>): ScheduleRow => ({
  ...(r as unknown as ScheduleRow),
  daysOfWeek: json<number[]>(r.daysOfWeek, []),
  enabled: bool(r.enabled),
});
