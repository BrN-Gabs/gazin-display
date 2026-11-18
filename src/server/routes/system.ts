import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Prisma } from '../db.js';
import { num, parse } from '../lib/http.js';
import { globalSettingsSchema } from '../services/settings.js';
import { AuditActions } from '../services/audit.js';

const startedAt = Date.now();

export async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, audit, settings, realtime, devices } = ctx;

  // ---------------- Health checks ----------------
  app.get('/api/health/live', async () => ({ status: 'ok' }));

  app.get('/api/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    try {
      await db.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    checks.storage = ctx.storage.name;
    checks.ffmpeg = ctx.processor.bins.ffmpeg ? 'ok' : 'missing';
    const ok = checks.database === 'ok';
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', uptimeSec: Math.round((Date.now() - startedAt) / 1000), checks };
  });

  // ---------------- Configurações ----------------
  app.get('/api/settings', { preHandler: auth.requireUser }, async () => ({
    settings: await settings.get(),
    system: {
      storageDriver: ctx.storage.name,
      maxUploadMbEnv: ctx.config.MAX_UPLOAD_MB,
      chunkMb: ctx.config.UPLOAD_CHUNK_MB,
      ffmpeg: !!ctx.processor.bins.ffmpeg,
      timezone: ctx.config.timezone,
      sessionTtlHours: ctx.config.SESSION_TTL_HOURS,
      deviceTokenTtlDays: ctx.config.DEVICE_TOKEN_TTL_DAYS,
    },
  }));

  app.put('/api/settings', { preHandler: auth.requireAdmin }, async (req) => {
    const patch = parse(globalSettingsSchema.partial(), req.body);
    const before = await settings.get();
    const next = await settings.update(patch, req.user!.id);
    const changed = Object.keys(patch).filter((k) => before[k as keyof typeof before] !== next[k as keyof typeof next]);
    await audit.record({ action: AuditActions.SettingsUpdated, userId: req.user!.id, entityType: 'settings', summary: `Alterou configurações: ${changed.join(', ') || 'nenhuma mudança'}`, details: patch, ip: req.ip });
    // configurações globais afetam o manifest (ex.: comportamento sem conteúdo)
    for (const d of await db.displayDevice.findMany({ select: { id: true } })) await devices.notify(d.id).catch(() => {});
    return { settings: next };
  });

  // ---------------- Histórico ----------------
  app.get('/api/audit', { preHandler: auth.requireUser }, async (req) => {
    const q = parse(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        userId: z.string().uuid().optional(),
        deviceId: z.string().uuid().optional(),
        action: z.string().max(60).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const where: Prisma.AuditLogWhereInput = {
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.deviceId ? { deviceId: q.deviceId } : {}),
      ...(q.action ? (q.action.endsWith('.') ? { action: { startsWith: q.action } } : { action: q.action }) : {}),
      ...(q.from || q.to
        ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00-03:00`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999-03:00`) } : {}) } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { user: { select: { name: true } }, device: { select: { name: true } } },
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        summary: r.summary,
        details: r.details,
        createdAt: r.createdAt,
        user: r.user?.name ?? null,
        device: r.device?.name ?? null,
        ip: req.user!.role === 'ADMIN' ? r.ip : null,
      })),
    };
  });

  // ---------------- Visão geral ----------------
  app.get('/api/dashboard', { preHandler: auth.requireUser }, async () => {
    const [deviceList, mediaByType, storageAgg, transcodedAgg, recentMedia, recentVersions, recentAudit, playlistCount] = await Promise.all([
      db.displayDevice.findMany({ orderBy: { createdAt: 'asc' }, include: { playlist: { select: { id: true, name: true } } } }),
      db.media.groupBy({ by: ['type'], _count: { _all: true }, where: { status: 'READY' } }),
      db.media.aggregate({ _sum: { sizeBytes: true } }),
      db.media.aggregate({ _sum: { originalSize: true }, where: { transcoded: true } }),
      db.media.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: { uploadedBy: { select: { name: true } } } }),
      db.playlistVersion.findMany({ orderBy: { publishedAt: 'desc' }, take: 6, include: { playlist: { select: { id: true, name: true } }, publishedBy: { select: { name: true } } } }),
      db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10, include: { user: { select: { name: true } }, device: { select: { name: true } } } }),
      db.playlist.count(),
    ]);
    const versionIds = deviceList.flatMap((d) => [d.effectiveVersionId, d.reportedVersionId]).filter((x): x is string => !!x);
    const versions = new Map(
      (await db.playlistVersion.findMany({ where: { id: { in: versionIds } }, include: { playlist: { select: { id: true, name: true } } } })).map((v) => [v.id, v]),
    );
    const devicesOut = await Promise.all(
      deviceList.map(async (d) => {
        const ev = d.effectiveVersionId ? versions.get(d.effectiveVersionId) : undefined;
        const live = realtime.liveState(d.id);
        return {
          id: d.id,
          name: d.name,
          location: d.location,
          connection: await devices.connectionOf(d),
          lastSeenAt: d.lastSeenAt,
          effectiveVersion: ev ? { id: ev.id, number: ev.number, itemCount: ev.itemCount, playlistId: ev.playlist.id, playlistName: ev.playlist.name } : null,
          effectiveSource: d.effectiveSource,
          inSync: d.effectiveVersionId === d.reportedVersionId,
          state: live?.state ?? d.lastState ?? null,
          stateAt: live?.at ?? d.lastSeenAt,
          lastError: d.lastError,
        };
      }),
    );
    const images = mediaByType.find((m) => m.type === 'IMAGE')?._count._all ?? 0;
    const videos = mediaByType.find((m) => m.type === 'VIDEO')?._count._all ?? 0;
    return {
      stats: {
        devicesOnline: devicesOut.filter((d) => d.connection === 'online').length,
        devicesTotal: devicesOut.length,
        mediaImages: images,
        mediaVideos: videos,
        playlists: playlistCount,
        storageBytes: (num(storageAgg._sum.sizeBytes) ?? 0) + (num(transcodedAgg._sum.originalSize) ?? 0),
      },
      devices: devicesOut,
      recentMedia: recentMedia.map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type === 'IMAGE' ? 'image' : 'video',
        status: m.status.toLowerCase(),
        createdAt: m.createdAt,
        uploadedBy: m.uploadedBy?.name ?? null,
        thumbnailUrl: m.thumbnailKey ? `/api/media/${m.id}/thumbnail?v=${m.updatedAt.getTime()}` : null,
      })),
      recentPublications: recentVersions.map((v) => ({ id: v.id, number: v.number, itemCount: v.itemCount, publishedAt: v.publishedAt, playlist: v.playlist, publishedBy: v.publishedBy?.name ?? null })),
      recentActivity: recentAudit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, createdAt: a.createdAt, user: a.user?.name ?? null, device: a.device?.name ?? null })),
    };
  });
}
