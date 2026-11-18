import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DEVICE_COOKIE } from '../auth.js';
import { parse, serveObject } from '../lib/http.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { pairingCode, randomToken, safeEqual, sha256 } from '../lib/security.js';

/**
 * API exclusiva do player (dispositivo). Usa somente a credencial do dispositivo
 * (cookie HttpOnly), com acesso restrito à sua própria programação e mídias.
 */
export async function playerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, devices, storage, realtime } = ctx;

  app.get('/api/player/session', async (req, reply) => {
    const res = await auth.deviceFromCookie(req.cookies[DEVICE_COOKIE]);
    if (!res) {
      reply.code(401);
      return { paired: false };
    }
    if (res.renew) reply.setCookie(DEVICE_COOKIE, req.cookies[DEVICE_COOKIE]!, auth.deviceCookieOptions());
    return { paired: true, device: { id: res.device.id, name: res.device.name, identifier: res.device.identifier } };
  });

  app.post('/api/player/pairing', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    await db.pairingRequest.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } });
    const pollSecret = randomToken(24);
    for (let i = 0; i < 5; i++) {
      try {
        const p = await db.pairingRequest.create({
          data: { code: pairingCode(), pollSecretHash: sha256(pollSecret), expiresAt: new Date(Date.now() + 15 * 60_000), userAgent: req.headers['user-agent']?.slice(0, 300) },
        });
        realtime.toAdmins('pairing:pending', { id: p.id });
        return { id: p.id, code: p.code, pollSecret, expiresAt: p.expiresAt };
      } catch {
        /* colisão de código — tenta novamente */
      }
    }
    throw new AppError(503, 'PAIRING_UNAVAILABLE', 'Não foi possível gerar um código agora.');
  });

  app.post<{ Params: { id: string } }>('/api/player/pairing/:id/poll', { config: { rateLimit: { max: 400, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ pollSecret: z.string().min(10).max(100) }), req.body);
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound();
    const p = await db.pairingRequest.findUnique({ where: { id: req.params.id }, include: { approvedDevice: true } });
    if (!p || !safeEqual(p.pollSecretHash, sha256(body.pollSecret))) throw notFound('Solicitação de vinculação não encontrada.');
    if (p.consumedAt) return { status: 'consumed' };
    if (!p.approvedAt || !p.approvedDevice) return { status: p.expiresAt < new Date() ? 'expired' : 'pending', expiresAt: p.expiresAt };
    // aprovado: emite a credencial própria do dispositivo (uma única vez)
    const claimed = await db.pairingRequest.updateMany({ where: { id: p.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) return { status: 'consumed' };
    const cookie = await auth.issueDeviceCredential(p.approvedDevice.id, req.headers['user-agent']);
    reply.setCookie(DEVICE_COOKIE, cookie, auth.deviceCookieOptions());
    return { status: 'approved', device: { id: p.approvedDevice.id, name: p.approvedDevice.name, identifier: p.approvedDevice.identifier } };
  });

  app.get('/api/player/manifest', { preHandler: auth.requireDevice }, async (req) => {
    const deviceId = req.device!.id;
    await devices.recompute(deviceId).catch(() => {});
    await db.displayDevice.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } }).catch(() => {});
    return devices.manifest(deviceId);
  });

  /** Mídias acessíveis ao dispositivo: somente as das versões ligadas a ele */
  async function allowedMedia(deviceId: string) {
    const d = await db.displayDevice.findUnique({ where: { id: deviceId }, include: { schedules: { where: { enabled: true }, select: { playlistId: true } } } });
    if (!d) return new Set<string>();
    const ids = new Set([d.effectiveVersionId, d.publishedVersionId, d.reportedVersionId].filter((x): x is string => !!x));
    for (const s of d.schedules) {
      const latest = await db.playlistVersion.findFirst({ where: { playlistId: s.playlistId }, orderBy: { number: 'desc' }, select: { id: true } });
      if (latest) ids.add(latest.id);
    }
    const versions = await db.playlistVersion.findMany({ where: { id: { in: [...ids] } }, select: { mediaIds: true } });
    return new Set(versions.flatMap((v) => v.mediaIds));
  }

  app.route<{ Params: { mediaId: string } }>({
    method: ['GET', 'HEAD'],
    url: '/api/player/media/:mediaId',
    preHandler: auth.requireDevice,
    handler: async (req, reply) => {
      const { mediaId } = req.params;
      if (!/^[0-9a-f-]{36}$/.test(mediaId)) throw notFound();
      if (!(await allowedMedia(req.device!.id)).has(mediaId)) throw forbidden('Mídia não pertence à programação deste telão.');
      const m = await db.media.findUnique({ where: { id: mediaId } });
      if (!m || !m.storageKey || m.status !== 'READY') throw notFound('Mídia indisponível.');
      reply.header('X-Checksum-Sha256', m.checksum ?? '');
      return serveObject(req, reply, storage, m.storageKey, {
        contentType: m.mimeType,
        size: Number(m.sizeBytes),
        cacheControl: 'private, max-age=31536000, immutable',
        etag: m.checksum ?? undefined,
      });
    },
  });
}
