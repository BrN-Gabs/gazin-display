import { z } from 'zod';
import type { AppContext } from '../context.js';
import { Prisma } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import type { ApplyMode, PlaylistSettings, SnapshotItem, VersionSnapshot } from '../../shared/types.js';
import type { GlobalSettings } from './settings.js';
import { AuditActions } from './audit.js';
import { SocketEvents } from '../../shared/types.js';

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

export class PlaylistService {
  constructor(private ctx: AppContext) {}

  private mediaToItem(
    m: { id: string; type: 'IMAGE' | 'VIDEO'; name: string; mimeType: string; sizeBytes: bigint; checksum: string | null; durationMs: number | null; width: number | null; height: number | null },
    itemId: string,
    imageMs: number,
    custom: number | null,
  ): SnapshotItem {
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

  /** Monta o snapshot imutável a partir do rascunho salvo */
  async buildSnapshot(playlistId: string, tx: Prisma.TransactionClient = this.ctx.db) {
    const global = await this.ctx.settings.get();
    const pl = await tx.playlist.findUnique({
      where: { id: playlistId },
      include: { items: { orderBy: { position: 'asc' }, include: { media: true } } },
    });
    if (!pl) throw notFound('Playlist não encontrada.');
    if (!pl.items.length) throw badRequest('A playlist está vazia. Adicione ao menos uma mídia antes de publicar.');
    const notReady = pl.items.filter((i) => i.media.status !== 'READY' || !i.media.storageKey);
    if (notReady.length)
      throw conflict('MEDIA_NOT_READY', 'Há mídias ainda em processamento ou com falha nesta playlist.', {
        media: notReady.map((i) => ({ id: i.media.id, name: i.media.name, status: i.media.status })),
      });
    const settings = parsePlaylistSettings(pl.settings, global);
    const imageMs = (settings.imageDurationSec ?? global.imageDurationSec) * 1000;
    const items = pl.items.map((i) => this.mediaToItem(i.media, i.id, imageMs, i.durationSec));
    let fallback: SnapshotItem | null = null;
    if (settings.fallbackMediaId) {
      const fm = await tx.media.findUnique({ where: { id: settings.fallbackMediaId } });
      if (fm && fm.status === 'READY' && fm.type === 'IMAGE') fallback = this.mediaToItem(fm, `fallback-${fm.id}`, imageMs, null);
    }
    const body: SnapshotBody = {
      playlistId: pl.id,
      playlistName: pl.name,
      settings: { loop: settings.loop, audio: settings.audio, fitMode: settings.fitMode, imageDurationMs: imageMs },
      fallback,
      items,
    };
    const mediaIds = [...new Set([...items.map((i) => i.mediaId), ...(fallback ? [fallback.mediaId] : [])])];
    const totalBytes = mediaIds.reduce((sum, id) => sum + ([...items, ...(fallback ? [fallback] : [])].find((i) => i.mediaId === id)?.sizeBytes ?? 0), 0);
    const totalDurationMs = items.reduce((s, i) => s + i.durationMs, 0);
    return { playlist: pl, body, mediaIds, totalBytes, totalDurationMs };
  }

  /**
   * Publica o rascunho atual como nova versão imutável e (opcionalmente) atribui a telões.
   * Concorrência: número de versão protegido por índice único (playlistId, number) com novas tentativas,
   * e checagem otimista da revisão do rascunho (expectedRevision).
   */
  async publish(opts: { playlistId: string; userId: string; deviceIds: string[]; applyMode: ApplyMode; expectedRevision?: number; ip?: string }) {
    const { db } = this.ctx;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const result = await db.$transaction(
          async (tx) => {
            const { playlist, body, mediaIds, totalBytes, totalDurationMs } = await this.buildSnapshot(opts.playlistId, tx);
            if (opts.expectedRevision !== undefined && playlist.revision !== opts.expectedRevision)
              throw conflict('STALE_REVISION', 'A playlist foi alterada por outra pessoa. Recarregue antes de publicar.', {
                currentRevision: playlist.revision,
              });
            const last = await tx.playlistVersion.findFirst({ where: { playlistId: playlist.id }, orderBy: { number: 'desc' }, select: { number: true } });
            const version = await tx.playlistVersion.create({
              data: {
                playlistId: playlist.id,
                number: (last?.number ?? 0) + 1,
                snapshot: body as unknown as Prisma.InputJsonValue,
                sourceRevision: playlist.revision,
                itemCount: body.items.length,
                totalBytes: BigInt(totalBytes),
                totalDurationMs: BigInt(totalDurationMs),
                publishedById: opts.userId,
                mediaIds,
              },
            });
            if (opts.deviceIds.length) {
              const found = await tx.displayDevice.count({ where: { id: { in: opts.deviceIds } } });
              if (found !== opts.deviceIds.length) throw notFound('Telão não encontrado.');
              await tx.displayDevice.updateMany({
                where: { id: { in: opts.deviceIds } },
                data: { playlistId: playlist.id, publishedVersionId: version.id, applyMode: opts.applyMode },
              });
            }
            return { version, playlist };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 },
        );

        const { version, playlist } = result;
        // devices padrão + qualquer telão cujo agendamento aponte para esta playlist
        await this.ctx.devices.recomputeAll();
        await this.ctx.audit.record({
          action: AuditActions.PlaylistPublished,
          userId: opts.userId,
          entityType: 'playlist',
          entityId: playlist.id,
          summary: `Publicou "${playlist.name}" (versão ${version.number})${opts.deviceIds.length ? ` em ${opts.deviceIds.length} telão(ões)` : ''}`,
          details: { versionId: version.id, number: version.number, deviceIds: opts.deviceIds, applyMode: opts.applyMode, items: version.itemCount },
          ip: opts.ip,
        });
        this.ctx.realtime.toAdmins(SocketEvents.Published, { playlistId: playlist.id, versionId: version.id, number: version.number });
        return version;
      } catch (err) {
        const unique = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (unique && attempt < 5) continue;
        if (err instanceof AppError) throw err;
        throw err;
      }
    }
  }
}
