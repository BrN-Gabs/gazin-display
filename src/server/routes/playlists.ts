import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { Prisma } from '../db.js';
import { num, parse } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parsePlaylistSettings, playlistSettingsSchema } from '../services/playlists.js';
import { AuditActions } from '../services/audit.js';
import { mediaDto } from './media.js';
import { SocketEvents, type VersionSnapshot } from '../../shared/types.js';

const itemsSchema = z
  .array(
    z.object({
      id: z.string().uuid().optional(),
      mediaId: z.string().uuid(),
      durationSec: z.number().int().min(1).max(86400).nullable().optional(),
    }),
  )
  .max(1000);

export async function playlistRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, audit, realtime } = ctx;

  const versionDto = (v: { id: string; number: number; publishedAt: Date; itemCount: number; totalDurationMs: bigint; totalBytes: bigint; sourceRevision: number; publishedBy?: { name: string } | null }) => ({
    id: v.id,
    number: v.number,
    publishedAt: v.publishedAt,
    itemCount: v.itemCount,
    totalDurationMs: num(v.totalDurationMs),
    totalBytes: num(v.totalBytes),
    sourceRevision: v.sourceRevision,
    publishedBy: v.publishedBy?.name ?? null,
  });

  app.get('/api/playlists', { preHandler: auth.requireUser }, async () => {
    const global = await ctx.settings.get();
    const playlists = await db.playlist.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { items: true, schedules: true } },
        versions: { orderBy: { number: 'desc' }, take: 1, include: { publishedBy: { select: { name: true } } } },
        devices: { select: { id: true, name: true } },
        items: { orderBy: { position: 'asc' }, take: 4, include: { media: { select: { id: true, thumbnailKey: true, updatedAt: true, type: true, durationMs: true } } } },
        createdBy: { select: { name: true } },
      },
    });
    return {
      playlists: playlists.map((p) => {
        const latest = p.versions[0];
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          revision: p.revision,
          itemCount: p._count.items,
          scheduleCount: p._count.schedules,
          settings: parsePlaylistSettings(p.settings, global),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          createdBy: p.createdBy?.name ?? null,
          latestVersion: latest ? versionDto(latest) : null,
          hasUnpublishedChanges: !latest || latest.sourceRevision !== p.revision,
          devices: p.devices,
          thumbnails: p.items.filter((i) => i.media.thumbnailKey).map((i) => `/api/media/${i.media.id}/thumbnail?v=${i.media.updatedAt.getTime()}`),
        };
      }),
    };
  });

  app.post('/api/playlists', { preHandler: auth.requireUser }, async (req) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional() }), req.body);
    const global = await ctx.settings.get();
    const pl = await db.playlist.create({
      data: {
        name: body.name,
        description: body.description || null,
        createdById: req.user!.id,
        settings: { loop: global.loop, audio: global.audio, fitMode: global.fitMode, imageDurationSec: null, fallbackMediaId: null },
      },
    });
    await audit.record({ action: AuditActions.PlaylistCreated, userId: req.user!.id, entityType: 'playlist', entityId: pl.id, summary: `Criou a playlist "${pl.name}"`, ip: req.ip });
    return { playlist: { id: pl.id } };
  });

  app.get<{ Params: { id: string } }>('/api/playlists/:id', { preHandler: auth.requireUser }, async (req) => {
    const global = await ctx.settings.get();
    const p = await db.playlist.findUnique({
      where: { id: req.params.id },
      include: {
        items: { orderBy: { position: 'asc' }, include: { media: true } },
        versions: { orderBy: { number: 'desc' }, take: 30, include: { publishedBy: { select: { name: true } } } },
        devices: { select: { id: true, name: true, publishedVersionId: true } },
        schedules: { select: { id: true, name: true, device: { select: { name: true } } } },
      },
    });
    if (!p) throw notFound('Playlist não encontrada.');
    const latest = p.versions[0];
    return {
      playlist: {
        id: p.id,
        name: p.name,
        description: p.description,
        revision: p.revision,
        settings: parsePlaylistSettings(p.settings, global),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        items: p.items.map((i) => ({ id: i.id, position: i.position, durationSec: i.durationSec, media: mediaDto(i.media) })),
        versions: p.versions.map(versionDto),
        hasUnpublishedChanges: !latest || latest.sourceRevision !== p.revision,
        devices: p.devices,
        schedules: p.schedules.map((s) => ({ id: s.id, name: s.name, device: s.device.name })),
      },
      defaults: { imageDurationSec: global.imageDurationSec },
    };
  });

  app.put<{ Params: { id: string } }>('/api/playlists/:id', { preHandler: auth.requireUser }, async (req) => {
    const body = parse(
      z.object({
        revision: z.number().int(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        settings: playlistSettingsSchema.optional(),
        items: itemsSchema.optional(),
      }),
      req.body,
    );
    const updated = await db.$transaction(async (tx) => {
      const p = await tx.playlist.findUnique({ where: { id: req.params.id } });
      if (!p) throw notFound('Playlist não encontrada.');
      if (p.revision !== body.revision)
        throw conflict('STALE_REVISION', 'Esta playlist foi alterada em outra janela ou por outro usuário. Recarregue para ver a versão atual.', { currentRevision: p.revision });
      if (body.settings?.fallbackMediaId) {
        const fm = await tx.media.findUnique({ where: { id: body.settings.fallbackMediaId } });
        if (!fm || fm.type !== 'IMAGE') throw badRequest('A mídia de fallback deve ser uma imagem da biblioteca.');
      }
      if (body.items) {
        const mediaIds = [...new Set(body.items.map((i) => i.mediaId))];
        const found = await tx.media.findMany({ where: { id: { in: mediaIds } }, select: { id: true, type: true } });
        if (found.length !== mediaIds.length) throw badRequest('Uma ou mais mídias não existem mais na biblioteca.');
        const types = new Map(found.map((m) => [m.id, m.type]));
        const existing = await tx.playlistItem.findMany({ where: { playlistId: p.id }, select: { id: true } });
        const existingIds = new Set(existing.map((e) => e.id));
        const keep = new Set(body.items.filter((i) => i.id && existingIds.has(i.id)).map((i) => i.id!));
        await tx.playlistItem.deleteMany({ where: { playlistId: p.id, id: { notIn: [...keep] } } });
        for (const [position, it] of body.items.entries()) {
          const durationSec = types.get(it.mediaId) === 'IMAGE' ? (it.durationSec ?? null) : null;
          if (it.id && keep.has(it.id)) await tx.playlistItem.update({ where: { id: it.id }, data: { position, mediaId: it.mediaId, durationSec } });
          else await tx.playlistItem.create({ data: { playlistId: p.id, mediaId: it.mediaId, position, durationSec } });
        }
      }
      return tx.playlist.update({
        where: { id: p.id },
        data: {
          name: body.name,
          description: body.description,
          settings: body.settings ? (body.settings as Prisma.InputJsonValue) : undefined,
          revision: { increment: 1 },
        },
      });
    });
    await audit.record({
      action: AuditActions.PlaylistUpdated,
      userId: req.user!.id,
      entityType: 'playlist',
      entityId: updated.id,
      summary: `Salvou o rascunho de "${updated.name}"`,
      details: { revision: updated.revision, items: body.items?.length, settingsChanged: !!body.settings },
      ip: req.ip,
    });
    realtime.toAdmins(SocketEvents.PlaylistChanged, { id: updated.id, revision: updated.revision });
    return { revision: updated.revision };
  });

  app.post<{ Params: { id: string } }>('/api/playlists/:id/duplicate', { preHandler: auth.requireUser }, async (req) => {
    const src = await db.playlist.findUnique({ where: { id: req.params.id }, include: { items: { orderBy: { position: 'asc' } } } });
    if (!src) throw notFound('Playlist não encontrada.');
    const copy = await db.playlist.create({
      data: {
        name: `${src.name} (cópia)`.slice(0, 120),
        description: src.description,
        settings: src.settings as Prisma.InputJsonValue,
        createdById: req.user!.id,
        items: { create: src.items.map((i) => ({ mediaId: i.mediaId, position: i.position, durationSec: i.durationSec })) },
      },
    });
    await audit.record({ action: AuditActions.PlaylistDuplicated, userId: req.user!.id, entityType: 'playlist', entityId: copy.id, summary: `Duplicou "${src.name}"`, ip: req.ip });
    return { playlist: { id: copy.id } };
  });

  app.delete<{ Params: { id: string } }>('/api/playlists/:id', { preHandler: auth.requireUser }, async (req) => {
    const p = await db.playlist.findUnique({ where: { id: req.params.id }, include: { devices: { select: { name: true } }, schedules: { select: { name: true } } } });
    if (!p) throw notFound('Playlist não encontrada.');
    if (p.devices.length) throw conflict('PLAYLIST_IN_USE', `A playlist está publicada em: ${p.devices.map((d) => d.name).join(', ')}. Publique outra playlist ou desvincule o telão antes.`);
    if (p.schedules.length) throw conflict('PLAYLIST_SCHEDULED', `A playlist está em agendamentos: ${p.schedules.map((s) => s.name).join(', ')}. Remova-os antes.`);
    const versionIds = (await db.playlistVersion.findMany({ where: { playlistId: p.id }, select: { id: true } })).map((v) => v.id);
    const usedVersion = await db.displayDevice.findFirst({
      where: { OR: [{ reportedVersionId: { in: versionIds } }, { effectiveVersionId: { in: versionIds } }] },
      select: { name: true },
    });
    if (usedVersion) throw conflict('PLAYLIST_IN_USE', `O telão ${usedVersion.name} ainda está reproduzindo esta playlist.`);
    await db.playlist.delete({ where: { id: p.id } });
    await audit.record({ action: AuditActions.PlaylistDeleted, userId: req.user!.id, entityType: 'playlist', entityId: p.id, summary: `Excluiu a playlist "${p.name}"`, ip: req.ip });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/playlists/:id/publish', { preHandler: auth.requirePublisher }, async (req) => {
    const body = parse(
      z.object({
        deviceIds: z.array(z.string().uuid()).max(100).default([]),
        applyMode: z.enum(['next', 'immediate']).default('next'),
        revision: z.number().int().optional(),
      }),
      req.body,
    );
    const version = await ctx.playlists.publish({
      playlistId: req.params.id,
      userId: req.user!.id,
      deviceIds: body.deviceIds,
      applyMode: body.applyMode,
      expectedRevision: body.revision,
      ip: req.ip,
    });
    return { version: versionDto(version) };
  });

  app.get<{ Params: { id: string } }>('/api/versions/:id', { preHandler: auth.requireUser }, async (req) => {
    const v = await db.playlistVersion.findUnique({ where: { id: req.params.id }, include: { publishedBy: { select: { name: true } } } });
    if (!v) throw notFound('Versão não encontrada.');
    const snapshot = { ...(v.snapshot as object), versionId: v.id, number: v.number, publishedAt: v.publishedAt.toISOString() } as VersionSnapshot;
    return { version: versionDto(v), snapshot };
  });

  /** Prévia do rascunho atual no formato do player (não publica) */
  app.get<{ Params: { id: string } }>('/api/playlists/:id/preview', { preHandler: auth.requireUser }, async (req) => {
    const { body } = await ctx.playlists.buildSnapshot(req.params.id).catch((err) => {
      if (err?.code === 'BAD_REQUEST' || err?.code === 'MEDIA_NOT_READY') return { body: null };
      throw err;
    });
    return { snapshot: body ? { ...body, versionId: 'draft', number: 0, publishedAt: new Date().toISOString() } : null };
  });
}
