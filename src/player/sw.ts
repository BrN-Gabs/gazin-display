/// <reference lib="webworker" />
/**
 * Service Worker do player (escopo /player/).
 *  - Mantém a página e os scripts do player disponíveis offline (após reinício do computador sem servidor).
 *  - Entrega as mídias a partir do Cache Storage persistente, com suporte a Range (necessário para <video>).
 * Sem imports: precisa ser um script autocontido.
 */
export {};
declare const self: ServiceWorkerGlobalScope;

const SHELL_CACHE = 'gd-shell-v1';
const MEDIA_CACHE = 'gd-media-v1';
const PLAYER_PAGE = '/player/';

function assetsFromHtml(html: string) {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="(\/(?:assets|player)\/[^"]+)"/g)) out.add(m[1]!);
  out.add('/player/manifest.webmanifest');
  out.add('/favicon.svg');
  return [...out];
}

async function refreshShell(fromNetwork?: Response) {
  const cache = await caches.open(SHELL_CACHE);
  const res = fromNetwork ?? (await fetch(PLAYER_PAGE, { cache: 'no-store' }));
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put(PLAYER_PAGE, res.clone());
  const assets = assetsFromHtml(html);
  await Promise.all(
    assets.map(async (a) => {
      if (await cache.match(a)) return;
      try {
        const r = await fetch(a, { cache: 'no-store' });
        if (r.ok) await cache.put(a, r);
      } catch {
        /* offline */
      }
    }),
  );
  // remove assets antigos que não fazem mais parte da página atual
  const keep = new Set([PLAYER_PAGE, ...assets]);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!keep.has(path)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshShell().catch(() => {}));
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function parseRange(header: string, size: number) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

async function fromMediaCache(request: Request, path: string) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(path);
  if (!cached) return fetch(request);
  const range = request.headers.get('range');
  const type = cached.headers.get('content-type') ?? 'application/octet-stream';
  if (!range) {
    const blob = await cached.blob();
    return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' } });
  }
  const blob = await cached.blob();
  const r = parseRange(range, blob.size);
  if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  return new Response(blob.slice(r.start, r.end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${r.start}-${r.end}/${blob.size}`,
      'Content-Length': String(r.end - r.start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function networkFirstPage(request: Request) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(request, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      void refreshShell(res.clone()).catch(() => {});
      return res;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch {
    const cached = await (await caches.open(SHELL_CACHE)).match(PLAYER_PAGE);
    return cached ?? new Response('<h1>Player indisponível offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function cacheFirstAsset(request: Request, path: string) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(path);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) await cache.put(path, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const path = url.pathname;
  if (event.request.mode === 'navigate' && (path === '/player/' || path === '/player/index.html')) {
    event.respondWith(networkFirstPage(event.request));
  } else if (path.startsWith('/api/player/media/') && !url.searchParams.has('network')) {
    event.respondWith(fromMediaCache(event.request, path));
  } else if (path.startsWith('/assets/') || path === '/player/manifest.webmanifest' || path === '/favicon.svg') {
    event.respondWith(cacheFirstAsset(event.request, path));
  }
});
