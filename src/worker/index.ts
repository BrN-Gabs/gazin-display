/**
 * GAZIN DISPLAY — Worker (Cloudflare)
 *
 * Os arquivos do painel e do player são servidos pelos Static Assets (sem passar por este código).
 * Este Worker atende somente /api/* (configurado em wrangler.jsonc → assets.run_worker_first),
 * o Cron Trigger (agendamentos e limpeza) e exporta o Durable Object RealtimeHub.
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env } from './env';
import { createContext } from './context';
import { AppError } from './lib/errors';
import { DEVICE_COOKIE, SESSION_COOKIE, type HonoEnv } from './auth';
import { hubStub } from './realtime/port';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { cleanupStaleUploads, mediaRoutes } from './routes/media';
import { playlistRoutes } from './routes/playlists';
import { deviceRoutes } from './routes/devices';
import { playerRoutes } from './routes/player';
import { scheduleRoutes } from './routes/schedules';
import { systemRoutes } from './routes/system';

export { RealtimeHub } from './realtime/hub';

const app = new Hono<HonoEnv>();

/** Origem permitida: o próprio host ou PUBLIC_URL */
function originAllowed(req: Request, publicOrigin: string | undefined) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === new URL(req.url).host || o.origin === publicOrigin;
  } catch {
    return false;
  }
}

// ---------- contexto + cabeçalhos de segurança ----------
app.use('*', async (c, next) => {
  c.set('ctx', createContext(c.env, (p) => c.executionCtx.waitUntil(p)));
  await next();
  if (c.res.status === 101) return;
  try {
    const h = c.res.headers;
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'same-origin');
    h.set('X-Frame-Options', 'DENY');
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  } catch {
    /* resposta com cabeçalhos imutáveis */
  }
});

// ---------- Proteção CSRF ----------
// Requisições que alteram estado exigem o cabeçalho X-GD-CSRF (impossível de enviar
// a partir de outro site sem CORS — a API não habilita CORS) e, se presente, Origin igual ao host.
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('x-gd-csrf') !== '1') throw new AppError(403, 'CSRF', 'Requisição bloqueada (proteção CSRF).');
    if (!originAllowed(c.req.raw, c.var.ctx.config.publicOrigin)) throw new AppError(403, 'CSRF', 'Origem não permitida.');
  }
  await next();
});

// ---------- Erros ----------
app.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: err.code, message: err.message, details: err.details }, err.statusCode as 400);
  const msg = String((err as Error)?.message ?? err);
  if (msg.includes('FOREIGN KEY constraint failed')) return c.json({ error: 'IN_USE', message: 'Registro em uso por outros itens.' }, 409);
  if (msg.includes('UNIQUE constraint failed')) return c.json({ error: 'CONFLICT', message: 'Registro duplicado.' }, 409);
  console.error('erro não tratado', c.req.method, new URL(c.req.url).pathname, err);
  return c.json({ error: 'INTERNAL', message: 'Erro interno. Tente novamente; se persistir, consulte os logs do Worker (Cloudflare → Workers → Logs).' }, 500);
});

// ---------- Tempo real (WebSocket → Durable Object) ----------
app.get('/api/realtime/:role', async (c) => {
  const ctx = c.var.ctx;
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new AppError(426, 'UPGRADE_REQUIRED', 'Esperado WebSocket.');
  if (!originAllowed(c.req.raw, ctx.config.publicOrigin)) throw new AppError(403, 'CSRF', 'Origem não permitida.');
  const headers = new Headers({ upgrade: 'websocket' });
  const role = c.req.param('role');
  if (role === 'admin') {
    const user = await ctx.auth.userFromToken(getCookie(c, SESSION_COOKIE));
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'não autenticado');
    headers.set('x-gd-role', 'admin');
    headers.set('x-gd-user', user.id);
    headers.set('x-gd-session', user.sessionId);
  } else if (role === 'player') {
    const res = await ctx.auth.deviceFromCookie(getCookie(c, DEVICE_COOKIE));
    if (!res) throw new AppError(401, 'UNAUTHORIZED', 'dispositivo não autorizado');
    headers.set('x-gd-role', 'player');
    headers.set('x-gd-device', res.device.id);
    headers.set('x-gd-device-name', encodeURIComponent(res.device.name));
  } else {
    throw new AppError(404, 'NOT_FOUND', 'Rota não encontrada.');
  }
  // somente cabeçalhos definidos aqui chegam ao DO (nada vindo do cliente é confiado)
  return hubStub(c.env).fetch(new Request('https://realtime.internal/connect', { headers }));
});

// ---------- Rotas ----------
authRoutes(app);
userRoutes(app);
mediaRoutes(app);
playlistRoutes(app);
deviceRoutes(app);
playerRoutes(app);
scheduleRoutes(app);
systemRoutes(app);

app.all('/api/*', (c) => c.json({ error: 'NOT_FOUND', message: 'Rota não encontrada.' }, 404));
// Qualquer outro caminho é servido pelos Static Assets (painel/player)
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

  /** Cron (a cada minuto): agendamentos; no minuto 0, limpeza de sessões, vinculações e uploads abandonados */
  async scheduled(controller: ScheduledController, env: Env, execCtx: ExecutionContext) {
    const ctx = createContext(env, (p) => execCtx.waitUntil(p));
    const at = new Date(controller.scheduledTime);
    await ctx.devices.recomputeAll(at);
    if (at.getUTCMinutes() === 0) {
      const ts = new Date().toISOString();
      await ctx.db.batch([
        ctx.db.prep('DELETE FROM "Session" WHERE "expiresAt" < ?', ts),
        ctx.db.prep('DELETE FROM "PairingRequest" WHERE "expiresAt" < ?', new Date(Date.now() - 86400_000).toISOString()),
        ctx.db.prep('DELETE FROM "RateLimit" WHERE "resetAt" < ?', Date.now()),
      ]);
      await cleanupStaleUploads(ctx);
    }
  },
} satisfies ExportedHandler<Env>;
