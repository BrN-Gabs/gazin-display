import type { z } from 'zod';
import { badRequest } from './errors';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first ? `Dados inválidos: ${first.path.join('.') || 'corpo'} — ${first.message}` : 'Dados inválidos.', r.error.issues);
  }
  return r.data;
}

export function parseRange(header: string | undefined | null, size: number): { start: number; end: number } | 'invalid' | null {
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

/**
 * Entrega um objeto do R2 com suporte a Range (necessário para <video>).
 * O corpo é repassado como stream: o Worker nunca carrega o arquivo inteiro em memória.
 */
export async function serveObject(
  req: Request,
  bucket: R2Bucket,
  key: string,
  opts: { contentType: string; size?: number; cacheControl: string; etag?: string; filename?: string; extraHeaders?: Record<string, string> },
): Promise<Response> {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cacheControl,
    'Content-Type': opts.contentType,
    'X-Content-Type-Options': 'nosniff',
    ...(opts.extraHeaders ?? {}),
  });
  if (opts.filename) headers.set('Content-Disposition', `inline; filename="${opts.filename.replace(/[^\w.\- ]/g, '_')}"`);
  const notFoundRes = () =>
    new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'Arquivo não encontrado.' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  let size = opts.size;
  if (size === undefined) {
    const head = await bucket.head(key);
    if (!head) return notFoundRes();
    size = head.size;
  }
  if (opts.etag) {
    headers.set('ETag', `"${opts.etag}"`);
    if (req.headers.get('if-none-match') === `"${opts.etag}"`) return new Response(null, { status: 304, headers });
  }
  const range = parseRange(req.headers.get('range'), size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (req.method === 'HEAD') {
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }
  if (range) {
    const obj = await bucket.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
    if (!obj || !('body' in obj)) return notFoundRes();
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  const obj = await bucket.get(key);
  if (!obj || !('body' in obj)) return notFoundRes();
  headers.set('Content-Length', String(size));
  return new Response(obj.body, { status: 200, headers });
}
