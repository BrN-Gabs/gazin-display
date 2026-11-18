import type { Hono } from 'hono';
import { z } from 'zod';
import { clientIp, requirePublisher, requireUser, type HonoEnv } from '../auth';
import { mapPlaylist, mapVersion, now, placeholders, uuid, type VersionRow } from '../db';
import { parse } from '../lib/http';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { parsePlaylistSettings, playlistSettingsSchema } from '../services/playlists';
import { AuditActions } from '../services/audit';
import { mediaDto } from './media';
import { SocketEvents, type VersionSnapshot } from '../../shared/types';
import { readBody } from './util';

const itemsSchema = z
  .array(
    z.object({
      id: z.string().uuid().optional(),
      mediaId: z.string().uuid(),
      durationSec: z.number().int().min(1).max(86400).nullable().optional(),
    }),
  )
  .max(1000);

const versionDto = (v: VersionRow & { publishedByName?: string | null }) => ({
  id: v.id,
  number: v.number,
  publishedAt: v.publishedAt,
  itemCount: v.itemCount,
  totalDurationMs: v.totalDurationMs ?? null,
  totalBytes: v.totalBytes ?? null,
  sourceRevision: v.sourceRevision,
  publishedBy: v.publishedByName ?? null,
});

const VERSION_SELECT = `SELECT v."id", v."playlistId", v."number", v."sourceRevision", v."itemCount", v."totalDurationMs", v."totalBytes", v."publishedAt", v."publishedById", '[]' AS "mediaIds", '{}' AS "snapshot", u."name" AS "publishedByName"
  FROM "PlaylistVersion" v LEFT JOIN "User" u ON u."id" = v."publishedById"`;
const mapVersionLite = (r: Record<string, unknown>) => ({ ...mapVersion(r), publishedByName: (r.publishedByName as string) ?? null });

export function playlistRoutes(app: Hono<HonoEnv>) {
  app.get('/api/playlists', requireUser, async (c) => {
    const { db, settings } = c.var.ctx;
    const global = await settings.get();
    const [rows, counts, latest, devices, thumbs] = await Promise.all([
      db.all(`SELECT p.*, u."name" AS "createdByName" FROM "Playlist" p LEFT JOIN "User" u ON u."id" = p."createdById" ORDER BY p."updatedAt" DESC`),
      db.all<{ id: string; items: number; schedules: number }>(
        `SELECT p."id", (SELECT COUNT(*) FROM "PlaylistItem" i WHERE i."playlistId" = p."id") AS "items", (SELECT COUNT(*) FROM "Schedule" s WHERE s."playlistId" = p."id") AS "schedules" FROM "Playlist" p`,
      ),
      db.all(`${VERSION_SELECT} WHERE v."number" = (SELECT MAX(x."number") FROM "PlaylistVersion" x WHERE x."playlistId" = v."playlistId")`),
      db.all<{ id: string; name: string; playlistId: string }>('SELECT "id", "name", "playlistId" FROM "DisplayDevice" WHERE "playlistId" IS NOT NULL'),
      db.all<{ playlistId: string; position: number; id: string; thumbnailKey: string | null; updatedAt: string }>(
        `SELECT i."playlistId", i."position", m."id", m."thumbnailKey", m."updatedAt" FROM "PlaylistItem" i JOIN "Media" m ON m."id" = i."mediaId"
         WHERE (SELECT COUNT(*) FROM "PlaylistItem" o WHERE o."playlistId" = i."playlistId" AND o."position" < i."position") < 4 ORDER BY i."playlistId", i."position"`,
      ),
    ]);
    const countMap = new Map(counts.map((x) => [x.id, x]));
    const latestMap = new Map(latest.map((r) => [r.playlistId as string, mapVersionLite(r)]));
    return c.json({
      playlists: rows.map((r) => {
        const p = mapPlaylist(r);
        const lv = latestMap.get(p.id);
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          revision: p.revision,
          itemCount: countMap.get(p.id)?.items ?? 0,
          scheduleCount: countMap.get(p.id)?.schedules ?? 0,
          settings: parsePlaylistSettings(p.settings, global),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          createdBy: (r.createdByName as string) ?? null,
          latestVersion: lv ? versionDto(lv) : null,
          hasUnpublishedChanges: !lv || lv.sourceRevision !== p.revision,
          devices: devices.filter((d) => d.playlistId === p.id).map((d) => ({ id: d.id, name: d.name })),
          thumbnails: thumbs
            .filter((t) => t.playlistId === p.id && t.thumbnailKey)
            .map((t) => `/api/media/${t.id}/thumbnail?v=${new Date(t.updatedAt).getTime()}`),
        };
      }),
    });
  });

  app.post('/api/playlists', requireUser, async (c) => {
    const { db, settings, audit } = c.var.ctx;
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional() }), await readBody(c));
    const global = await settings.get();
    const id = uuid();
    const ts = now();
    await db.run(
      'INSERT INTO "Playlist" ("id", "name", "description", "settings", "revision", "createdById", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      id,
      body.name,
      body.description || null,
      JSON.stringify({ loop: global.loop, audio: global.audio, fitMode: global.fitMode, imageDurationSec: null, fallbackMediaId: null }),
      c.var.user.id,
      ts,
      ts,
    );
    await audit.record({ action: AuditActions.PlaylistCreated, userId: c.var.user.id, entityType: 'playlist', entityId: id, summary: `Criou a playlist "${body.name}"`, ip: clientIp(c) });
    return c.json({ playlist: { id } });
  });

  app.get('/api/playlists/:id', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const { db } = ctx;
    const global = await ctx.settings.get();
    const r = await db.first('SELECT * FROM "Playlist" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Playlist não encontrada.');
    const p = mapPlaylist(r);
    const [items, versions, devices, schedules] = await Promise.all([
      ctx.playlists.itemsWithMedia(p.id),
      db.all(`${VERSION_SELECT} WHERE v."playlistId" = ? ORDER BY v."number" DESC LIMIT 30`, p.id),
      db.all<{ id: string; name: string; publishedVersionId: string | null }>('SELECT "id", "name", "publishedVersionId" FROM "DisplayDevice" WHERE "playlistId" = ?', p.id),
      db.all<{ id: string; name: string; device: string }>('SELECT s."id", s."name", d."name" AS "device" FROM "Schedule" s JOIN "DisplayDevice" d ON d."id" = s."deviceId" WHERE s."playlistId" = ?', p.id),
    ]);
    const vs = versions.map(mapVersionLite);
    const latest = vs[0];
    return c.json({
      playlist: {
        id: p.id,
        name: p.name,
        description: p.description,
        revision: p.revision,
        settings: parsePlaylistSettings(p.settings, global),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        items: items.map((i) => ({ id: i.id, position: i.position, durationSec: i.durationSec, media: mediaDto(i.media) })),
        versions: vs.map(versionDto),
        hasUnpublishedChanges: !latest || latest.sourceRevision !== p.revision,
        devices,
        schedules,
      },
      defaults: { imageDurationSec: global.imageDurationSec },
    });
  });

  app.put('/api/playlists/:id', requireUser, async (c) => {
    const { db, audit, realtime } = c.var.ctx;
    const body = parse(
      z.object({
        revision: z.number().int(),
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        settings: playlistSettingsSchema.optional(),
        items: itemsSchema.optional(),
      }),
      await readBody(c),
    );
    const r = await db.first('SELECT * FROM "Playlist" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Playlist não encontrada.');
    const p = mapPlaylist(r);
    const stale = () => conflict('STALE_REVISION', 'Esta playlist foi alterada em outra janela ou por outro usuário. Recarregue para ver a versão atual.', { currentRevision: p.revision });
    if (p.revision !== body.revision) throw stale();
    if (body.settings?.fallbackMediaId) {
      const fm = await db.first<{ type: string }>('SELECT "type" FROM "Media" WHERE "id" = ?', body.settings.fallbackMediaId);
      if (!fm || fm.type !== 'IMAGE') throw badRequest('A mídia de fallback deve ser uma imagem da biblioteca.');
    }
    const newRev = p.revision + 1;
    const ts = now();
    // 1º comando: avança a revisão somente se ainda for a esperada (controle de concorrência otimista).
    // Os demais só têm efeito se a revisão nova for a deste salvamento — tudo na mesma transação (batch).
    const guard = `(SELECT "revision" FROM "Playlist" WHERE "id" = ?) = ?`;
    const stmts = [
      db.prep(
        `UPDATE "Playlist" SET "revision" = ?, "name" = ?, "description" = ?, "settings" = ?, "updatedAt" = ? WHERE "id" = ? AND "revision" = ?`,
        newRev,
        body.name ?? p.name,
        body.description === undefined ? p.description : body.description,
        body.settings ? JSON.stringify(body.settings) : JSON.stringify(p.settings ?? {}),
        ts,
        p.id,
        p.revision,
      ),
    ];
    if (body.items) {
      const mediaIds = [...new Set(body.items.map((i) => i.mediaId))];
      const found = mediaIds.length
        ? await db.all<{ id: string; type: string }>(`SELECT "id", "type" FROM "Media" WHERE "id" IN (${placeholders(mediaIds.length)})`, ...mediaIds)
        : [];
      if (found.length !== mediaIds.length) throw badRequest('Uma ou mais mídias não existem mais na biblioteca.');
      const types = new Map(found.map((m) => [m.id, m.type]));
      const existing = new Set((await db.all<{ id: string }>('SELECT "id" FROM "PlaylistItem" WHERE "playlistId" = ?', p.id)).map((e) => e.id));
      const keep = [...new Set(body.items.filter((i) => i.id && existing.has(i.id)).map((i) => i.id!))];
      stmts.push(
        db.prep(
          `DELETE FROM "PlaylistItem" WHERE "playlistId" = ? ${keep.length ? `AND "id" NOT IN (${placeholders(keep.length)})` : ''} AND ${guard}`,
          p.id,
          ...keep,
          p.id,
          newRev,
        ),
      );
      const kept = new Set<string>();
      for (const [position, it] of body.items.entries()) {
        const durationSec = types.get(it.mediaId) === 'IMAGE' ? (it.durationSec ?? null) : null;
        if (it.id && existing.has(it.id) && !kept.has(it.id)) {
          kept.add(it.id);
          stmts.push(db.prep(`UPDATE "PlaylistItem" SET "position" = ?, "mediaId" = ?, "durationSec" = ? WHERE "id" = ? AND ${guard}`, position, it.mediaId, durationSec, it.id, p.id, newRev));
        } else {
          stmts.push(
            db.prep(`INSERT INTO "PlaylistItem" ("id", "playlistId", "mediaId", "position", "durationSec") SELECT ?, ?, ?, ?, ? WHERE ${guard}`, uuid(), p.id, it.mediaId, position, durationSec, p.id, newRev),
          );
        }
      }
    }
    const res = await db.batch(stmts);
    if ((res[0]?.meta.changes ?? 0) !== 1) {
      const cur = await db.first<{ revision: number }>('SELECT "revision" FROM "Playlist" WHERE "id" = ?', p.id);
      throw conflict('STALE_REVISION', 'Esta playlist foi alterada em outra janela ou por outro usuário. Recarregue para ver a versão atual.', { currentRevision: cur?.revision });
    }
    const name = body.name ?? p.name;
    await audit.record({
      action: AuditActions.PlaylistUpdated,
      userId: c.var.user.id,
      entityType: 'playlist',
      entityId: p.id,
      summary: `Salvou o rascunho de "${name}"`,
      details: { revision: newRev, items: body.items?.length, settingsChanged: !!body.settings },
      ip: clientIp(c),
    });
    realtime.toAdmins(SocketEvents.PlaylistChanged, { id: p.id, revision: newRev });
    return c.json({ revision: newRev });
  });

  app.post('/api/playlists/:id/duplicate', requireUser, async (c) => {
    const { db, audit } = c.var.ctx;
    const r = await db.first('SELECT * FROM "Playlist" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Playlist não encontrada.');
    const src = mapPlaylist(r);
    const items = await db.all<{ mediaId: string; position: number; durationSec: number | null }>(
      'SELECT "mediaId", "position", "durationSec" FROM "PlaylistItem" WHERE "playlistId" = ? ORDER BY "position" ASC',
      src.id,
    );
    const id = uuid();
    const ts = now();
    await db.batch([
      db.prep(
        'INSERT INTO "Playlist" ("id", "name", "description", "settings", "revision", "createdById", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
        id,
        `${src.name} (cópia)`.slice(0, 120),
        src.description,
        JSON.stringify(src.settings ?? {}),
        c.var.user.id,
        ts,
        ts,
      ),
      ...items.map((i) => db.prep('INSERT INTO "PlaylistItem" ("id", "playlistId", "mediaId", "position", "durationSec") VALUES (?, ?, ?, ?, ?)', uuid(), id, i.mediaId, i.position, i.durationSec)),
    ]);
    await audit.record({ action: AuditActions.PlaylistDuplicated, userId: c.var.user.id, entityType: 'playlist', entityId: id, summary: `Duplicou "${src.name}"`, ip: clientIp(c) });
    return c.json({ playlist: { id } });
  });

  app.delete('/api/playlists/:id', requireUser, async (c) => {
    const { db, audit } = c.var.ctx;
    const r = await db.first('SELECT * FROM "Playlist" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Playlist não encontrada.');
    const p = mapPlaylist(r);
    const devices = await db.all<{ name: string }>('SELECT "name" FROM "DisplayDevice" WHERE "playlistId" = ?', p.id);
    if (devices.length) throw conflict('PLAYLIST_IN_USE', `A playlist está publicada em: ${devices.map((d) => d.name).join(', ')}. Publique outra playlist ou desvincule o telão antes.`);
    const schedules = await db.all<{ name: string }>('SELECT "name" FROM "Schedule" WHERE "playlistId" = ?', p.id);
    if (schedules.length) throw conflict('PLAYLIST_SCHEDULED', `A playlist está em agendamentos: ${schedules.map((s) => s.name).join(', ')}. Remova-os antes.`);
    const usedVersion = await db.first<{ name: string }>(
      `SELECT d."name" FROM "DisplayDevice" d WHERE d."reportedVersionId" IN (SELECT "id" FROM "PlaylistVersion" WHERE "playlistId" = ?)
         OR d."effectiveVersionId" IN (SELECT "id" FROM "PlaylistVersion" WHERE "playlistId" = ?) LIMIT 1`,
      p.id,
      p.id,
    );
    if (usedVersion) throw conflict('PLAYLIST_IN_USE', `O telão ${usedVersion.name} ainda está reproduzindo esta playlist.`);
    await db.run('DELETE FROM "Playlist" WHERE "id" = ?', p.id);
    await audit.record({ action: AuditActions.PlaylistDeleted, userId: c.var.user.id, entityType: 'playlist', entityId: p.id, summary: `Excluiu a playlist "${p.name}"`, ip: clientIp(c) });
    return c.json({ ok: true });
  });

  app.post('/api/playlists/:id/publish', requirePublisher, async (c) => {
    const ctx = c.var.ctx;
    const body = parse(
      z.object({
        deviceIds: z.array(z.string().uuid()).max(100).default([]),
        applyMode: z.enum(['next', 'immediate']).default('next'),
        revision: z.number().int().optional(),
      }),
      await readBody(c),
    );
    const version = await ctx.playlists.publish({
      playlistId: c.req.param('id'),
      userId: c.var.user.id,
      deviceIds: body.deviceIds,
      applyMode: body.applyMode,
      expectedRevision: body.revision,
      ip: clientIp(c),
    });
    return c.json({ version: versionDto(version) });
  });

  app.get('/api/versions/:id', requireUser, async (c) => {
    const r = await c.var.ctx.db.first(
      `SELECT v.*, u."name" AS "publishedByName" FROM "PlaylistVersion" v LEFT JOIN "User" u ON u."id" = v."publishedById" WHERE v."id" = ?`,
      c.req.param('id'),
    );
    if (!r) throw notFound('Versão não encontrada.');
    const v = mapVersionLite(r);
    const snapshot = { ...(v.snapshot as object), versionId: v.id, number: v.number, publishedAt: v.publishedAt } as VersionSnapshot;
    return c.json({ version: versionDto(v), snapshot });
  });

  /** Prévia do rascunho atual no formato do player (não publica) */
  app.get('/api/playlists/:id/preview', requireUser, async (c) => {
    const { body } = await c.var.ctx.playlists.buildSnapshot(c.req.param('id')).catch((err: unknown) => {
      if (err instanceof AppError && (err.code === 'BAD_REQUEST' || err.code === 'MEDIA_NOT_READY')) return { body: null };
      throw err;
    });
    return c.json({ snapshot: body ? { ...body, versionId: 'draft', number: 0, publishedAt: new Date().toISOString() } : null });
  });
}
