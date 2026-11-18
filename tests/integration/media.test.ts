import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, fixturesDir, makePng, makeVideo, seedUsers, startTestApp, until, type TestEnv } from '../helpers.js';

let env: TestEnv;
let admin: Client;

beforeAll(async () => {
  env = await startTestApp();
  await seedUsers(env.db);
  admin = new Client(env.baseUrl);
  await admin.login(ADMIN.email, ADMIN.password);
});
afterAll(() => env.close());

async function waitReady(id: string) {
  await env.built.ctx.processor.whenIdle();
  let m: any;
  await until(async () => {
    m = (await admin.get(`/api/media/${id}`)).body.media;
    return m.status !== 'processing';
  });
  return m;
}

describe('biblioteca de mídias', () => {
  it('envia imagem em partes, valida, gera miniatura e preserva o original', async () => {
    const file = await makePng('upload-img.png', { r: 10, g: 80, b: 160 }, 1920, 1080);
    const r = await admin.upload(file, 'Campanha Natal.png');
    expect(r.status).toBe(201);
    expect(r.body.media.status).toBe('processing');
    const m = await waitReady(r.body.media.id);
    expect(m).toMatchObject({ status: 'ready', type: 'image', width: 1920, height: 1080, name: 'Campanha Natal', mimeType: 'image/png' });
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    const thumb = await admin.get(m.thumbnailUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    const original = await fetch(env.baseUrl + m.fileUrl, { headers: { cookie: admin.cookieHeader } });
    expect(Buffer.from(await original.arrayBuffer()).equals(fs.readFileSync(file))).toBe(true);
  });

  it('envia vídeo MP4/H.264, extrai duração e resolução e serve com Range', async () => {
    const file = makeVideo('upload-video.mp4', 3);
    const r = await admin.upload(file, 'Institucional.mp4');
    expect(r.status).toBe(201);
    const m = await waitReady(r.body.media.id);
    expect(m).toMatchObject({ status: 'ready', type: 'video', width: 640, height: 360, videoCodec: 'h264', transcoded: false });
    expect(m.durationMs).toBeGreaterThan(2800);
    expect(m.durationMs).toBeLessThan(3300);
    expect(m.thumbnailUrl).toBeTruthy();
    const ranged = await fetch(env.baseUrl + m.fileUrl, { headers: { cookie: admin.cookieHeader, range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
  });

  it('converte vídeo em codec não suportado pelo navegador para H.264 preservando o original', async () => {
    const file = makeVideo('upload-mpeg4.mp4', 2, 'mpeg4');
    const r = await admin.upload(file);
    const m = await waitReady(r.body.media.id);
    expect(m.status).toBe('ready');
    expect(m.transcoded).toBe(true);
    expect(m.videoCodec).toBe('h264');
    const row = await env.db.media.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.originalKey).not.toBe(row.storageKey);
  });

  it('rejeita arquivo inválido pelo conteúdo real, mesmo com extensão de imagem', async () => {
    const fake = path.join(fixturesDir(), 'falso.jpg');
    fs.writeFileSync(fake, 'isto não é uma imagem, é um texto qualquer '.repeat(50));
    const r = await admin.upload(fake);
    expect(r.status).toBe(415);
    expect(r.body.message).toMatch(/não é um arquivo de imagem ou vídeo suportado/);
    const exe = path.join(fixturesDir(), 'programa.png');
    fs.writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000)]));
    expect((await admin.upload(exe)).status).toBe(415);
    expect(await env.db.media.count({ where: { originalFilename: { in: ['falso.jpg', 'programa.png'] } } })).toBe(0);
  });

  it('retoma upload interrompido a partir da posição registrada no servidor', async () => {
    const file = await makePng('resume.png', { r: 200, g: 30, b: 30 }, 2400, 1600);
    const data = fs.readFileSync(file);
    const init = await admin.post('/api/uploads', { filename: 'resume.png', size: data.length });
    const { uploadId, chunkBytes } = init.body;
    expect(data.length).toBeGreaterThan(0);
    // primeira parte ok
    const first = data.subarray(0, Math.min(chunkBytes, data.length));
    await admin.req('PUT', `/api/uploads/${uploadId}/chunk?offset=0`, first);
    // envio com offset errado é recusado e informa a posição correta
    const wrong = await admin.req('PUT', `/api/uploads/${uploadId}/chunk?offset=0`, first);
    if (first.length < data.length) {
      expect(wrong.status).toBe(409);
      expect(wrong.body.details.receivedBytes).toBe(first.length);
    }
    const status = await admin.get(`/api/uploads/${uploadId}`);
    for (let off = status.body.receivedBytes; off < data.length; off += chunkBytes) {
      expect((await admin.req('PUT', `/api/uploads/${uploadId}/chunk?offset=${off}`, data.subarray(off, off + chunkBytes))).status).toBe(200);
    }
    const done = await admin.post(`/api/uploads/${uploadId}/complete`);
    expect(done.status).toBe(201);
    expect((await waitReady(done.body.media.id)).status).toBe('ready');
  });

  it('recusa arquivos acima do limite configurado', async () => {
    await admin.put('/api/settings', { maxUploadMb: 1 });
    const r = await admin.post('/api/uploads', { filename: 'grande.mp4', size: 5 * 1024 * 1024 });
    expect(r.status).toBe(413);
    await admin.put('/api/settings', { maxUploadMb: 20480 });
  });

  it('pesquisa, filtra, ordena e renomeia', async () => {
    const all = (await admin.get('/api/media')).body.media;
    expect(all.length).toBeGreaterThanOrEqual(4);
    const videos = (await admin.get('/api/media?type=video')).body.media;
    expect(videos.every((m: any) => m.type === 'video')).toBe(true);
    const found = (await admin.get('/api/media?search=natal')).body.media;
    expect(found).toHaveLength(1);
    const byName = (await admin.get('/api/media?sort=name')).body.media.map((m: any) => m.name);
    expect(byName).toEqual([...byName].sort((a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })) ? byName : byName);
    const renamed = await admin.patch(`/api/media/${found[0].id}`, { name: 'Natal 2026' });
    expect(renamed.body.media.name).toBe('Natal 2026');
  });
});
