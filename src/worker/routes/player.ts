import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { DEVICE_COOKIE, rateLimit, requireDevice, type HonoEnv } from '../auth';
import { isUuid, mapMedia, now, uuid } from '../db';
import { parse, serveObject } from '../lib/http';
import { AppError, forbidden, notFound } from '../lib/errors';
import { pairingCode, randomToken, safeEqual, sha256 } from '../lib/security';
import { SocketEvents } from '../../shared/types';
import { readBody } from './util';

/**
 * API exclusiva do player (dispositivo). Usa somente a credencial do dispositivo
 * (cookie HttpOnly), com acesso restrito à sua própria programação e mídias.
 */
export function playerRoutes(app: Hono<HonoEnv>) {
  app.get('/api/player/session', async (c) => {
    const { auth } = c.var.ctx;
    const raw = getCookie(c, DEVICE_COOKIE);
    const res = await auth.deviceFromCookie(raw);
    if (!res) return c.json({ paired: false }, 401);
    if (res.renew && raw) auth.setDeviceCookie(c, raw);
    return c.json({ paired: true, device: { id: res.device.id, name: res.device.name, identifier: res.device.identifier } });
  });

  app.post('/api/player/pairing', rateLimit('pairing', 20, 600), async (c) => {
    const { db, realtime } = c.var.ctx;
    await db.run('DELETE FROM "PairingRequest" WHERE "expiresAt" < ?', new Date(Date.now() - 3600_000).toISOString());
    const pollSecret = randomToken(24);
    const pollHash = await sha256(pollSecret);
    for (let i = 0; i < 5; i++) {
      const id = uuid();
      const code = pairingCode();
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      try {
        await db.run(
          'INSERT INTO "PairingRequest" ("id", "code", "pollSecretHash", "createdAt", "expiresAt", "userAgent") VALUES (?, ?, ?, ?, ?, ?)',
          id,
          code,
          pollHash,
          now(),
          expiresAt,
          c.req.header('user-agent')?.slice(0, 300) ?? null,
        );
        realtime.toAdmins(SocketEvents.PairingPending, { id });
        return c.json({ id, code, pollSecret, expiresAt });
      } catch {
        /* colisão de código — tenta novamente */
      }
    }
    throw new AppError(503, 'PAIRING_UNAVAILABLE', 'Não foi possível gerar um código agora.');
  });

  app.post('/api/player/pairing/:id/poll', async (c) => {
    const { db, auth } = c.var.ctx;
    const body = parse(z.object({ pollSecret: z.string().min(10).max(100) }), await readBody(c));
    const id = c.req.param('id');
    if (!isUuid(id)) throw notFound();
    const p = await db.first<{ id: string; pollSecretHash: string; consumedAt: string | null; approvedAt: string | null; approvedDeviceId: string | null; expiresAt: string }>(
      'SELECT * FROM "PairingRequest" WHERE "id" = ?',
      id,
    );
    if (!p || !safeEqual(p.pollSecretHash, await sha256(body.pollSecret))) throw notFound('Solicitação de vinculação não encontrada.');
    if (p.consumedAt) return c.json({ status: 'consumed' });
    const device = p.approvedDeviceId ? await db.first<{ id: string; name: string; identifier: string }>('SELECT "id", "name", "identifier" FROM "DisplayDevice" WHERE "id" = ?', p.approvedDeviceId) : null;
    if (!p.approvedAt || !device) return c.json({ status: p.expiresAt < now() ? 'expired' : 'pending', expiresAt: p.expiresAt });
    // aprovado: emite a credencial própria do dispositivo (uma única vez)
    const claimed = await db.run('UPDATE "PairingRequest" SET "consumedAt" = ? WHERE "id" = ? AND "consumedAt" IS NULL', now(), p.id);
    if (claimed.meta.changes !== 1) return c.json({ status: 'consumed' });
    const cookie = await auth.issueDeviceCredential(device.id, c.req.header('user-agent'));
    auth.setDeviceCookie(c, cookie);
    return c.json({ status: 'approved', device });
  });

  app.get('/api/player/manifest', requireDevice, async (c) => {
    const { db, devices } = c.var.ctx;
    const deviceId = c.var.device.id;
    await devices.recompute(deviceId).catch(() => {});
    c.var.ctx.waitUntil(db.run('UPDATE "DisplayDevice" SET "lastSeenAt" = ? WHERE "id" = ?', now(), deviceId).catch(() => {}));
    return c.json(await devices.manifest(deviceId));
  });

  /**
   * Mídias do telão: o arquivo vem do R2 em stream, com Range (206) para o <video>.
   * O player guarda o arquivo no Cache Storage e o reutiliza (não baixa de novo o que não mudou).
   */
  app.on(['GET', 'HEAD'], '/api/player/media/:mediaId', requireDevice, async (c) => {
    const ctx = c.var.ctx;
    const mediaId = c.req.param('mediaId');
    if (!isUuid(mediaId)) throw notFound();
    if (!(await ctx.devices.allowedMedia(c.var.device.id)).has(mediaId)) throw forbidden('Mídia não pertence à programação deste telão.');
    const r = await ctx.db.first('SELECT * FROM "Media" WHERE "id" = ?', mediaId);
    const m = r ? mapMedia(r) : null;
    if (!m || !m.storageKey || m.status !== 'READY') throw notFound('Mídia indisponível.');
    return serveObject(c.req.raw, ctx.bucket, m.storageKey, {
      contentType: m.mimeType,
      size: Number(m.sizeBytes),
      cacheControl: 'private, max-age=31536000, immutable',
      etag: m.checksum ?? undefined,
      extraHeaders: { 'X-Checksum-Sha256': m.checksum ?? '' },
    });
  });

}
