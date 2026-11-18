import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { StorageDriver } from '../storage/storage.js';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first ? `Dados inválidos: ${first.path.join('.') || 'corpo'} — ${first.message}` : 'Dados inválidos.', r.error.issues);
  }
  return r.data;
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/** Entrega um objeto do armazenamento com suporte a Range (necessário para vídeos) */
export async function serveObject(
  req: FastifyRequest,
  reply: FastifyReply,
  storage: StorageDriver,
  key: string,
  opts: { contentType: string; size?: number; cacheControl: string; etag?: string; filename?: string },
) {
  const size = opts.size ?? (await storage.stat(key))?.size;
  if (size === undefined) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Arquivo não encontrado.' });
  if (opts.etag) {
    reply.header('ETag', `"${opts.etag}"`);
    if (req.headers['if-none-match'] === `"${opts.etag}"`) return reply.code(304).send();
  }
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', opts.cacheControl);
  reply.header('Content-Type', opts.contentType);
  reply.header('X-Content-Type-Options', 'nosniff');
  if (opts.filename) reply.header('Content-Disposition', `inline; filename="${opts.filename.replace(/[^\w.\- ]/g, '_')}"`);
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    reply.header('Content-Range', `bytes */${size}`);
    return reply.code(416).send();
  }
  if (req.method === 'HEAD') {
    reply.header('Content-Length', size);
    return reply.code(200).send();
  }
  if (range) {
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return reply.send(await storage.read(key, range));
  }
  reply.header('Content-Length', size);
  return reply.send(await storage.read(key));
}

export const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
