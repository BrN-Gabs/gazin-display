import { z } from 'zod';
import type { AppContext } from '../context';
import { mapMedia, mapPlaylist, mapVersion, now, placeholders, uuid, type MediaRow, type VersionRow } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { ApplyMode, PlaylistSettings, SnapshotItem, VersionSnapshot } from '../../shared/types';
import type { GlobalSettings } from './settings';
import { AuditActions } from './audit';
import { SocketEvents } from '../../shared/types';

export const playlistSettingsSchema = z.object({
  loop: z.boolean(),
  audio: z.boolean(),
  fitMode: z.enum(['contain', 'cover']),
  imageDurationSec: z.number().int().min(1).max(86400).nullable(),
  fallbackMediaId: z.string().uuid().nullable(),
});

export function parsePlaylistSettings(raw: unknown, global: GlobalSettings): PlaylistSettings {
  const r = (raw ?? {}) as Partial<PlaylistSettings>;
  return {
    loop: typeof r.loop === 'boolean' ? r.loop : global.loop,
    audio: typeof r.audio === 'boolean' ? r.audio : global.audio,
    fitMode: r.fitMode === 'cover' || r.fitMode === 'contain' ? r.fitMode : global.fitMode,
    imageDurationSec: typeof r.imageDurationSec === 'number' ? r.imageDurationSec : null,
    fallbackMediaId: typeof r.fallbackMediaId === 'string' ? r.fallbackMediaId : null,
  };
}

type SnapshotBody = Omit<VersionSnapshot, 'versionId' | 'number' | 'publishedAt'>;

function mediaToItem(m: MediaRow, itemId: string, imageMs: number, custom: number | null): SnapshotItem {
  return {
    itemId,
    mediaId: m.id,
    type: m.type === 'IMAGE' ? 'image' : 'video',
    name: m.name,
    mimeType: m.mimeType,
    sizeBytes: Number(m.sizeBytes),
    checksum: m.checksum ?? '',
    durationMs: m.type === 'IMAGE' ? (custom ? custom * 1000 : imageMs) : (m.durationMs ?? 0),
    width: m.width,
    height: m.height,
    ...(m.type === 'IMAGE' ? { customDuration: !!custom } : {}),
  };
}

export class PlaylistService {
  constructor(private ctx: AppContext) {}

  /** Itens do rascunho (ordem de exibição) com a mídia de cada um */
  async itemsWithMedia(playlistId: string) {
    const rows = await this.ctx.db.all<Record<string, unknown>>(
      `SELECT i."id" AS "_itemId", i."position" AS "_position", i."durationSec" AS "_durationSec", m.*
       FROM "PlaylistItem" i JOIN "Media" m ON m."id" = i."mediaId"
       WHERE i."playlistId" = ? ORDER BY i."position" ASC`,
      playlistId,
    );
    return rows.map((r) => ({
      id: r._itemId as string,
      position: r._position as number,
      durationSec: (r._durationSec as number | null) ?? null,
      media: mapMedia(r),
    }));
  }

  /** Monta o snapshot imutável a partir do rascunho salvo */
  async buildSnapshot(playlistId: string) {
    const global = await this.ctx.settings.get();
    const plRow = await this.ctx.db.first('SELECT * FROM "Playlist" WHERE "id" = ?', playlistId);
    if (!plRow) throw notFound('Playlist não encontrada.');
    const pl = mapPlaylist(plRow);
    const items = await this.itemsWithMedia(pl.id);
    if (!items.length) throw badRequest('A playlist está vazia. Adicione ao menos uma mídia antes de publicar.');
    const notReady = items.filter((i) => i.media.status !== 'READY' || !i.media.storageKey);
    if (notReady.length)
      throw conflict('MEDIA_NOT_READY', 'Há mídias ainda em processamento ou com falha nesta playlist.', {
        media: notReady.map((i) => ({ id: i.media.id, name: i.media.name, status: i.media.status })),
      });
    const settings = parsePlaylistSettings(pl.settings, global);
    const imageMs = (settings.imageDurationSec ?? global.imageDurationSec) * 1000;
    const snapItems = items.map((i) => mediaToItem(i.media, i.id, imageMs, i.durationSec));
    let fallback: SnapshotItem | null = null;
    if (settings.fallbackMediaId) {
      const fr = await this.ctx.db.first('SELECT * FROM "Media" WHERE "id" = ?', settings.fallbackMediaId);
      const fm = fr ? mapMedia(fr) : null;
      if (fm && fm.status === 'READY' && fm.type === 'IMAGE') fallback = mediaToItem(fm, `fallback-${fm.id}`, imageMs, null);
    }
    const body: SnapshotBody = {
      playlistId: pl.id,
      playlistName: pl.name,
      settings: { loop: settings.loop, audio: settings.audio, fitMode: settings.fitMode, imageDurationMs: imageMs },
      fallback,
      items: snapItems,
    };
    const all = [...snapItems, ...(fallback ? [fallback] : [])];
    const mediaIds = [...new Set(all.map((i) => i.mediaId))];
    const totalBytes = mediaIds.reduce((sum, id) => sum + (all.find((i) => i.mediaId === id)?.sizeBytes ?? 0), 0);
    const totalDurationMs = snapItems.reduce((s, i) => s + i.durationMs, 0);
    return { playlist: pl, body, mediaIds, totalBytes, totalDurationMs };
  }

  /**
   * Publica o rascunho atual como nova versão imutável e (opcionalmente) atribui a telões.
   * Concorrência: o número da versão é calculado no próprio INSERT (MAX + 1, atômico no D1),
   * e a gravação só acontece se a revisão do rascunho ainda for a usada no snapshot.
   */
  async publish(opts: { playlistId: string; userId: string; deviceIds: string[]; applyMode: ApplyMode; expectedRevision?: number; ip?: string }): Promise<VersionRow> {
    const { db } = this.ctx;
    const deviceIds = [...new Set(opts.deviceIds)];
    for (let attempt = 1; ; attempt++) {
      const { playlist, body, mediaIds, totalBytes, totalDurationMs } = await this.buildSnapshot(opts.playlistId);
      if (opts.expectedRevision !== undefined && playlist.revision !== opts.expectedRevision)
        throw conflict('STALE_REVISION', 'A playlist foi alterada por outra pessoa. Recarregue antes de publicar.', { currentRevision: playlist.revision });
      if (deviceIds.length) {
        const found = await db.first<{ n: number }>(`SELECT COUNT(*) AS "n" FROM "DisplayDevice" WHERE "id" IN (${placeholders(deviceIds.length)})`, ...deviceIds);
        if ((found?.n ?? 0) !== deviceIds.length) throw notFound('Telão não encontrado.');
      }
      const versionId = uuid();
      const ts = now();
      const stmts = [
        db.prep(
          `INSERT INTO "PlaylistVersion" ("id", "playlistId", "number", "snapshot", "sourceRevision", "itemCount", "totalDurationMs", "totalBytes", "publishedAt", "publishedById", "mediaIds")
           SELECT ?, ?, COALESCE((SELECT MAX("number") FROM "PlaylistVersion" WHERE "playlistId" = ?), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT "revision" FROM "Playlist" WHERE "id" = ?) = ?`,
          versionId,
          playlist.id,
          playlist.id,
          JSON.stringify(body),
          playlist.revision,
          body.items.length,
          totalDurationMs,
          totalBytes,
          ts,
          opts.userId,
          JSON.stringify(mediaIds),
          playlist.id,
          playlist.revision,
        ),
      ];
      if (deviceIds.length)
        stmts.push(
          db.prep(
            `UPDATE "DisplayDevice" SET "playlistId" = ?, "publishedVersionId" = ?, "applyMode" = ?, "updatedAt" = ?
             WHERE "id" IN (${placeholders(deviceIds.length)}) AND EXISTS (SELECT 1 FROM "PlaylistVersion" WHERE "id" = ?)`,
            playlist.id,
            versionId,
            opts.applyMode,
            ts,
            ...deviceIds,
            versionId,
          ),
        );
      let inserted = false;
      try {
        const res = await db.batch(stmts);
        inserted = (res[0]?.meta.changes ?? 0) === 1;
      } catch (err) {
        if (String(err).includes('UNIQUE') && attempt < 5) continue;
        throw err;
      }
      if (!inserted) {
        // o rascunho mudou entre a leitura e a gravação
        if (opts.expectedRevision !== undefined || attempt >= 5)
          throw conflict('STALE_REVISION', 'A playlist foi alterada por outra pessoa. Recarregue antes de publicar.');
        continue;
      }
      const version = mapVersion((await db.first('SELECT * FROM "PlaylistVersion" WHERE "id" = ?', versionId))!);

      // telões padrão + qualquer telão cujo agendamento aponte para esta playlist
      await this.ctx.devices.recomputeAll();
      await this.ctx.audit.record({
        action: AuditActions.PlaylistPublished,
        userId: opts.userId,
        entityType: 'playlist',
        entityId: playlist.id,
        summary: `Publicou "${playlist.name}" (versão ${version.number})${deviceIds.length ? ` em ${deviceIds.length} telão(ões)` : ''}`,
        details: { versionId: version.id, number: version.number, deviceIds, applyMode: opts.applyMode, items: version.itemCount },
        ip: opts.ip,
      });
      this.ctx.realtime.toAdmins(SocketEvents.Published, { playlistId: playlist.id, versionId: version.id, number: version.number });
      return version;
    }
  }
}
