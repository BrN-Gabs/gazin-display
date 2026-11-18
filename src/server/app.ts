import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { createDb, Prisma, type Db } from './db.js';
import { createStorage } from './storage/storage.js';
import { SettingsService } from './services/settings.js';
import { AuditActions, AuditService } from './services/audit.js';
import { MediaProcessor } from './services/media-processing.js';
import { Realtime } from './realtime.js';
import { DeviceService } from './services/devices.js';
import { PlaylistService } from './services/playlists.js';
import { AuthService } from './auth.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { mediaRoutes } from './routes/media.js';
import { playlistRoutes } from './routes/playlists.js';
import { deviceRoutes } from './routes/devices.js';
import { playerRoutes } from './routes/player.js';
import { scheduleRoutes } from './routes/schedules.js';
import { systemRoutes } from './routes/system.js';
import { SocketEvents } from '../shared/types.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  /** Inicia sockets e rotinas em segundo plano (após listen) */
  startBackground(): Promise<void>;
  close(): Promise<void>;
}

export async function buildApp(config: AppConfig, opts: { db?: Db; logger?: FastifyServerOptions['logger'] } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger:
      opts.logger ??
      ({
        level: config.LOG_LEVEL,
        redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        ...(config.production || config.NODE_ENV === 'test' ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }),
      } as FastifyServerOptions['logger']),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = opts.db ?? createDb(config.DATABASE_URL);
  const ctx = { config, db, log: app.log, storage: createStorage(config) } as AppContext;
  ctx.settings = new SettingsService(db);
  ctx.audit = new AuditService(db, app.log);
  ctx.auth = new AuthService(ctx);
  ctx.realtime = new Realtime(ctx);
  ctx.devices = new DeviceService(ctx);
  ctx.playlists = new PlaylistService(ctx);
  ctx.processor = new MediaProcessor(config, db, ctx.storage, app.log, {
    onDone: async (mediaId, ok, error) => {
      const m = await db.media.findUnique({ where: { id: mediaId } });
      ctx.realtime.toAdmins(SocketEvents.MediaUpdated, { id: mediaId, status: ok ? 'ready' : 'failed' });
      if (m)
        await ctx.audit.record({
          action: ok ? AuditActions.MediaProcessed : AuditActions.MediaFailed,
          userId: m.uploadedById,
          entityType: 'media',
          entityId: m.id,
          summary: ok ? `Mídia "${m.name}" pronta${m.transcoded ? ' (convertida para MP4/H.264)' : ''}` : `Falha ao processar "${m.name}": ${error}`,
        });
    },
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'RATE_LIMITED',
      message: `Muitas tentativas. Aguarde ${Math.ceil(context.ttl / 1000)} segundos e tente novamente.`,
    }),
  });

  // corpo binário para upload em partes (stream, sem bufferizar)
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // ---------- Proteção CSRF ----------
  // Requisições que alteram estado exigem o cabeçalho X-GD-CSRF (impossível de enviar
  // a partir de outro site sem CORS) e, se presente, Origin igual ao host.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['x-gd-csrf'] !== '1') throw new AppError(403, 'CSRF', 'Requisição bloqueada (proteção CSRF).');
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const o = new URL(origin);
        ok = o.host === req.headers.host || o.origin === config.publicOrigin;
      } catch {
        ok = false;
      }
      if (!ok) throw new AppError(403, 'CSRF', 'Origem não permitida.');
    }
  });

  // ---------- Cabeçalhos de segurança ----------
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.production && config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.includes('text/html')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; worker-src 'self'",
      );
    }
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
  });

  // ---------- Erros ----------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') return reply.code(404).send({ error: 'NOT_FOUND', message: 'Registro não encontrado.' });
      if (err.code === 'P2003') return reply.code(409).send({ error: 'IN_USE', message: 'Registro em uso por outros itens.' });
    }
    if (e.statusCode === 429) return reply.code(429).send(err);
    if (e.statusCode && e.statusCode < 500) {
      const msg = e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'Conteúdo maior que o permitido.' : e.code?.startsWith('FST_ERR_CTP') ? 'Formato de requisição inválido.' : e.message;
      return reply.code(e.statusCode).send({ error: e.code ?? 'BAD_REQUEST', message: msg });
    }
    req.log.error({ err }, 'erro não tratado');
    return reply.code(500).send({ error: 'INTERNAL', message: 'Erro interno. Tente novamente; se persistir, consulte os logs do servidor.' });
  });

  // ---------- Rotas ----------
  await authRoutes(app, ctx);
  await userRoutes(app, ctx);
  const media = await mediaRoutes(app, ctx);
  await playlistRoutes(app, ctx);
  await deviceRoutes(app, ctx);
  await playerRoutes(app, ctx);
  await scheduleRoutes(app, ctx);
  await systemRoutes(app, ctx);

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'Rota não encontrada.' }));

  // ---------- Frontend (build de produção) ----------
  const webDir = config.webDistDir;
  const hasWeb = fs.existsSync(path.join(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: path.join(webDir, 'assets'),
      prefix: '/assets/',
      immutable: true,
      maxAge: '365d',
      index: false,
    });
    const sendHtml = (file: string) => async (_req: unknown, reply: import('fastify').FastifyReply) => {
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(fs.createReadStream(path.join(webDir, file)));
    };
    app.get('/', async (_req, reply) => reply.redirect('/admin'));
    app.get('/admin', sendHtml('index.html'));
    app.get('/admin/*', sendHtml('index.html'));
    app.get('/player', async (_req, reply) => reply.redirect('/player/'));
    app.get('/player/', sendHtml('player/index.html'));
    app.get('/player/sw.js', async (_req, reply) => {
      reply.header('Cache-Control', 'no-cache');
      reply.header('Service-Worker-Allowed', '/player/');
      return reply.type('text/javascript; charset=utf-8').send(fs.createReadStream(path.join(webDir, 'player', 'sw.js')));
    });
    for (const f of ['favicon.svg', 'player/manifest.webmanifest']) {
      if (fs.existsSync(path.join(webDir, f))) app.get(`/${f}`, async (_req, reply) => reply.sendFile(f, webDir));
    }
  } else {
    app.get('/', async () => ({ message: 'GAZIN DISPLAY API. Frontend não compilado: rode "npm run build" ou use "npm run dev".' }));
  }

  const timers: NodeJS.Timeout[] = [];
  let backgroundStarted = false;

  return {
    app,
    ctx,
    async startBackground() {
      if (backgroundStarted) return;
      backgroundStarted = true;
      ctx.realtime.attach(app.server);
      await ctx.processor.recover();
      // Agendamentos são aplicados pelo servidor, independente do painel estar aberto
      await ctx.devices.recomputeAll();
      timers.push(setInterval(() => void ctx.devices.recomputeAll(), 15_000));
      timers.push(
        setInterval(() => {
          void media.cleanupStaleUploads().catch(() => {});
          void db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
          void db.pairingRequest.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86400_000) } } }).catch(() => {});
        }, 3600_000),
      );
      timers.forEach((t) => t.unref());
    },
    async close() {
      timers.forEach(clearInterval);
      await ctx.realtime.close();
      await app.close();
      await ctx.processor.whenIdle();
      if (!opts.db) await db.$disconnect();
    },
  };
}
