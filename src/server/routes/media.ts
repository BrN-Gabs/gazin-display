import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Media } from '../db.js';
import { Prisma } from '../db.js';
import { num, parse, serveObject } from '../lib/http.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { detectFile } from '../services/media-processing.js';
import { AuditActions } from '../services/audit.js';
import { ACCEPTED_IMAGE_MIME, ACCEPTED_VIDEO_MIME, SocketEvents, TRANSCODABLE_VIDEO_MIME } from '../../shared/types.js';

export function mediaDto(m: Media & { uploadedBy?: { name: string } | null; _count?: { playlistItems: number } }) {
  const v = m.updatedAt.getTime();
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    originalFilename: m.originalFilename,
    type: m.type === 'IMAGE' ? 'image' : 'video',
    status: m.status.toLowerCase(),
    mimeType: m.mimeType,
    sizeBytes: num(m.sizeBytes),
    originalSize: num(m.originalSize),
    durationMs: m.durationMs,
    width: m.width,
    height: m.height,
    videoCodec: m.videoCodec,
    transcoded: m.transcoded,
    checksum: m.checksum,
    error: m.error,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    uploadedBy: m.uploadedBy?.name ?? null,
    playlistCount: m._count?.playlistItems ?? undefined,
    thumbnailUrl: m.thumbnailKey ? `/api/media/${m.id}/thumbnail?v=${v}` : null,
    previewUrl: m.previewKey ? `/api/media/${m.id}/preview?v=${v}` : null,
    fileUrl: m.storageKey ? `/api/media/${m.id}/file` : null,
  };
}

export async function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, storage, audit, config, processor, realtime } = ctx;
  const uploadsDir = path.join(config.storageDir, 'tmp', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const partPath = (id: string) => path.join(uploadsDir, `${id}.part`);
  const chunkLocks = new Set<string>();

  const effectiveMaxBytes = async () => Math.min(config.maxUploadBytes, (await ctx.settings.get()).maxUploadMb * 1024 * 1024);

  // ---------------- Biblioteca ----------------

  app.get('/api/media', { preHandler: auth.requireUser }, async (req) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(200).optional(),
        type: z.enum(['image', 'video']).optional(),
        status: z.enum(['processing', 'ready', 'failed']).optional(),
        sort: z.enum(['date', 'name', 'size']).default('date'),
        order: z.enum(['asc', 'desc']).optional(),
      }),
      req.query,
    );
    const where: Prisma.MediaWhereInput = {
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { originalFilename: { contains: q.search, mode: 'insensitive' } }] } : {}),
      ...(q.type ? { type: q.type === 'image' ? 'IMAGE' : 'VIDEO' } : {}),
      ...(q.status ? { status: q.status.toUpperCase() as 'READY' } : {}),
    };
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const orderBy: Prisma.MediaOrderByWithRelationInput =
      q.sort === 'name' ? { name: order } : q.sort === 'size' ? { sizeBytes: order } : { createdAt: order };
    const media = await db.media.findMany({
      where,
      orderBy,
      take: 1000,
      include: { uploadedBy: { select: { name: true } }, _count: { select: { playlistItems: true } } },
    });
    return { media: media.map(mediaDto) };
  });

  app.get<{ Params: { id: string } }>('/api/media/:id', { preHandler: auth.requireUser }, async (req) => {
    const m = await db.media.findUnique({ where: { id: req.params.id }, include: { uploadedBy: { select: { name: true } }, _count: { select: { playlistItems: true } } } });
    if (!m) throw notFound('Mídia não encontrada.');
    return { media: mediaDto(m) };
  });

  app.get<{ Params: { id: string } }>('/api/media/:id/usage', { preHandler: auth.requireUser }, async (req) => {
    const items = await db.playlistItem.findMany({ where: { mediaId: req.params.id }, select: { playlist: { select: { id: true, name: true } } } });
    const playlists = [...new Map(items.map((i) => [i.playlist.id, i.playlist])).values()];
    const active = (await ctx.devices.mediaInActiveUse()).get(req.params.id) ?? [];
    return { playlists, activeOn: active };
  });

  app.patch<{ Params: { id: string } }>('/api/media/:id', { preHandler: auth.requireUser }, async (req) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().trim().max(1000).nullable().optional() }), req.body);
    const m = await db.media.findUnique({ where: { id: req.params.id } });
    if (!m) throw notFound('Mídia não encontrada.');
    const updated = await db.media.update({ where: { id: m.id }, data: { name: body.name, description: body.description } });
    await audit.record({ action: AuditActions.MediaUpdated, userId: req.user!.id, entityType: 'media', entityId: m.id, summary: `Editou a mídia "${updated.name}"`, details: { from: m.name, to: updated.name }, ip: req.ip });
    realtime.toAdmins(SocketEvents.MediaUpdated, { id: m.id });
    return { media: mediaDto(updated) };
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>('/api/media/:id', { preHandler: auth.requireUser }, async (req) => {
    const m = await db.media.findUnique({ where: { id: req.params.id } });
    if (!m) throw notFound('Mídia não encontrada.');
    if (m.status === 'PROCESSING') throw conflict('MEDIA_PROCESSING', 'Aguarde o fim do processamento para remover esta mídia.');
    const activeOn = (await ctx.devices.mediaInActiveUse()).get(m.id);
    if (activeOn?.length)
      throw conflict('MEDIA_IN_USE', `Esta mídia faz parte da programação publicada (${[...new Set(activeOn)].join(', ')}). Publique uma versão sem ela antes de removê-la.`, { devices: activeOn });
    const fallbackUsers = await db.playlist.findMany({ where: { settings: { path: ['fallbackMediaId'], equals: m.id } }, select: { id: true, name: true } });
    const refs = await db.playlistItem.findMany({ where: { mediaId: m.id }, select: { playlistId: true, playlist: { select: { name: true } } } });
    const playlists = [...new Map([...refs.map((r) => [r.playlistId, r.playlist.name] as const), ...fallbackUsers.map((p) => [p.id, p.name] as const)]).entries()].map(([id, name]) => ({ id, name }));
    if (playlists.length && req.query.force !== 'true')
      throw conflict('MEDIA_IN_DRAFTS', 'Esta mídia está em playlists (rascunho). Confirme para removê-la dessas playlists.', { playlists });

    await db.$transaction(async (tx) => {
      const affected = [...new Set(refs.map((r) => r.playlistId))];
      await tx.playlistItem.deleteMany({ where: { mediaId: m.id } });
      for (const pid of affected) {
        const items = await tx.playlistItem.findMany({ where: { playlistId: pid }, orderBy: { position: 'asc' } });
        for (const [i, it] of items.entries()) if (it.position !== i) await tx.playlistItem.update({ where: { id: it.id }, data: { position: i } });
        await tx.playlist.update({ where: { id: pid }, data: { revision: { increment: 1 } } });
      }
      for (const p of fallbackUsers) {
        const pl = await tx.playlist.findUniqueOrThrow({ where: { id: p.id } });
        await tx.playlist.update({ where: { id: p.id }, data: { settings: { ...(pl.settings as object), fallbackMediaId: null }, revision: { increment: 1 } } });
      }
      await tx.media.delete({ where: { id: m.id } });
    });
    for (const key of new Set([m.storageKey, m.originalKey, m.thumbnailKey, m.previewKey])) {
      if (key) await storage.delete(key).catch((err) => ctx.log.warn({ err, key }, 'falha ao remover arquivo'));
    }
    await audit.record({
      action: AuditActions.MediaDeleted,
      userId: req.user!.id,
      entityType: 'media',
      entityId: m.id,
      summary: `Removeu a mídia "${m.name}"`,
      details: { file: m.originalFilename, size: Number(m.sizeBytes), removedFromPlaylists: playlists.map((p) => p.name) },
      ip: req.ip,
    });
    realtime.toAdmins(SocketEvents.MediaUpdated, { id: m.id, deleted: true });
    return { ok: true };
  });

  const serveVariant = (variant: 'thumbnail' | 'preview' | 'file') =>
    app.route<{ Params: { id: string } }>({
      method: ['GET', 'HEAD'],
      url: `/api/media/:id/${variant}`,
      preHandler: auth.requireUser,
      handler: async (req, reply) => {
        const m = await db.media.findUnique({ where: { id: req.params.id } });
        if (!m) throw notFound('Mídia não encontrada.');
        const key = variant === 'thumbnail' ? m.thumbnailKey : variant === 'preview' ? m.previewKey : m.storageKey;
        if (!key) throw notFound('Arquivo ainda não disponível.');
        return serveObject(req, reply, storage, key, {
          contentType: variant === 'file' ? m.mimeType : 'image/webp',
          size: variant === 'file' ? Number(m.sizeBytes) : undefined,
          cacheControl: variant === 'file' ? 'private, max-age=3600' : 'private, max-age=86400',
          etag: variant === 'file' ? (m.checksum ?? undefined) : `${m.id}-${variant}-${m.updatedAt.getTime()}`,
          filename: variant === 'file' ? m.originalFilename : undefined,
        });
      },
    });
  serveVariant('thumbnail');
  serveVariant('preview');
  serveVariant('file');

  // ---------------- Upload em partes (retomável) ----------------

  app.get('/api/uploads/config', { preHandler: auth.requireUser }, async () => ({
    chunkBytes: config.chunkBytes,
    maxBytes: await effectiveMaxBytes(),
    accept: { image: [...ACCEPTED_IMAGE_MIME], video: [...ACCEPTED_VIDEO_MIME], convertible: processor.bins.ffmpeg ? [...TRANSCODABLE_VIDEO_MIME] : [] },
    ffmpeg: !!processor.bins.ffmpeg,
  }));

  app.post('/api/uploads', { preHandler: auth.requireUser }, async (req) => {
    const body = parse(z.object({ filename: z.string().trim().min(1).max(255), size: z.number().int().positive(), mimeType: z.string().max(120).optional() }), req.body);
    const max = await effectiveMaxBytes();
    if (body.size > max) throw new AppError(413, 'FILE_TOO_LARGE', `Arquivo maior que o limite configurado (${Math.round(max / 1024 / 1024)} MB).`);
    const session = await db.uploadSession.create({
      data: {
        userId: req.user!.id,
        filename: body.filename,
        declaredMime: body.mimeType,
        totalBytes: BigInt(body.size),
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      },
    });
    await fsp.writeFile(partPath(session.id), Buffer.alloc(0));
    return { uploadId: session.id, chunkBytes: config.chunkBytes, receivedBytes: 0 };
  });

  const loadUpload = async (id: string, userId: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Upload não encontrado.');
    const s = await db.uploadSession.findUnique({ where: { id } });
    if (!s || s.userId !== userId) throw notFound('Upload não encontrado.');
    return s;
  };

  app.get<{ Params: { id: string } }>('/api/uploads/:id', { preHandler: auth.requireUser }, async (req) => {
    const s = await loadUpload(req.params.id, req.user!.id);
    return { uploadId: s.id, status: s.status.toLowerCase(), receivedBytes: Number(s.receivedBytes), totalBytes: Number(s.totalBytes), mediaId: s.mediaId };
  });

  app.put<{ Params: { id: string }; Querystring: { offset?: string } }>(
    '/api/uploads/:id/chunk',
    { preHandler: auth.requireUser, bodyLimit: 1024 * 1024 * 1024 },
    async (req) => {
      const s = await loadUpload(req.params.id, req.user!.id);
      if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
      const offset = Number(req.query.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('offset inválido.');
      if (offset !== Number(s.receivedBytes))
        throw conflict('OFFSET_MISMATCH', 'Posição do envio divergente. Retome a partir do valor informado.', { receivedBytes: Number(s.receivedBytes) });
      if (chunkLocks.has(s.id)) throw conflict('CHUNK_IN_PROGRESS', 'Outra parte deste arquivo está sendo enviada.');
      chunkLocks.add(s.id);
      try {
        const remaining = Number(s.totalBytes) - offset;
        const limit = Math.min(config.chunkBytes, remaining);
        let written = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            written += chunk.length;
            if (written > limit) cb(new AppError(413, 'CHUNK_TOO_LARGE', 'Parte maior que o permitido.'));
            else cb(null, chunk);
          },
        });
        const body = req.body as NodeJS.ReadableStream | Buffer | undefined;
        if (!body) throw badRequest('Corpo vazio.');
        const out = fs.createWriteStream(partPath(s.id), { flags: 'r+', start: offset });
        if (Buffer.isBuffer(body)) {
          if (body.length > limit) throw new AppError(413, 'CHUNK_TOO_LARGE', 'Parte maior que o permitido.');
          written = body.length;
          await new Promise<void>((resolve, reject) => out.end(body, (e?: Error | null) => (e ? reject(e) : resolve())));
        } else {
          await pipeline(body, counter, out);
        }
        if (written === 0) throw badRequest('Parte vazia.');
        const updated = await db.uploadSession.update({ where: { id: s.id }, data: { receivedBytes: BigInt(offset + written) } });
        return { receivedBytes: Number(updated.receivedBytes), totalBytes: Number(updated.totalBytes) };
      } finally {
        chunkLocks.delete(s.id);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', { preHandler: auth.requireUser }, async (req, reply) => {
    const s = await loadUpload(req.params.id, req.user!.id);
    if (s.status === 'COMPLETED' && s.mediaId) {
      const m = await db.media.findUnique({ where: { id: s.mediaId } });
      if (m) return { media: mediaDto(m) };
    }
    if (s.status !== 'ACTIVE') throw conflict('UPLOAD_CLOSED', 'Este upload não está mais ativo.');
    if (s.receivedBytes !== s.totalBytes) throw conflict('UPLOAD_INCOMPLETE', 'O arquivo ainda não foi totalmente enviado.', { receivedBytes: Number(s.receivedBytes) });
    const part = partPath(s.id);
    await fsp.truncate(part, Number(s.totalBytes)); // descarta bytes de partes interrompidas
    const detected = await detectFile(part);
    const fail = async (message: string, code = 'UNSUPPORTED_FILE', status = 415) => {
      await fsp.rm(part, { force: true });
      await db.uploadSession.update({ where: { id: s.id }, data: { status: 'FAILED', error: message } });
      throw new AppError(status, code, message);
    };
    if (!detected) return fail(`"${s.filename}" não é um arquivo de imagem ou vídeo suportado. Formatos aceitos: JPG, PNG, WebP, MP4 (H.264) e WebM.`);
    if (detected.transcodable && !processor.bins.ffmpeg) return fail('Este formato de vídeo exige conversão, mas o ffmpeg não está disponível no servidor. Envie MP4 (H.264).');
    const baseName = s.filename.replace(/\.[^.]+$/, '').trim().slice(0, 200) || 'Sem nome';
    const media = await db.media.create({
      data: {
        name: baseName,
        originalFilename: s.filename.slice(0, 255),
        type: detected.kind === 'image' ? 'IMAGE' : 'VIDEO',
        status: 'PROCESSING',
        mimeType: detected.mime,
        sizeBytes: s.totalBytes,
        uploadedById: req.user!.id,
      },
    });
    await fsp.rename(part, processor.sourcePathFor(media.id));
    await db.uploadSession.update({ where: { id: s.id }, data: { status: 'COMPLETED', mediaId: media.id } });
    processor.enqueue({ mediaId: media.id, sourcePath: processor.sourcePathFor(media.id), userId: req.user!.id });
    await audit.record({
      action: AuditActions.MediaUploaded,
      userId: req.user!.id,
      entityType: 'media',
      entityId: media.id,
      summary: `Enviou "${s.filename}" (${(Number(s.totalBytes) / 1024 / 1024).toFixed(1)} MB)`,
      details: { mime: detected.mime, size: Number(s.totalBytes) },
      ip: req.ip,
    });
    realtime.toAdmins(SocketEvents.MediaUpdated, { id: media.id });
    reply.code(201);
    return { media: mediaDto(media) };
  });

  app.delete<{ Params: { id: string } }>('/api/uploads/:id', { preHandler: auth.requireUser }, async (req) => {
    const s = await loadUpload(req.params.id, req.user!.id);
    if (s.status === 'ACTIVE') {
      await db.uploadSession.update({ where: { id: s.id }, data: { status: 'CANCELLED' } });
      await fsp.rm(partPath(s.id), { force: true });
    }
    return { ok: true };
  });

  /** Remove uploads abandonados (chamado periodicamente) */
  return {
    async cleanupStaleUploads() {
      const stale = await db.uploadSession.findMany({ where: { status: 'ACTIVE', expiresAt: { lt: new Date() } } });
      for (const s of stale) {
        await fsp.rm(partPath(s.id), { force: true });
        await db.uploadSession.update({ where: { id: s.id }, data: { status: 'CANCELLED', error: 'Expirado' } });
      }
      return stale.length;
    },
  };
}
