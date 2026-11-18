import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, EDITOR, fixturesDir, makePng, makeVideo, sha256 } from '../helpers';

const MiB = 1024 * 1024;

describe('mídias e upload direto ao R2 (multipart)', () => {
  const admin = new Client();
  beforeAll(async () => {
    await admin.login(ADMIN.email, ADMIN.password);
  });

  it('configuração de upload informa partes, limite e uso do armazenamento', async () => {
    const r = await admin.get('/api/uploads/config');
    expect(r.status).toBe(200);
    expect(r.body.chunkBytes).toBe(5 * MiB);
    expect(r.body.direct).toBe(false); // sem credenciais S3 no ambiente de teste
    expect(r.body.storage.limitBytes).toBe(30 * 1024 * MiB);
  });

  it('upload de imagem: validada, cadastrada como pronta e servida com miniatura', async () => {
    const file = await makePng('upload-imagem.png', { r: 200, g: 30, b: 30 });
    const r = await admin.upload(file, { width: 1280, height: 720 });
    expect(r.status).toBe(201);
    const m = r.body.media;
    expect(m.type).toBe('image');
    expect(m.status).toBe('ready');
    expect(m.mimeType).toBe('image/png');
    expect(m.width).toBe(1280);
    expect(m.checksum).toBe(sha256(fs.readFileSync(file)));
    const thumb = await admin.get(m.thumbnailUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    const full = await admin.get(m.fileUrl);
    expect(full.status).toBe(200);
    expect(Buffer.compare(full.body, fs.readFileSync(file))).toBe(0);
  });

  it('upload de vídeo em várias partes, reprodução com Range (206) e HEAD', async () => {
    const file = makeVideo('upload-video-grande.mp4', 6, '12M');
    const data = fs.readFileSync(file);
    expect(data.length).toBeGreaterThan(5 * MiB); // mais de uma parte
    const r = await admin.upload(file, { width: 1280, height: 720, durationMs: 6000, videoCodec: 'h264' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const m = r.body.media;
    expect(m.type).toBe('video');
    expect(m.sizeBytes).toBe(data.length);
    expect(m.durationMs).toBe(6000);

    const range = await admin.get(m.fileUrl, { range: 'bytes=100-1099' });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 100-1099/${data.length}`);
    expect(range.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.compare(range.body, data.subarray(100, 1100))).toBe(0);
    const tail = await admin.get(m.fileUrl, { range: 'bytes=-500' });
    expect(tail.status).toBe(206);
    expect(Buffer.compare(tail.body, data.subarray(data.length - 500))).toBe(0);
    expect((await admin.get(m.fileUrl, { range: `bytes=${data.length + 10}-` })).status).toBe(416);
    const head = await admin.req('HEAD', m.fileUrl);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(data.length));
    const full = await admin.get(m.fileUrl);
    expect(sha256(full.body)).toBe(sha256(data));
  });

  it('rejeita arquivo inválido pela assinatura real (texto com extensão .jpg) e não cria registro', async () => {
    const file = path.join(fixturesDir(), 'falso.jpg');
    fs.writeFileSync(file, 'isto não é uma imagem'.repeat(100));
    const before = (await admin.get('/api/media')).body.media.length;
    const r = await admin.upload(file, { width: 10, height: 10 });
    expect(r.status).toBe(415);
    expect((await admin.get('/api/media')).body.media.length).toBe(before);
  });

  it('rejeita formatos que exigiriam conversão e vídeo HEVC', async () => {
    const mov = await admin.post('/api/uploads', { filename: 'gravacao.mov', size: 1000 });
    expect(mov.status).toBe(415);
    const file = makeVideo('hevc-declarado.mp4', 1);
    const r = await admin.upload(file, { width: 1280, height: 720, durationMs: 1000, videoCodec: 'hevc' }, 'hevc-declarado.mp4');
    expect(r.status).toBe(415);
    expect(r.body.message).toMatch(/HEVC/);
  });

  it('upload incompleto não pode ser concluído; parte com tamanho errado é recusada; cancelamento libera o espaço', async () => {
    const data = Buffer.alloc(7 * MiB, 7);
    const init = await admin.initUpload(data, 'incompleto.mp4');
    expect(init.status).toBe(200);
    const id = init.body.uploadId;
    expect((await admin.post(`/api/uploads/${id}/complete`, {})).body.error).toBe('UPLOAD_INCOMPLETE');
    const wrong = await admin.req('PUT', `/api/uploads/${id}/parts/1`, new Uint8Array(data.subarray(0, 1000)));
    expect(wrong.status).toBe(400);
    // parte fora de ordem
    const skip = await admin.post(`/api/uploads/${id}/parts/2/url`);
    expect(skip.status).toBe(409);
    expect(skip.body.error).toBe('OFFSET_MISMATCH');
    const reserved = (await admin.get('/api/uploads/config')).body.storage.reservedBytes;
    expect(reserved).toBeGreaterThanOrEqual(data.length);
    expect((await admin.del(`/api/uploads/${id}`)).status).toBe(200);
    expect((await admin.get(`/api/uploads/${id}`)).body.status).toBe('cancelled');
    expect((await admin.get('/api/uploads/config')).body.storage.reservedBytes).toBe(reserved - data.length);
  });

  it('upload de outro usuário não é acessível', async () => {
    const data = Buffer.alloc(1000, 1);
    const init = await admin.initUpload(data, 'privado.png');
    const editor = new Client();
    await editor.login(EDITOR.email, EDITOR.password);
    expect((await editor.get(`/api/uploads/${init.body.uploadId}`)).status).toBe(404);
    expect((await editor.post(`/api/uploads/${init.body.uploadId}/complete`, {})).status).toBe(404);
    await admin.del(`/api/uploads/${init.body.uploadId}`);
  });

  it('evita upload duplicado do mesmo arquivo', async () => {
    const file = await makePng('duplicada.png', { r: 1, g: 2, b: 3 });
    expect((await admin.upload(file, { width: 1280, height: 720 })).status).toBe(201);
    const again = await admin.initUpload(fs.readFileSync(file), 'copia.png');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('DUPLICATE_MEDIA');
  });

  it('respeita o limite lógico de armazenamento configurável', async () => {
    const before = (await admin.get('/api/settings')).body.settings.storageLimitGb;
    expect((await admin.put('/api/settings', { storageLimitGb: 1 })).status).toBe(200);
    const big = await admin.post('/api/uploads', { filename: 'enorme.mp4', size: 2 * 1024 * MiB });
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('STORAGE_LIMIT');
    expect((await admin.put('/api/settings', { storageLimitGb: before })).status).toBe(200);
  });

  it('exclusão: mídia em rascunho exige confirmação e remove os arquivos do R2', async () => {
    const file = await makePng('para-excluir.png', { r: 9, g: 9, b: 9 });
    const m = (await admin.upload(file, { width: 1280, height: 720 })).body.media;
    const pl = (await admin.post('/api/playlists', { name: 'Rascunho com mídia' })).body.playlist;
    const saved = await admin.put(`/api/playlists/${pl.id}`, { revision: 1, items: [{ mediaId: m.id }] });
    expect(saved.status).toBe(200);
    const r1 = await admin.del(`/api/media/${m.id}`);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('MEDIA_IN_DRAFTS');
    expect((await admin.del(`/api/media/${m.id}?force=true`)).status).toBe(200);
    expect((await admin.get(`/api/media/${m.id}`)).status).toBe(404);
    const p = await admin.get(`/api/playlists/${pl.id}`);
    expect(p.body.playlist.items).toHaveLength(0);
    expect(p.body.playlist.revision).toBe(3);
  });

  it('renomeia e busca mídias (sem diferenciar maiúsculas e acentos maiúsculos)', async () => {
    const file = await makePng('busca.png', { r: 50, g: 60, b: 70 });
    const m = (await admin.upload(file, { width: 1280, height: 720 })).body.media;
    expect((await admin.patch(`/api/media/${m.id}`, { name: 'Promoção Ação' })).status).toBe(200);
    const found = await admin.get(`/api/media?search=${encodeURIComponent('PROMOÇÃO')}`);
    expect(found.body.media.some((x: any) => x.id === m.id)).toBe(true);
    const typed = await admin.get('/api/media?type=video');
    expect(typed.body.media.every((x: any) => x.type === 'video')).toBe(true);
  });
});
