import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { inject } from 'vitest';

export { ADMIN, EDITOR, LEGACY } from './worker-server';

const require = createRequire(import.meta.url);

export const baseUrl = () => inject('baseUrl');

let ipSeq = 0;
/** IP fictício por cliente (CF-Connecting-IP), para os limites de tentativas não interferirem entre testes */
const nextIp = () => `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${++ipSeq % 250}`;

/** Cliente HTTP mínimo com cookies e cabeçalho CSRF */
export class Client {
  cookies = new Map<string, string>();
  ip = nextIp();
  constructor(public baseUrl: string = inject('baseUrl')) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'x-gd-csrf': '1', 'cf-connecting-ip': this.ip, ...extra };
    if (this.cookies.size) headers.cookie = this.cookieHeader;
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      payload = body as unknown as BodyInit;
      headers['content-type'] ??= 'application/octet-stream';
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
    const ct = res.headers.get('content-type') ?? '';
    let json: any = null;
    if (ct.includes('json')) json = await res.json().catch(() => null);
    else json = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: json, headers: res.headers };
  }
  get(url: string, extra?: Record<string, string>) {
    return this.req('GET', url, undefined, extra);
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

  /** Inicia o upload (multipart no R2) */
  initUpload(data: Buffer, filename: string) {
    return this.post('/api/uploads', { filename, size: data.length, checksum: sha256(data) });
  }

  /** Envia todas as partes (pelo Worker — modo sem credenciais S3, como no desenvolvimento local) */
  async sendParts(uploadId: string, data: Buffer, chunkBytes: number) {
    for (let off = 0, n = 1; off < data.length; off += chunkBytes, n++) {
      const u = await this.post(`/api/uploads/${uploadId}/parts/${n}/url`);
      if (u.status !== 200) return u;
      const r = await this.req('PUT', u.body.url, new Uint8Array(data.subarray(off, off + chunkBytes)));
      if (r.status !== 200) return r;
    }
    return null;
  }

  /** Upload completo, como o painel faz (metadados que o navegador extrairia) */
  async upload(file: string, meta: Record<string, unknown>, filename = path.basename(file)) {
    const data = fs.readFileSync(file);
    const init = await this.initUpload(data, filename);
    if (init.status !== 200) return init;
    const { uploadId, chunkBytes } = init.body;
    const thumb = await sharp({ create: { width: 480, height: 270, channels: 3, background: { r: 10, g: 10, b: 10 } } }).webp().toBuffer();
    await this.req('PUT', `/api/uploads/${uploadId}/derivative/thumbnail`, new Uint8Array(thumb), { 'content-type': 'image/webp' });
    const failed = await this.sendParts(uploadId, data, chunkBytes);
    if (failed) return failed;
    return this.post(`/api/uploads/${uploadId}/complete`, { checksum: sha256(data), ...meta });
  }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

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

/** Vídeo H.264 real. `bitrate` alto gera arquivos com várias partes de upload. */
export function makeVideo(name = 'video.mp4', seconds = 2, bitrate?: string) {
  const file = path.join(fixturesDir(), name);
  if (fs.existsSync(file)) return file;
  const ffmpeg = require('ffmpeg-static') as string;
  const rate = bitrate ? ['-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate, '-x264-params', 'nal-hrd=cbr'] : [];
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=25:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...rate, '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file]);
  return file;
}

// ---------------- WebSocket (painel e player) ----------------

export interface TestSocket {
  ws: WebSocket;
  messages: any[];
  /** responde automaticamente a comandos (padrão: ok) */
  onCommand: ((cmd: any) => any) | null;
  send(msg: unknown): void;
  waitFor(pred: (m: any) => boolean, timeout?: number): Promise<any>;
  close(): void;
  closed: Promise<void>;
}

export function connectSocket(role: 'admin' | 'player', cookie: string, base = inject('baseUrl')): Promise<TestSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/realtime/${role}`, { headers: { cookie } } as unknown as string[]);
  const messages: any[] = [];
  const waiters = new Set<{ pred: (m: any) => boolean; resolve: (m: any) => void }>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const s: TestSocket = {
    ws,
    messages,
    onCommand: () => ({ ok: true }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(pred, timeout = 10_000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.add(w);
        setTimeout(() => {
          if (waiters.delete(w)) reject(new Error('timeout aguardando mensagem WebSocket'));
        }, timeout);
      });
    },
    close: () => ws.close(),
    closed,
  };
  ws.onmessage = (ev) => {
    if (ev.data === 'pong') return;
    const m = JSON.parse(String(ev.data));
    messages.push(m);
    if (m.t === 'cmd' && s.onCommand) {
      const ack = s.onCommand(m.d);
      if (ack) s.send({ t: 'ack', id: m.id, d: ack });
    }
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.delete(w);
        w.resolve(m);
      }
  };
  ws.onclose = () => resolveClosed();
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(s);
    ws.onerror = () => reject(new Error('falha ao conectar WebSocket'));
  });
}

export const isEvent = (e: string, pred: (d: any) => boolean = () => true) => (m: any) => m.t === 'event' && m.e === e && pred(m.d);

export async function until(fn: () => Promise<boolean> | boolean, timeout = 30_000, step = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('condição não satisfeita a tempo');
}

/** Executa todo o fluxo de vinculação e retorna o cliente do dispositivo */
export async function pairDevice(admin: Client, name = 'Telão da Matriz') {
  const player = new Client();
  const req = await player.post('/api/player/pairing');
  if (req.status !== 200) throw new Error(`pairing falhou ${JSON.stringify(req.body)}`);
  const approve = await admin.post('/api/devices/pair', { code: req.body.code, name });
  if (approve.status !== 200) throw new Error(`pair falhou ${JSON.stringify(approve.body)}`);
  const poll = await player.post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: req.body.pollSecret });
  if (poll.body.status !== 'approved') throw new Error('pairing não aprovado');
  return { player, deviceId: approve.body.device.id as string, cookie: player.cookieHeader };
}

export const uniq = (p: string) => `${p} ${Math.random().toString(36).slice(2, 8)}`;
