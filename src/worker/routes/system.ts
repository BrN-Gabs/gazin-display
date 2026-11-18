import type { Hono } from 'hono';
import { z } from 'zod';
import { clientIp, requireAdmin, requireUser, type HonoEnv } from '../auth';
import { json, mapDevice, placeholders } from '../db';
import { parse } from '../lib/http';
import { globalSettingsSchema } from '../services/settings';
import { AuditActions } from '../services/audit';
import { storageUsage } from './media';
import { queryObject, readBody } from './util';

export function systemRoutes(app: Hono<HonoEnv>) {
  // ---------------- Health checks ----------------
  app.get('/api/health/live', (c) => c.json({ status: 'ok' }));

  app.get('/api/health', async (c) => {
    const ctx = c.var.ctx;
    const checks: Record<string, string> = {};
    try {
      await ctx.db.first('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    checks.storage = 'r2';
    checks.upload = ctx.config.directUpload ? 'direct' : 'proxy';
    const ok = checks.database === 'ok';
    return c.json({ status: ok ? 'ok' : 'degraded', checks }, ok ? 200 : 503);
  });

  // ---------------- Configurações ----------------
  app.get('/api/settings', requireUser, async (c) => {
    const ctx = c.var.ctx;
    return c.json({
      settings: await ctx.settings.get(),
      system: {
        storageDriver: 'r2',
        maxUploadMbEnv: ctx.config.MAX_UPLOAD_MB,
        chunkMb: ctx.config.UPLOAD_CHUNK_MB,
        ffmpeg: false,
        directUpload: ctx.config.directUpload,
        storage: await storageUsage(ctx),
        timezone: ctx.config.timezone,
        sessionTtlHours: ctx.config.SESSION_TTL_HOURS,
        deviceTokenTtlDays: ctx.config.DEVICE_TOKEN_TTL_DAYS,
      },
    });
  });

  app.put('/api/settings', requireAdmin, async (c) => {
    const ctx = c.var.ctx;
    const patch = parse(globalSettingsSchema.partial(), await readBody(c));
    const before = await ctx.settings.get();
    const next = await ctx.settings.update(patch, c.var.user.id);
    const changed = Object.keys(patch).filter((k) => before[k as keyof typeof before] !== next[k as keyof typeof next]);
    await ctx.audit.record({ action: AuditActions.SettingsUpdated, userId: c.var.user.id, entityType: 'settings', summary: `Alterou configurações: ${changed.join(', ') || 'nenhuma mudança'}`, details: patch, ip: clientIp(c) });
    // configurações globais afetam o manifest (ex.: comportamento sem conteúdo)
    await ctx.devices.notifyAll().catch(() => {});
    return c.json({ settings: next });
  });

  // ---------------- Histórico ----------------
  app.get('/api/audit', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const q = parse(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        userId: z.string().uuid().optional(),
        deviceId: z.string().uuid().optional(),
        action: z.string().max(60).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      queryObject(c),
    );
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.userId) where.push('a."userId" = ?'), params.push(q.userId);
    if (q.deviceId) where.push('a."deviceId" = ?'), params.push(q.deviceId);
    if (q.action) {
      if (q.action.endsWith('.')) where.push('substr(a."action", 1, ?) = ?'), params.push(q.action.length, q.action);
      else where.push('a."action" = ?'), params.push(q.action);
    }
    if (q.from) where.push('a."createdAt" >= ?'), params.push(new Date(`${q.from}T00:00:00-03:00`).toISOString());
    if (q.to) where.push('a."createdAt" <= ?'), params.push(new Date(`${q.to}T23:59:59.999-03:00`).toISOString());
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [totalRow, rows] = await Promise.all([
      ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS "n" FROM "AuditLog" a ${w}`, ...params),
      ctx.db.all<Record<string, unknown>>(
        `SELECT a.*, u."name" AS "userName", d."name" AS "deviceName" FROM "AuditLog" a
         LEFT JOIN "User" u ON u."id" = a."userId" LEFT JOIN "DisplayDevice" d ON d."id" = a."deviceId"
         ${w} ORDER BY a."createdAt" DESC LIMIT ? OFFSET ?`,
        ...params,
        q.pageSize,
        (q.page - 1) * q.pageSize,
      ),
    ]);
    return c.json({
      total: totalRow?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        summary: r.summary,
        details: json(r.details, null),
        createdAt: r.createdAt,
        user: r.userName ?? null,
        device: r.deviceName ?? null,
        ip: c.var.user.role === 'ADMIN' ? r.ip : null,
      })),
    });
  });

  // ---------------- Visão geral ----------------
  app.get('/api/dashboard', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const { db } = ctx;
    const [deviceRows, mediaByType, recentMedia, recentVersions, recentAudit, playlistCount, storage] = await Promise.all([
      db.all('SELECT * FROM "DisplayDevice" ORDER BY "createdAt" ASC'),
      db.all<{ type: string; n: number }>(`SELECT "type", COUNT(*) AS "n" FROM "Media" WHERE "status" = 'READY' GROUP BY "type"`),
      db.all<Record<string, unknown>>(`SELECT m."id", m."name", m."type", m."status", m."createdAt", m."updatedAt", m."thumbnailKey", u."name" AS "uploadedBy" FROM "Media" m LEFT JOIN "User" u ON u."id" = m."uploadedById" ORDER BY m."createdAt" DESC LIMIT 6`),
      db.all<Record<string, unknown>>(
        `SELECT v."id", v."number", v."itemCount", v."publishedAt", p."id" AS "playlistId", p."name" AS "playlistName", u."name" AS "publishedBy"
         FROM "PlaylistVersion" v JOIN "Playlist" p ON p."id" = v."playlistId" LEFT JOIN "User" u ON u."id" = v."publishedById" ORDER BY v."publishedAt" DESC LIMIT 6`,
      ),
      db.all<Record<string, unknown>>(
        `SELECT a."id", a."action", a."summary", a."createdAt", u."name" AS "user", d."name" AS "device" FROM "AuditLog" a
         LEFT JOIN "User" u ON u."id" = a."userId" LEFT JOIN "DisplayDevice" d ON d."id" = a."deviceId" ORDER BY a."createdAt" DESC LIMIT 10`,
      ),
      db.first<{ n: number }>('SELECT COUNT(*) AS "n" FROM "Playlist"'),
      storageUsage(ctx),
    ]);
    const deviceList = deviceRows.map(mapDevice);
    const versionIds = [...new Set(deviceList.flatMap((d) => [d.effectiveVersionId, d.reportedVersionId]).filter((x): x is string => !!x))];
    const [versions, live] = await Promise.all([
      versionIds.length
        ? db.all<{ id: string; number: number; itemCount: number; playlistId: string; playlistName: string }>(
            `SELECT v."id", v."number", v."itemCount", p."id" AS "playlistId", p."name" AS "playlistName" FROM "PlaylistVersion" v JOIN "Playlist" p ON p."id" = v."playlistId" WHERE v."id" IN (${placeholders(versionIds.length)})`,
            ...versionIds,
          )
        : Promise.resolve([]),
      ctx.realtime.live(deviceList.map((d) => d.id)),
    ]);
    const vmap = new Map(versions.map((v) => [v.id, v]));
    const devicesOut = await Promise.all(
      deviceList.map(async (d) => {
        const ev = d.effectiveVersionId ? vmap.get(d.effectiveVersionId) : undefined;
        const l = live[d.id];
        return {
          id: d.id,
          name: d.name,
          location: d.location,
          connection: await ctx.devices.connectionOf(d, l),
          lastSeenAt: d.lastSeenAt,
          effectiveVersion: ev ? { id: ev.id, number: ev.number, itemCount: ev.itemCount, playlistId: ev.playlistId, playlistName: ev.playlistName } : null,
          effectiveSource: d.effectiveSource,
          inSync: d.effectiveVersionId === d.reportedVersionId,
          state: l?.state ?? d.lastState ?? null,
          stateAt: l?.at ?? d.lastSeenAt,
          lastError: d.lastError,
        };
      }),
    );
    const images = mediaByType.find((m) => m.type === 'IMAGE')?.n ?? 0;
    const videos = mediaByType.find((m) => m.type === 'VIDEO')?.n ?? 0;
    return c.json({
      stats: {
        devicesOnline: devicesOut.filter((d) => d.connection === 'online').length,
        devicesTotal: devicesOut.length,
        mediaImages: images,
        mediaVideos: videos,
        playlists: playlistCount?.n ?? 0,
        storageBytes: storage.usedBytes,
        storageLimitBytes: storage.limitBytes,
        storageWarn: storage.warn,
      },
      devices: devicesOut,
      recentMedia: recentMedia.map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type === 'IMAGE' ? 'image' : 'video',
        status: String(m.status).toLowerCase(),
        createdAt: m.createdAt,
        uploadedBy: m.uploadedBy ?? null,
        thumbnailUrl: m.thumbnailKey ? `/api/media/${m.id}/thumbnail?v=${new Date(m.updatedAt as string).getTime()}` : null,
      })),
      recentPublications: recentVersions.map((v) => ({
        id: v.id,
        number: v.number,
        itemCount: v.itemCount,
        publishedAt: v.publishedAt,
        playlist: { id: v.playlistId, name: v.playlistName },
        publishedBy: v.publishedBy ?? null,
      })),
      recentActivity: recentAudit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, createdAt: a.createdAt, user: a.user ?? null, device: a.device ?? null })),
    });
  });
}
