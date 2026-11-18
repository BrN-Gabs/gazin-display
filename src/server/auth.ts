import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { forbidden, unauthorized } from './lib/errors.js';
import { randomToken, safeEqual, sha256 } from './lib/security.js';

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

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    device?: AuthDevice;
  }
}

export class AuthService {
  constructor(private ctx: AppContext) {}

  private get sessionTtlMs() {
    return this.ctx.config.SESSION_TTL_HOURS * 3600_000;
  }
  private get deviceTtlMs() {
    return this.ctx.config.DEVICE_TOKEN_TTL_DAYS * 86400_000;
  }

  sessionCookieOptions() {
    return {
      httpOnly: true,
      secure: this.ctx.config.cookieSecure,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: Math.floor(this.sessionTtlMs / 1000),
    };
  }

  deviceCookieOptions() {
    return {
      httpOnly: true,
      secure: this.ctx.config.cookieSecure,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: Math.floor(this.deviceTtlMs / 1000),
    };
  }

  async createSession(userId: string, ip?: string, userAgent?: string) {
    const token = randomToken(32);
    await this.ctx.db.session.create({
      data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + this.sessionTtlMs), ip, userAgent: userAgent?.slice(0, 300) },
    });
    return token;
  }

  async userFromToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token || token.length > 100) return null;
    const session = await this.ctx.db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() < now || !session.user.active) {
      await this.ctx.db.session.delete({ where: { id: session.id } }).catch(() => {});
      return null;
    }
    // expiração deslizante (atualiza no máximo 1x por minuto)
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.ctx.db.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + this.sessionTtlMs) } })
        .catch(() => {});
    }
    const u = session.user;
    return { id: u.id, name: u.name, email: u.email, username: u.username, role: u.role, canPublish: u.role === 'ADMIN' || u.canPublish, sessionId: session.id };
  }

  async destroySession(token: string | undefined) {
    if (!token) return;
    await this.ctx.db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  }

  async issueDeviceCredential(deviceId: string, userAgent?: string) {
    const secret = randomToken(32);
    const cred = await this.ctx.db.deviceCredential.create({
      data: { deviceId, secretHash: sha256(secret), expiresAt: new Date(Date.now() + this.deviceTtlMs), userAgent: userAgent?.slice(0, 300) },
    });
    return `${cred.id}.${secret}`;
  }

  /** Valida a credencial do dispositivo. `renew` indica que o cookie deve ser reenviado com nova validade. */
  async deviceFromCookie(value: string | undefined): Promise<{ device: AuthDevice; renew: boolean } | null> {
    if (!value || value.length > 200) return null;
    const [id, secret] = value.split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const cred = await this.ctx.db.deviceCredential.findUnique({ where: { id }, include: { device: true } });
    if (!cred || cred.revokedAt || cred.expiresAt.getTime() < Date.now()) return null;
    if (!safeEqual(cred.secretHash, sha256(secret))) return null;
    const now = Date.now();
    const renew = cred.expiresAt.getTime() - now < this.deviceTtlMs / 2;
    if (renew || !cred.lastUsedAt || now - cred.lastUsedAt.getTime() > 5 * 60_000) {
      await this.ctx.db.deviceCredential
        .update({ where: { id }, data: { lastUsedAt: new Date(now), ...(renew ? { expiresAt: new Date(now + this.deviceTtlMs) } : {}) } })
        .catch(() => {});
    }
    return { device: { id: cred.device.id, name: cred.device.name, identifier: cred.device.identifier, credentialId: cred.id }, renew };
  }

  // ---------- guards (preHandlers) ----------

  requireUser = async (req: FastifyRequest) => {
    const user = await this.userFromToken(req.cookies[SESSION_COOKIE]);
    if (!user) throw unauthorized();
    req.user = user;
  };

  requireAdmin = async (req: FastifyRequest) => {
    await this.requireUser(req);
    if (req.user!.role !== 'ADMIN') throw forbidden('Somente administradores podem realizar esta ação.');
  };

  requirePublisher = async (req: FastifyRequest) => {
    await this.requireUser(req);
    if (!req.user!.canPublish) throw forbidden('Seu perfil não tem permissão para publicar ou controlar telões.');
  };

  requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const res = await this.deviceFromCookie(req.cookies[DEVICE_COOKIE]);
    if (!res) throw unauthorized('Dispositivo não autorizado.');
    req.device = res.device;
    if (res.renew) reply.setCookie(DEVICE_COOKIE, req.cookies[DEVICE_COOKIE]!, this.deviceCookieOptions());
  };
}
