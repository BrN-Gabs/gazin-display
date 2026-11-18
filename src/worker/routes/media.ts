import type { Hono } from 'hono';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import { clientIp, requireUser, type C, type HonoEnv } from '../auth';
import type { AppContext } from '../context';
import { isUuid, mapMedia, now, uuid, type MediaRow } from '../db';
import { parse, serveObject } from '../lib/http';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { normalizeEtag, presignUploadPart, s3CompleteMultipart } from '../lib/r2';
import { AuditActions } from '../services/audit';
import { ACCEPTED_IMAGE_MIME, ACCEPTED_VIDEO_MIME, SocketEvents, TRANSCODABLE_VIDEO_MIME } from '../../shared/types';
import { queryObject, readBody } from './util';

type MediaWithExtras = MediaRow & { uploadedByName?: string | null; playlistCount?: number | null };

export function mediaDto(m: MediaWithExtras) {
  const v = new Date(m.updatedAt).getTime();
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    originalFilename: m.originalFilename,
    type: m.type === 'IMAGE' ? 'image' : 'video',
    status: m.status.toLowerCase(),
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes ?? null,
    originalSize: m.originalSize ?? null,
    durationMs: m.durationMs,
    width: m.width,
    height: m.height,
    videoCodec: m.videoCodec,
    transcoded: m.transcoded,
    checksum: m.checksum,
    error: m.error,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    uploadedBy: m.uploadedByName ?? null,
    playlistCount: m.playlistCount ?? undefined,
    thumbnailUrl: m.thumbnailKey ? `/api/media/${m.id}/thumbnail?v=${v}` : null,
    previewUrl: m.previewKey ? `/api/media/${m.id}/preview?v=${v}` : null,
    fileUrl: m.storageKey ? `/api/media/${m.id}/file` : null,
  };
}

const MEDIA_SELECT = `SELECT m.*, u."name" AS "uploadedByName", (SELECT COUNT(*) FROM "PlaylistItem" pi WHERE pi."mediaId" = m."id") AS "playlistCount"
  FROM "Media" m LEFT JOIN "User" u ON u."id" = m."uploadedById"`;

const mapMediaFull = (r: Record<string, unknown>): MediaWithExtras => ({ ...mapMedia(r), uploadedByName: (r.uploadedByName as string) ?? null, playlistCount: Number(r.playlistCount ?? 0) });

const IMAGE_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const VIDEO_EXT: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };
const CONVERTIBLE_EXT = /\.(mov|mkv|avi|mpe?g|ts)$/i;
/** Codecs reproduzidos nativamente por Chrome/Edge (o telão) para cada contêiner */
const BROWSER_CODECS: Record<string, string[]> = {
  'video/mp4': ['h264', 'av1'],
  'video/webm': ['vp8', 'vp9', 'av1'],
};
const DERIVATIVE_MAX = 3 * 1024 * 1024;
const MiB = 1024 * 1024;

/** Espaço ocupado: mídias armazenadas + uploads em andamento (reservados) */
export async function storageUsage(ctx: AppContext) {
  const row = await ctx.db.first<{ media: number | null; originals: number | null; reserved: number | null }>(
    `SELECT (SELECT SUM("sizeBytes") FROM "Media") AS "media",
            (SELECT SUM("originalSize") FROM "Media" WHERE "transcoded" = 1) AS "originals",
            (SELECT SUM("totalBytes") FROM "UploadSession" WHERE "status" = 'ACTIVE') AS "reserved"`,
  );
  const settings = await ctx.settings.get();
  const usedBytes = Number(row?.media ?? 0) + Number(row?.originals ?? 0);
  const reservedBytes = Number(row?.reserved ?? 0);
  const limitBytes = Math.floor(settings.storageLimitGb * 1024 * MiB);
  return { usedBytes, reservedBytes, limitBytes, warn: usedBytes >= limitBytes * 0.85 };
}

/** Remove objetos do R2 (silencioso: falha apenas registra no log) */
async function deleteObjects(ctx: AppContext, keys: Array<string | null | undefined>) {
  const list = [...new Set(keys.filter((k): k is string => !!k))];
  if (!list.length) return;
  await ctx.bucket.delete(list).catch((err) => console.warn('falha ao remover arquivos do R2', list, err));
}

interface UploadRow {
  id: string;
  userId: string;
  filename: string;
  declaredMime: string | null;
  totalBytes: number;
  receivedBytes: number;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  mediaId: string | null;
  error: string | null;
  expiresAt: string;
  plannedMediaId: string;
  storageKey: string;
  r2UploadId: string;
  chunkBytes: number;
  checksum: string | null;
  thumbnailKey: string | null;
  previewKey: string | null;
}

const partCount = (s: Pick<UploadRow, 'totalBytes' | 'chunkBytes'>) => Math.max(1, Math.ceil(s.totalBytes / s.chunkBytes));
const partSize = (s: Pick<UploadRow, 'totalBytes' | 'chunkBytes'>, n: number) => (n < partCount(s) ? s.chunkBytes : s.totalBytes - s.chunkBytes * (partCount(s) - 1));

export function mediaRoutes(app: Hono<HonoEnv>) {
  const effectiveMaxBytes = async (ctx: AppContext) => Math.min(ctx.config.maxUploadBytes, (await ctx.settings.get()).maxUploadMb * MiB);

  // ---------------- Biblioteca ----------------

  app.get('/api/media', requireUser, async (c) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(200).optional(),
        type: z.enum(['image', 'video']).optional(),
        status: z.enum(['processing', 'ready', 'failed']).optional(),
        sort: z.enum(['date', 'name', 'size']).default('date'),
        order: z.enum(['asc', 'desc']).optional(),
      }),
      queryObject(c),
    );
    const where: string[] = [];
    const params: string[] = [];
    if (q.type) {
      where.push('m."type" = ?');
      params.push(q.type === 'image' ? 'IMAGE' : 'VIDEO');
    }
    if (q.status) {
      where.push('m."status" = ?');
      params.push(q.status.toUpperCase());
    }
    const order = (q.order ?? (q.sort === 'name' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
    const col = q.sort === 'name' ? 'm."name" COLLATE NOCASE' : q.sort === 'size' ? 'm."sizeBytes"' : 'm."createdAt"';
    let rows = (await c.var.ctx.db.all(`${MEDIA_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${col} ${order} LIMIT 5000`, ...params)).map(mapMediaFull);
    if (q.search) {
      // busca sem diferenciar maiúsculas/minúsculas (inclusive acentuadas), como o ILIKE da versão 1
      const s = q.search.toLocaleLowerCase('pt-BR');
      rows = rows.filter((m) => m.name.toLocaleLowerCase('pt-BR').includes(s) || m.originalFilename.toLocaleLowerCase('pt-BR').includes(s));
    }
    return c.json({ media: rows.slice(0, 1000).map(mediaDto) });
  });

  app.get('/api/media/:id', requireUser, async (c) => {
    const r = await c.var.ctx.db.first(`${MEDIA_SELECT} WHERE m."id" = ?`, c.req.param('id'));
    if (!r) throw notFound('Mídia não encontrada.');
    return c.json({ media: mediaDto(mapMediaFull(r)) });
  });

  app.get('/api/media/:id/usage', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const id = c.req.param('id');
    const playlists = await ctx.db.all<{ id: string; name: string }>(
      'SELECT DISTINCT p."id", p."name" FROM "PlaylistItem" i JOIN "Playlist" p ON p."id" = i."playlistId" WHERE i."mediaId" = ?',
      id,
    );
    const active = (await ctx.devices.mediaInActiveUse()).get(id) ?? [];
    return c.json({ playlists, activeOn: active });
  });

  app.patch('/api/media/:id', requireUser, async (c) => {
    const { db, audit, realtime } = c.var.ctx;
    const body = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(1000).nullable().optional() }), await readBody(c));
    const r = await db.first('SELECT * FROM "Media" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Mídia não encontrada.');
    const m = mapMedia(r);
    await db.run(
      `UPDATE "Media" SET "name" = ?, "description" = ?, "updatedAt" = ? WHERE "id" = ?`,
      body.name ?? m.name,
      body.description === undefined ? m.description : body.description,
      now(),
      m.id,
    );
    const updated = mapMedia((await db.first('SELECT * FROM "Media" WHERE "id" = ?', m.id))!);
    await audit.record({ action: AuditActions.MediaUpdated, userId: c.var.user.id, entityType: 'media', entityId: m.id, summary: `Editou a mídia "${updated.name}"`, details: { from: m.name, to: updated.name }, ip: clientIp(c) });
    realtime.toAdmins(SocketEvents.MediaUpdated, { id: m.id });
    return c.json({ media: mediaDto(updated) });
  });

  app.delete('/api/media/:id', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const { db, audit, realtime } = ctx;
    const r = await db.first('SELECT * FROM "Media" WHERE "id" = ?', c.req.param('id'));
    if (!r) throw notFound('Mídia não encontrada.');
    const m = mapMedia(r);
    if (m.status === 'PROCESSING') throw conflict('MEDIA_PROCESSING', 'Aguarde o fim do processamento para remover esta mídia.');
    const activeOn = (await ctx.devices.mediaInActiveUse()).get(m.id);
    if (activeOn?.length)
      throw conflict('MEDIA_IN_USE', `Esta mídia faz parte da programação publicada (${[...new Set(activeOn)].join(', ')}). Publique uma versão sem ela antes de removê-la.`, { devices: activeOn });
    const fallbackUsers = await db.all<{ id: string; name: string }>(`SELECT "id", "name" FROM "Playlist" WHERE json_extract("settings", '$.fallbackMediaId') = ?`, m.id);
    const refs = await db.all<{ playlistId: string; name: string }>(
      'SELECT i."playlistId", p."name" FROM "PlaylistItem" i JOIN "Playlist" p ON p."id" = i."playlistId" WHERE i."mediaId" = ?',
      m.id,
    );
    const playlists = [...new Map([...refs.map((x) => [x.playlistId, x.name] as const), ...fallbackUsers.map((p) => [p.id, p.name] as const)]).entries()].map(([id, name]) => ({ id, name }));
    if (playlists.length && c.req.query('force') !== 'true')
      throw conflict('MEDIA_IN_DRAFTS', 'Esta mídia está em playlists (rascunho). Confirme para removê-la dessas playlists.', { playlists });

    // Atômico: remove dos rascunhos, renumera posições, limpa fallback e exclui o registro
    const ts = now();
    const affected = [...new Set(refs.map((x) => x.playlistId))];
    const stmts = [db.prep('DELETE FROM "PlaylistItem" WHERE "mediaId" = ?', m.id)];
    for (const pid of affected) {
      stmts.push(
        db.prep(
          `UPDATE "PlaylistItem" SET "position" = (SELECT COUNT(*) FROM "PlaylistItem" o WHERE o."playlistId" = "PlaylistItem"."playlistId" AND o."position" < "PlaylistItem"."position") WHERE "playlistId" = ?`,
          pid,
        ),
        db.prep('UPDATE "Playlist" SET "revision" = "revision" + 1, "updatedAt" = ? WHERE "id" = ?', ts, pid),
      );
    }
    for (const p of fallbackUsers)
      stmts.push(db.prep(`UPDATE "Playlist" SET "settings" = json_set("settings", '$.fallbackMediaId', json('null')), "revision" = "revision" + 1, "updatedAt" = ? WHERE "id" = ?`, ts, p.id));
    stmts.push(db.prep('DELETE FROM "Media" WHERE "id" = ?', m.id));
    await db.batch(stmts);
    // o arquivo só é removido do R2 depois que nenhum registro aponta para ele
    await deleteObjects(ctx, [m.storageKey, m.originalKey, m.thumbnailKey, m.previewKey]);
    await audit.record({
      action: AuditActions.MediaDeleted,
      userId: c.var.user.id,
      entityType: 'media',
      entityId: m.id,
      summary: `Removeu a mídia "${m.name}"`,
      details: { file: m.originalFilename, size: Number(m.sizeBytes), removedFromPlaylists: playlists.map((p) => p.name) },
      ip: clientIp(c),
    });
    realtime.toAdmins(SocketEvents.MediaUpdated, { id: m.id, deleted: true });
    return c.json({ ok: true });
  });

  for (const variant of ['thumbnail', 'preview', 'file'] as const) {
    app.on(['GET', 'HEAD'], `/api/media/:id/${variant}`, requireUser, async (c) => {
      const r = await c.var.ctx.db.first('SELECT * FROM "Media" WHERE "id" = ?', c.req.param('id'));
      if (!r) throw notFound('Mídia não encontrada.');
      const m = mapMedia(r);
      const key = variant === 'thumbnail' ? m.thumbnailKey : variant === 'preview' ? m.previewKey : m.storageKey;
      if (!key) throw notFound('Arquivo ainda não disponível.');
      return serveObject(c.req.raw, c.var.ctx.bucket, key, {
        contentType: variant === 'file' ? m.mimeType : key.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
        size: variant === 'file' ? Number(m.sizeBytes) : undefined,
        cacheControl: variant === 'file' ? 'private, max-age=3600' : 'private, max-age=86400',
        etag: variant === 'file' ? (m.checksum ?? undefined) : `${m.id}-${variant}-${new Date(m.updatedAt).getTime()}`,
        filename: variant === 'file' ? m.originalFilename : undefined,
      });
    });
  }

  // ---------------- Upload em partes direto ao R2 (multipart, retomável) ----------------

  app.get('/api/uploads/config', requireUser, async (c) => {
    const ctx = c.var.ctx;
    return c.json({
      chunkBytes: ctx.config.chunkBytes,
      maxBytes: await effectiveMaxBytes(ctx),
      accept: { image: [...ACCEPTED_IMAGE_MIME], video: [...ACCEPTED_VIDEO_MIME], convertible: [] as string[] },
      ffmpeg: false,
      direct: ctx.config.directUpload,
      storage: await storageUsage(ctx),
    });
  });

  app.post('/api/uploads', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const { db, bucket, config } = ctx;
    const body = parse(
      z.object({
        filename: z.string().trim().min(1).max(255),
        size: z.number().int().positive(),
        mimeType: z.string().max(120).optional(),
        checksum: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
      await readBody(c),
    );
    const max = await effectiveMaxBytes(ctx);
    if (body.size > max) throw new AppError(413, 'FILE_TOO_LARGE', `Arquivo maior que o limite configurado (${Math.round(max / MiB)} MB).`);
    const ext = (/\.([a-z0-9]+)$/i.exec(body.filename)?.[1] ?? '').toLowerCase();
    if (CONVERTIBLE_EXT.test(body.filename))
      throw new AppError(415, 'UNSUPPORTED_FILE', `"${body.filename}" precisa ser convertido para MP4 (H.264) antes do envio: a conversão automática de vídeos não está disponível na versão em nuvem.`);
    const kind = IMAGE_EXT[ext] ? 'image' : VIDEO_EXT[ext] ? 'video' : body.mimeType?.startsWith('image/') ? 'image' : body.mimeType?.startsWith('video/') ? 'video' : null;
    if (!kind) throw new AppError(415, 'UNSUPPORTED_FILE', `"${body.filename}" não é um arquivo de imagem ou vídeo suportado. Formatos aceitos: JPG, PNG, WebP, MP4 (H.264) e WebM.`);

    // Evita enviar de novo um arquivo idêntico que já está na biblioteca
    if (body.checksum) {
      const dup = await db.first<{ id: string; name: string }>('SELECT "id", "name" FROM "Media" WHERE "checksum" = ? AND "sizeBytes" = ? AND "status" = \'READY\' LIMIT 1', body.checksum, body.size);
      if (dup) throw conflict('DUPLICATE_MEDIA', `Este arquivo já está na biblioteca como "${dup.name}".`, { mediaId: dup.id });
    }
    // Limite lógico de armazenamento (configurável). Não é uma trava de faturamento da Cloudflare.
    const usage = await storageUsage(ctx);
    if (usage.usedBytes + usage.reservedBytes + body.size > usage.limitBytes)
      throw new AppError(
        413,
        'STORAGE_LIMIT',
        `Limite de armazenamento atingido: ${(usage.usedBytes / 1024 ** 3).toFixed(1)} GB usados de ${(usage.limitBytes / 1024 ** 3).toFixed(0)} GB. Remova mídias sem uso ou aumente o limite em Configurações.`,
        usage,
      );

    const id = uuid();
    const plannedMediaId = uuid();
    const safeExt = IMAGE_EXT[ext] || VIDEO_EXT[ext] ? ext : kind === 'image' ? 'img' : 'mp4';
    const key = `media/${plannedMediaId}/${kind === 'image' ? 'original' : 'playback'}.${safeExt}`;
    const contentType = IMAGE_EXT[ext] ?? VIDEO_EXT[ext] ?? 'application/octet-stream';
    const mpu = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
    const ts = now();
    await db.run(
      `INSERT INTO "UploadSession" ("id", "userId", "filename", "declaredMime", "totalBytes", "receivedBytes", "status", "createdAt", "updatedAt", "expiresAt",
         "plannedMediaId", "storageKey", "r2UploadId", "chunkBytes", "checksum")
       VALUES (?, ?, ?, ?, ?, 0, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      c.var.user.id,
      body.filename,
      body.mimeType ?? null,
      body.size,
      ts,
      ts,
      new Date(Date.now() + 24 * 3600_000).toISOString(),
      plannedMediaId,
      key,
      mpu.uploadId,
      config.chunkBytes,
      body.checksum ?? null,
    );
    return c.json({ uploadId: id, chunkBytes: config.chunkBytes, receivedBytes: 0, direct: config.directUpload, parts: partCount({ totalBytes: body.size, chunkBytes: config.chunkBytes }) });
  });

  const loadUpload = async (c: C) => {
    const id = c.req.param('id') ?? '';
    if (!isUuid(id)) throw notFound('Upload não encontrado.');
    const s = await c.var.ctx.db.first<UploadRow>('SELECT * FROM "UploadSession" WHERE "id" = ?', id);
    if (!s || s.userId !== c.var.user.id) throw notFound('Upload não encontrado.');
    return s;
  };

  const partNumberOf = (c: C, s: UploadRow) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 1 || n > partCount(s)) throw badRequest('Número da parte inválido.');
    return n;
  };

  /** Só aceita a próxima parte esperada (envio sequencial, como os blocos da versão 1) */
  const expectPart = (s: UploadRow, n: number) => {
    const expected = Math.floor(s.receivedBytes / s.chunkBytes) + 1;
    if (n > expected) throw conflict('OFFSET_MISMATCH', 'Posição do envio divergente. Retome a partir do valor informado.', { receivedBytes: s.receivedBytes });
    return n === expected;
  };

  /** Registra a parte enviada e avança o total recebido (atômico) */
  const recordPart = async (ctx: AppContext, s: UploadRow, n: number, etag: string, size: number, advance: boolean) => {
    const ts = now();
    const stmts = [
      ctx.db.prep(
        `INSERT INTO "UploadPart" ("uploadId", "partNumber", "etag", "size", "createdAt") VALUES (?, ?, ?, ?, ?)
         ON CONFLICT("uploadId", "partNumber") DO UPDATE SET "etag" = excluded."etag", "size" = excluded."size", "createdAt" = excluded."createdAt"`,
        s.id,
        n,
        etag,
        size,
        ts,
      ),
    ];
    if (advance)
      stmts.push(
        ctx.db.prep(
          `UPDATE "UploadSession" SET "receivedBytes" = "receivedBytes" + ?, "updatedAt" = ? WHERE "id" = ? AND "status" = 'ACTIVE' AND "receivedBytes" = ?`,
          size,
          ts,
          s.id,
          s.receivedBytes,
        ),
      );
    await ctx.db.batch(stmts);
    const after = await ctx.db.first<{ receivedBytes: number; totalBytes: number }>('SELECT "receivedBytes", "totalBytes" FROM "UploadSession" WHERE "id" = ?', s.id);
    return { receivedBytes: after?.receivedBytes ?? s.receivedBytes, totalBytes: s.totalBytes, etag };
  };

  app.get('/api/uploads/:id', requireUser, async (c) => {
    const s = await loadUpload(c);
    return c.json({ uploadId: s.id, status: s.status.toLowerCase(), receivedBytes: s.receivedBytes, totalBytes: s.totalBytes, mediaId: s.mediaId, chunkBytes: s.chunkBytes });
  });

  /** URL temporária (pré-assinada) para o navegador enviar a parte diretamente ao R2 */
  app.post('/api/uploads/:id/parts/:n/url', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const s = await loadUpload(c);
    if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
    const n = partNumberOf(c, s);
    expectPart(s, n);
    if (!ctx.config.directUpload) return c.json({ proxy: true, url: `/api/uploads/${s.id}/parts/${n}`, size: partSize(s, n) });
    const signed = await presignUploadPart(ctx.env, ctx.config, s.storageKey, s.r2UploadId, n);
    return c.json({ proxy: false, url: signed.url, expiresAt: signed.expiresAt, size: partSize(s, n) });
  });

  /** Confirma uma parte enviada diretamente ao R2 (ETag devolvida pelo R2 ao navegador) */
  app.post('/api/uploads/:id/parts/:n', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const s = await loadUpload(c);
    if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
    const n = partNumberOf(c, s);
    const body = parse(z.object({ etag: z.string().trim().min(1).max(200) }), await readBody(c));
    const advance = expectPart(s, n);
    return c.json(await recordPart(ctx, s, n, normalizeEtag(body.etag), partSize(s, n), advance));
  });

  /**
   * Envio da parte pelo Worker — usado somente quando as credenciais S3 do R2 não estão configuradas
   * (ex.: desenvolvimento local). Cada parte tem UPLOAD_CHUNK_MB, abaixo do limite de 100 MB por requisição.
   * O corpo é repassado em stream ao R2, sem ser carregado em memória.
   */
  app.put('/api/uploads/:id/parts/:n', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const s = await loadUpload(c);
    if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
    const n = partNumberOf(c, s);
    const advance = expectPart(s, n);
    const expected = partSize(s, n);
    const len = Number(c.req.header('content-length'));
    if (!Number.isFinite(len) || len !== expected) throw new AppError(400, 'PART_SIZE', `A parte ${n} deve ter exatamente ${expected} bytes.`);
    const body = c.req.raw.body;
    if (!body) throw badRequest('Parte vazia.');
    const mpu = ctx.bucket.resumeMultipartUpload(s.storageKey, s.r2UploadId);
    const uploaded = await mpu.uploadPart(n, body);
    return c.json(await recordPart(ctx, s, n, normalizeEtag(uploaded.etag), expected, advance));
  });

  /** Miniatura e prévia geradas no navegador do administrador (WebP/JPEG pequenos) */
  app.put('/api/uploads/:id/derivative/:kind', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const s = await loadUpload(c);
    if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
    const kind = c.req.param('kind');
    if (kind !== 'thumbnail' && kind !== 'preview') throw notFound();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > DERIVATIVE_MAX) throw new AppError(413, 'DERIVATIVE_TOO_LARGE', 'Miniatura inválida ou muito grande.');
    const isWebp = bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isWebp && !isJpeg) throw new AppError(415, 'UNSUPPORTED_FILE', 'A miniatura deve ser WebP ou JPEG.');
    const key = `media/${s.plannedMediaId}/${kind === 'thumbnail' ? 'thumb' : 'preview'}.${isWebp ? 'webp' : 'jpg'}`;
    await ctx.bucket.put(key, bytes, { httpMetadata: { contentType: isWebp ? 'image/webp' : 'image/jpeg' } });
    await ctx.db.run(`UPDATE "UploadSession" SET "${kind === 'thumbnail' ? 'thumbnailKey' : 'previewKey'}" = ?, "updatedAt" = ? WHERE "id" = ?`, key, now(), s.id);
    return c.json({ ok: true });
  });

  app.post('/api/uploads/:id/complete', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const { db, bucket, audit, realtime } = ctx;
    const s = await loadUpload(c);
    if (s.status === 'COMPLETED' && s.mediaId) {
      const r = await db.first(`${MEDIA_SELECT} WHERE m."id" = ?`, s.mediaId);
      if (r) return c.json({ media: mediaDto(mapMediaFull(r)) });
    }
    if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
    if (s.receivedBytes !== s.totalBytes) throw conflict('UPLOAD_INCOMPLETE', 'O arquivo ainda não foi totalmente enviado.', { receivedBytes: s.receivedBytes });
    const meta = parse(
      z.object({
        width: z.number().int().positive().max(100_000).nullable().optional(),
        height: z.number().int().positive().max(100_000).nullable().optional(),
        durationMs: z.number().int().nonnegative().max(7 * 86400_000).nullable().optional(),
        videoCodec: z.string().trim().max(40).nullable().optional(),
        checksum: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable()
          .optional(),
      }),
      await readBody(c),
    );

    const fail = async (message: string, code = 'UNSUPPORTED_FILE', status = 415): Promise<never> => {
      await deleteObjects(ctx, [s.storageKey, s.thumbnailKey, s.previewKey]);
      await db.run('UPDATE "UploadSession" SET "status" = \'FAILED\', "error" = ?, "updatedAt" = ? WHERE "id" = ?', message.slice(0, 500), now(), s.id);
      throw new AppError(status, code, message);
    };

    // 1) Conclui o multipart no R2 (se uma tentativa anterior já concluiu, o objeto já existe)
    let head = await bucket.head(s.storageKey);
    if (!head) {
      const parts = await db.all<{ partNumber: number; etag: string }>('SELECT "partNumber", "etag" FROM "UploadPart" WHERE "uploadId" = ? ORDER BY "partNumber" ASC', s.id);
      if (parts.length !== partCount(s) || parts.some((p, i) => p.partNumber !== i + 1))
        throw conflict('UPLOAD_INCOMPLETE', 'Faltam partes do arquivo. Envie novamente.', { receivedBytes: s.receivedBytes });
      try {
        await bucket.resumeMultipartUpload(s.storageKey, s.r2UploadId).complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
      } catch (err) {
        if (!ctx.config.directUpload) return fail(`Não foi possível concluir o armazenamento do arquivo: ${String(err).slice(0, 200)}`, 'STORAGE_ERROR', 502);
        try {
          await s3CompleteMultipart(ctx.env, ctx.config, s.storageKey, s.r2UploadId, parts);
        } catch (err2) {
          return fail(`Não foi possível concluir o armazenamento do arquivo: ${String(err2).slice(0, 200)}`, 'STORAGE_ERROR', 502);
        }
      }
      head = await bucket.head(s.storageKey);
    }
    // 2) Confirma o armazenamento antes de disponibilizar a mídia
    if (!head || head.size !== s.totalBytes) return fail('O arquivo armazenado não confere com o tamanho enviado. Envie novamente.', 'STORAGE_ERROR', 502);

    // 3) Valida o conteúdo real (assinatura binária), independente da extensão
    const sniff = await bucket.get(s.storageKey, { range: { offset: 0, length: Math.min(4100, s.totalBytes) } });
    const ft = sniff && 'body' in sniff ? await fileTypeFromBuffer(new Uint8Array(await sniff.arrayBuffer())) : undefined;
    const isImage = !!ft && (ACCEPTED_IMAGE_MIME as readonly string[]).includes(ft.mime);
    const isVideo = !!ft && (ACCEPTED_VIDEO_MIME as readonly string[]).includes(ft.mime);
    if (!ft || (!isImage && !isVideo)) {
      if (ft && (TRANSCODABLE_VIDEO_MIME as readonly string[]).includes(ft.mime))
        return fail('Este formato de vídeo exige conversão, que não está disponível na versão em nuvem. Envie MP4 (H.264) ou WebM.');
      return fail(`"${s.filename}" não é um arquivo de imagem ou vídeo suportado. Formatos aceitos: JPG, PNG, WebP, MP4 (H.264) e WebM.`);
    }
    // 4) Metadados extraídos no navegador (substituem FFprobe/Sharp da versão 1)
    const codec = meta.videoCodec?.toLowerCase() ?? null;
    if (isVideo) {
      if (!meta.durationMs || meta.durationMs <= 0) return fail('Não foi possível determinar a duração do vídeo.');
      if (codec && codec !== 'desconhecido' && !(BROWSER_CODECS[ft.mime] ?? []).includes(codec))
        return fail(`O vídeo usa o codec ${codec.toUpperCase()}, que não é reproduzido por todos os navegadores. Converta para MP4 (H.264) e envie novamente.`);
    } else if (!meta.width || !meta.height) {
      return fail('Imagem inválida ou corrompida.');
    }

    const baseName = s.filename.replace(/\.[^.]+$/, '').trim().slice(0, 200) || 'Sem nome';
    const mediaId = s.plannedMediaId;
    const ts = now();
    const checksum = meta.checksum ?? s.checksum ?? null;
    await db.batch([
      db.prep(
        `INSERT INTO "Media" ("id", "name", "originalFilename", "type", "status", "mimeType", "sizeBytes", "originalSize", "durationMs", "width", "height", "videoCodec",
           "checksum", "storageKey", "originalKey", "thumbnailKey", "previewKey", "transcoded", "uploadedById", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        mediaId,
        baseName,
        s.filename.slice(0, 255),
        isImage ? 'IMAGE' : 'VIDEO',
        ft.mime,
        s.totalBytes,
        s.totalBytes,
        isVideo ? meta.durationMs : null,
        meta.width ?? null,
        meta.height ?? null,
        isVideo ? (codec ?? 'desconhecido') : null,
        checksum,
        s.storageKey,
        s.storageKey,
        s.thumbnailKey,
        s.previewKey,
        c.var.user.id,
        ts,
        ts,
      ),
      db.prep('UPDATE "UploadSession" SET "status" = \'COMPLETED\', "mediaId" = ?, "updatedAt" = ? WHERE "id" = ?', mediaId, ts, s.id),
      db.prep('DELETE FROM "UploadPart" WHERE "uploadId" = ?', s.id),
    ]);
    await audit.record({
      action: AuditActions.MediaUploaded,
      userId: c.var.user.id,
      entityType: 'media',
      entityId: mediaId,
      summary: `Enviou "${s.filename}" (${(s.totalBytes / MiB).toFixed(1)} MB)`,
      details: { mime: ft.mime, size: s.totalBytes },
      ip: clientIp(c),
    });
    realtime.toAdmins(SocketEvents.MediaUpdated, { id: mediaId, status: 'ready' });
    const r = await db.first(`${MEDIA_SELECT} WHERE m."id" = ?`, mediaId);
    return c.json({ media: mediaDto(mapMediaFull(r!)) }, 201);
  });

  app.delete('/api/uploads/:id', requireUser, async (c) => {
    const ctx = c.var.ctx;
    const s = await loadUpload(c);
    if (s.status === 'ACTIVE') await cancelUpload(ctx, s, 'CANCELLED', null);
    return c.json({ ok: true });
  });
}

async function cancelUpload(ctx: AppContext, s: Pick<UploadRow, 'id' | 'storageKey' | 'r2UploadId' | 'thumbnailKey' | 'previewKey'>, status: 'CANCELLED' | 'FAILED', error: string | null) {
  await ctx.db.batch([
    ctx.db.prep('UPDATE "UploadSession" SET "status" = ?, "error" = ?, "updatedAt" = ? WHERE "id" = ?', status, error, now(), s.id),
    ctx.db.prep('DELETE FROM "UploadPart" WHERE "uploadId" = ?', s.id),
  ]);
  try {
    await ctx.bucket.resumeMultipartUpload(s.storageKey, s.r2UploadId).abort();
  } catch {
    /* upload já concluído ou expirado no R2 */
  }
  // remove o que tiver sido gravado, exceto se uma mídia já usar a chave
  const used = await ctx.db.first('SELECT 1 FROM "Media" WHERE "storageKey" = ? LIMIT 1', s.storageKey);
  if (!used) await deleteObjects(ctx, [s.storageKey, s.thumbnailKey, s.previewKey]);
}

/** Uploads abandonados (expirados): aborta o multipart no R2 e libera o espaço reservado. Chamado pelo cron. */
export async function cleanupStaleUploads(ctx: AppContext) {
  const stale = await ctx.db.all<UploadRow>(`SELECT * FROM "UploadSession" WHERE "status" = 'ACTIVE' AND "expiresAt" < ? LIMIT 50`, now());
  for (const s of stale) await cancelUpload(ctx, s, 'CANCELLED', 'Expirado');
  // histórico de uploads finalizados há mais de 30 dias
  await ctx.db.run(`DELETE FROM "UploadSession" WHERE "status" <> 'ACTIVE' AND "updatedAt" < ?`, new Date(Date.now() - 30 * 86400_000).toISOString());
  return stale.length;
}

