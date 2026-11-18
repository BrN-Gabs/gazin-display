import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppContext } from './context';
import type { Env } from './env';
import { isUuid, mapUser, now, uuid } from './db';
import { AppError, forbidden, unauthorized } from './lib/errors';
import { randomToken, safeEqual, sha256 } from './lib/security';

export const SESSION_COOKIE = 'gd_session';
export const DEVICE_COOKIE = 'gd_device';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: 'ADMIN' | 'EDITOR';
  canPublish: boolean;
  sessionId: string;
}

export interface AuthDevice {
  id: string;
  name: string;
  identifier: string;
  credentialId: string;
}

export type HonoEnv = { Bindings: Env; Variables: { ctx: AppContext; user: AuthUser; device: AuthDevice } };
export type C = Context<HonoEnv>;

export const clientIp = (c: C) => c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? '127.0.0.1';

export class AuthService {
  constructor(private ctx: AppContext) {}

  private cookieSecure(c: C) {
    const mode = this.ctx.config.cookieSecureMode;
    if (mode === 'true') return true;
    if (mode === 'false') return false;
    return new URL(c.req.url).protocol === 'https:';
  }

  setSessionCookie(c: C, token: string) {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.cookieSecure(c),
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(this.ctx.config.sessionTtlMs / 1000),
    });
  }

  setDeviceCookie(c: C, value: string) {
    setCookie(c, DEVICE_COOKIE, value, {
      httpOnly: true,
      secure: this.cookieSecure(c),
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(this.ctx.config.deviceTtlMs / 1000),
    });
  }

  clearSessionCookie(c: C) {
    setCookie(c, SESSION_COOKIE, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'Lax', secure: this.cookieSecure(c) });
  }

  async createSession(userId: string, ip?: string, userAgent?: string) {
    const token = randomToken(32);
    const ts = now();
    await this.ctx.db.run(
      'INSERT INTO "Session" ("id", "tokenHash", "userId", "createdAt", "lastSeenAt", "expiresAt", "ip", "userAgent") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uuid(),
      await sha256(token),
      userId,
      ts,
      ts,
      new Date(Date.now() + this.ctx.config.sessionTtlMs).toISOString(),
      ip ?? null,
      userAgent?.slice(0, 300) ?? null,
    );
    return token;
  }

  async userFromToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token || token.length > 100) return null;
    const row = await this.ctx.db.first<Record<string, unknown>>(
      `SELECT s."id" AS "_sid", s."lastSeenAt" AS "_lastSeenAt", s."expiresAt" AS "_expiresAt", u.*
       FROM "Session" s JOIN "User" u ON u."id" = s."userId" WHERE s."tokenHash" = ?`,
      await sha256(token),
    );
    if (!row) return null;
    const u = mapUser(row);
    const sessionId = row._sid as string;
    const nowMs = Date.now();
    if (new Date(row._expiresAt as string).getTime() < nowMs || !u.active) {
      await this.ctx.db.run('DELETE FROM "Session" WHERE "id" = ?', sessionId).catch(() => {});
      return null;
    }
    // expiração deslizante (atualiza no máximo 1x por minuto)
    if (nowMs - new Date(row._lastSeenAt as string).getTime() > 60_000) {
      this.ctx.waitUntil(
        this.ctx.db
          .run('UPDATE "Session" SET "lastSeenAt" = ?, "expiresAt" = ? WHERE "id" = ?', new Date(nowMs).toISOString(), new Date(nowMs + this.ctx.config.sessionTtlMs).toISOString(), sessionId)
          .catch(() => {}),
      );
    }
    return { id: u.id, name: u.name, email: u.email, username: u.username, role: u.role, canPublish: u.role === 'ADMIN' || u.canPublish, sessionId };
  }

  async destroySession(token: string | undefined) {
    if (!token) return;
    await this.ctx.db.run('DELETE FROM "Session" WHERE "tokenHash" = ?', await sha256(token));
  }

  async issueDeviceCredential(deviceId: string, userAgent?: string) {
    const secret = randomToken(32);
    const id = uuid();
    await this.ctx.db.run(
      'INSERT INTO "DeviceCredential" ("id", "deviceId", "secretHash", "createdAt", "expiresAt", "userAgent") VALUES (?, ?, ?, ?, ?, ?)',
      id,
      deviceId,
      await sha256(secret),
      now(),
      new Date(Date.now() + this.ctx.config.deviceTtlMs).toISOString(),
      userAgent?.slice(0, 300) ?? null,
    );
    return `${id}.${secret}`;
  }

  /** Valida a credencial do dispositivo. `renew` indica que o cookie deve ser reenviado com nova validade. */
  async deviceFromCookie(value: string | undefined): Promise<{ device: AuthDevice; renew: boolean } | null> {
    if (!value || value.length > 200) return null;
    const [id, secret] = value.split('.');
    if (!id || !secret || !isUuid(id)) return null;
    const row = await this.ctx.db.first<Record<string, string | null>>(
      `SELECT c."id", c."secretHash", c."expiresAt", c."revokedAt", c."lastUsedAt", d."id" AS "deviceId", d."name", d."identifier"
       FROM "DeviceCredential" c JOIN "DisplayDevice" d ON d."id" = c."deviceId" WHERE c."id" = ?`,
      id,
    );
    if (!row || row.revokedAt || new Date(row.expiresAt!).getTime() < Date.now()) return null;
    if (!safeEqual(row.secretHash!, await sha256(secret))) return null;
    const nowMs = Date.now();
    const renew = new Date(row.expiresAt!).getTime() - nowMs < this.ctx.config.deviceTtlMs / 2;
    if (renew || !row.lastUsedAt || nowMs - new Date(row.lastUsedAt).getTime() > 5 * 60_000) {
      this.ctx.waitUntil(
        this.ctx.db
          .run(
            `UPDATE "DeviceCredential" SET "lastUsedAt" = ?${renew ? ', "expiresAt" = ?' : ''} WHERE "id" = ?`,
            ...(renew ? [new Date(nowMs).toISOString(), new Date(nowMs + this.ctx.config.deviceTtlMs).toISOString(), id] : [new Date(nowMs).toISOString(), id]),
          )
          .catch(() => {}),
      );
    }
    return { device: { id: row.deviceId!, name: row.name!, identifier: row.identifier!, credentialId: id }, renew };
  }
}

// ---------- guards (middlewares) ----------

export const requireUser: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const user = await c.var.ctx.auth.userFromToken(getCookie(c, SESSION_COOKIE));
  if (!user) throw unauthorized();
  c.set('user', user);
  await next();
};

export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const user = await c.var.ctx.auth.userFromToken(getCookie(c, SESSION_COOKIE));
  if (!user) throw unauthorized();
  if (user.role !== 'ADMIN') throw forbidden('Somente administradores podem realizar esta ação.');
  c.set('user', user);
  await next();
};

export const requirePublisher: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const user = await c.var.ctx.auth.userFromToken(getCookie(c, SESSION_COOKIE));
  if (!user) throw unauthorized();
  if (!user.canPublish) throw forbidden('Seu perfil não tem permissão para publicar ou controlar telões.');
  c.set('user', user);
  await next();
};

export const requireDevice: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const raw = getCookie(c, DEVICE_COOKIE);
  const res = await c.var.ctx.auth.deviceFromCookie(raw);
  if (!res) throw unauthorized('Dispositivo não autorizado.');
  c.set('device', res.device);
  if (res.renew && raw) c.var.ctx.auth.setDeviceCookie(c, raw);
  await next();
};

/**
 * Limite de tentativas por IP (e opcionalmente por usuário), persistido no D1.
 * Janela fixa: `max` requisições a cada `windowSec` segundos.
 */
export function rateLimit(name: string, max: number, windowSec: number, by: 'ip' | 'user' = 'ip'): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const who = by === 'user' ? (c.var.user?.id ?? clientIp(c)) : clientIp(c);
    const key = `${name}:${who}`;
    const nowMs = Date.now();
    const row = await c.var.ctx.db.first<{ count: number; resetAt: number }>(
      `INSERT INTO "RateLimit" ("key", "count", "resetAt") VALUES (?, 1, ?)
       ON CONFLICT("key") DO UPDATE SET
         "count" = CASE WHEN "RateLimit"."resetAt" <= ? THEN 1 ELSE "RateLimit"."count" + 1 END,
         "resetAt" = CASE WHEN "RateLimit"."resetAt" <= ? THEN excluded."resetAt" ELSE "RateLimit"."resetAt" END
       RETURNING "count", "resetAt"`,
      key,
      nowMs + windowSec * 1000,
      nowMs,
      nowMs,
    );
    if (row && row.count > max) {
      const wait = Math.max(1, Math.ceil((row.resetAt - nowMs) / 1000));
      c.header('Retry-After', String(wait));
      throw new AppError(429, 'RATE_LIMITED', `Muitas tentativas. Aguarde ${wait} segundos e tente novamente.`);
    }
    await next();
  };
}
