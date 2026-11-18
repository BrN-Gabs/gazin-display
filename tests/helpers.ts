import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { io as ioClient, type Socket } from 'socket.io-client';
import { inject } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { buildApp, type BuiltApp } from '../src/server/app.js';
import { createDb, type Db } from '../src/server/db.js';
import { hashPassword } from '../src/server/lib/security.js';

const require = createRequire(import.meta.url);

export const ADMIN = { email: 'admin@teste.local', password: 'Senha-Forte-123' };
export const EDITOR = { email: 'editor@teste.local', password: 'Senha-Forte-456' };

export interface TestEnv {
  built: BuiltApp;
  db: Db;
  baseUrl: string;
  storageDir: string;
  close(): Promise<void>;
}

export async function startTestApp(): Promise<TestEnv> {
  const databaseUrl = inject('databaseUrl');
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    STORAGE_DIR: storageDir,
    LOG_LEVEL: 'warn',
    UPLOAD_CHUNK_MB: '1',
    WEB_DIST_DIR: path.join(storageDir, 'no-web'),
  });
  const db = createDb(databaseUrl);
  await resetDb(db);
  const built = await buildApp(config, { db, logger: { level: 'warn' } });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  await built.startBackground();
  const addr = built.app.server.address() as { port: number };
  return {
    built,
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    storageDir,
    async close() {
      await built.close();
      await db.$disconnect();
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export async function resetDb(db: Db) {
  const tables = ['AuditLog', 'DeviceCommand', 'Schedule', 'PairingRequest', 'DeviceCredential', 'DisplayDevice', 'PlaylistVersion', 'PlaylistItem', 'Playlist', 'UploadSession', 'Media', 'Session', 'AppSetting', 'User'];
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

export async function seedUsers(db: Db) {
  await db.user.create({ data: { name: 'Admin Teste', email: ADMIN.email, passwordHash: await hashPassword(ADMIN.password), role: 'ADMIN' } });
  await db.user.create({ data: { name: 'Editor Teste', email: EDITOR.email, passwordHash: await hashPassword(EDITOR.password), role: 'EDITOR', canPublish: false } });
}

/** Cliente HTTP mínimo com cookies e cabeçalho CSRF */
export class Client {
  cookies = new Map<string, string>();
  constructor(public baseUrl: string) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'x-gd-csrf': '1', ...extra };
    if (this.cookies.size) headers.cookie = this.cookieHeader;
    let payload: BodyInit | undefined;
    if (body instanceof Buffer) {
      payload = body as unknown as BodyInit;
      headers['content-type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(this.baseUrl + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const k = pair!.slice(0, i);
      const v = pair!.slice(i + 1);
      if (v === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body?: unknown) {
    return this.req('POST', url, body ?? {});
  }
  put(url: string, body?: unknown) {
    return this.req('PUT', url, body);
  }
  patch(url: string, body?: unknown) {
    return this.req('PATCH', url, body);
  }
  del(url: string) {
    return this.req('DELETE', url);
  }

  async login(email: string, password: string) {
    const r = await this.post('/api/auth/login', { login: email, password });
    if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  }

  /** Upload em partes, como o painel faz */
  async upload(file: string, filename = path.basename(file)) {
    const data = fs.readFileSync(file);
    const init = await this.post('/api/uploads', { filename, size: data.length });
    if (init.status !== 200) return init;
    const { uploadId, chunkBytes } = init.body;
    for (let off = 0; off < data.length; off += chunkBytes) {
      const r = await this.req('PUT', `/api/uploads/${uploadId}/chunk?offset=${off}`, data.subarray(off, off + chunkBytes));
      if (r.status !== 200) return r;
    }
    return this.post(`/api/uploads/${uploadId}/complete`);
  }
}

export function fixturesDir() {
  const dir = path.resolve('.data/fixtures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function makePng(name = 'imagem.png', color = { r: 0, g: 85, b: 165 }, w = 1280, h = 720) {
  const file = path.join(fixturesDir(), name);
  if (!fs.existsSync(file)) await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toFile(file);
  return file;
}

export function makeVideo(name = 'video.mp4', seconds = 2, codec: 'h264' | 'mpeg4' = 'h264') {
  const file = path.join(fixturesDir(), name);
  if (fs.existsSync(file)) return file;
  const ffmpeg = require('ffmpeg-static') as string;
  const vcodec = codec === 'h264' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-c:v', 'mpeg4'];
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...vcodec, '-c:a', 'aac', '-shortest', file]);
  return file;
}

export function playerSocket(baseUrl: string, cookie: string): Socket {
  return ioClient(`${baseUrl}/player`, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie }, reconnection: false, forceNew: true });
}

export function adminSocket(baseUrl: string, cookie: string): Socket {
  return ioClient(`${baseUrl}/admin`, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie }, reconnection: false, forceNew: true });
}

export function waitFor<T = unknown>(socket: Socket, event: string, timeout = 10_000, predicate: (v: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout aguardando ${event}`));
    }, timeout);
    const handler = (v: T) => {
      if (!predicate(v)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(v);
    };
    socket.on(event, handler);
  });
}

export async function until(fn: () => Promise<boolean> | boolean, timeout = 30_000, step = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('condição não satisfeita a tempo');
}

/** Executa todo o fluxo de vinculação e retorna o cookie do dispositivo */
export async function pairDevice(admin: Client, baseUrl: string, name = 'Telão da Matriz') {
  const player = new Client(baseUrl);
  const req = await player.post('/api/player/pairing');
  const approve = await admin.post('/api/devices/pair', { code: req.body.code, name });
  if (approve.status !== 200) throw new Error(`pair falhou ${JSON.stringify(approve.body)}`);
  const poll = await player.post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: req.body.pollSecret });
  if (poll.body.status !== 'approved') throw new Error('pairing não aprovado');
  return { player, deviceId: approve.body.device.id as string, cookie: player.cookieHeader };
}
