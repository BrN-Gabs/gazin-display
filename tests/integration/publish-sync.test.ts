import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerManifest } from '../../src/shared/types.js';
import { ADMIN, Client, EDITOR, makePng, makeVideo, pairDevice, playerSocket, seedUsers, startTestApp, until, waitFor, type TestEnv } from '../helpers.js';

let env: TestEnv;
let admin: Client;
const media: Record<string, string> = {};

async function uploadReady(c: Client, file: string, name: string) {
  const r = await c.upload(file, name);
  await env.built.ctx.processor.whenIdle();
  await until(async () => (await env.db.media.findUniqueOrThrow({ where: { id: r.body.media.id } })).status === 'READY');
  return r.body.media.id as string;
}

beforeAll(async () => {
  env = await startTestApp();
  await seedUsers(env.db);
  admin = new Client(env.baseUrl);
  await admin.login(ADMIN.email, ADMIN.password);
  media.video1 = await uploadReady(admin, makeVideo('inst.mp4', 2), 'Vídeo Institucional Gazin.mp4');
  media.image = await uploadReady(admin, await makePng('camp.png', { r: 250, g: 200, b: 0 }), 'Imagem de Campanha.png');
  media.video2 = await uploadReady(admin, makeVideo('pub.mp4', 2), 'Vídeo Publicitário.mp4');
  media.video3 = await uploadReady(admin, makeVideo('novo.mp4', 2), 'Novo Vídeo.mp4');
});
afterAll(() => env.close());

describe('playlists, publicação e sincronização', () => {
  let playlistId: string;
  let deviceId: string;
  let deviceCookie: string;
  let revision: number;

  it('cria playlist e salva rascunho com duração personalizada', async () => {
    const created = await admin.post('/api/playlists', { name: 'Telão da Matriz' });
    playlistId = created.body.playlist.id;
    const pl = (await admin.get(`/api/playlists/${playlistId}`)).body.playlist;
    expect(pl.settings).toMatchObject({ loop: true, audio: false, fitMode: 'contain', imageDurationSec: null });
    const saved = await admin.put(`/api/playlists/${playlistId}`, {
      revision: pl.revision,
      items: [{ mediaId: media.video1 }, { mediaId: media.image, durationSec: 15 }, { mediaId: media.video2 }],
    });
    expect(saved.status).toBe(200);
    revision = saved.body.revision;
    const after = (await admin.get(`/api/playlists/${playlistId}`)).body.playlist;
    expect(after.items.map((i: any) => i.media.id)).toEqual([media.video1, media.image, media.video2]);
    expect(after.items[1].durationSec).toBe(15);
    expect(after.hasUnpublishedChanges).toBe(true);
  });

  it('reordena itens preservando os IDs dos itens', async () => {
    const pl = (await admin.get(`/api/playlists/${playlistId}`)).body.playlist;
    const ids = pl.items.map((i: any) => i.id);
    const reordered = [pl.items[2], pl.items[0], pl.items[1]].map((i: any) => ({ id: i.id, mediaId: i.media.id, durationSec: i.durationSec }));
    const r = await admin.put(`/api/playlists/${playlistId}`, { revision: pl.revision, items: reordered });
    expect(r.status).toBe(200);
    const after = (await admin.get(`/api/playlists/${playlistId}`)).body.playlist;
    expect(after.items.map((i: any) => i.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(after.items.map((i: any) => i.position)).toEqual([0, 1, 2]);
    // volta à ordem original
    const back = await admin.put(`/api/playlists/${playlistId}`, { revision: r.body.revision, items: pl.items.map((i: any) => ({ id: i.id, mediaId: i.media.id, durationSec: i.durationSec })) });
    revision = back.body.revision;
  });

  it('detecta edição concorrente do rascunho (revisão desatualizada)', async () => {
    const stale = await admin.put(`/api/playlists/${playlistId}`, { revision: revision - 1, name: 'outro nome' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('STALE_REVISION');
  });

  it('vincula o telão com código temporário e credencial própria', async () => {
    const paired = await pairDevice(admin, env.baseUrl);
    deviceId = paired.deviceId;
    deviceCookie = paired.cookie;
    expect(deviceCookie).toMatch(/gd_device=/);
    const session = await paired.player.get('/api/player/session');
    expect(session.body).toMatchObject({ paired: true, device: { name: 'Telão da Matriz' } });
    // o dispositivo não acessa rotas administrativas
    expect((await paired.player.get('/api/media')).status).toBe(401);
    expect((await paired.player.get('/api/playlists')).status).toBe(401);
  });

  it('editor sem permissão de publicação não publica', async () => {
    const editor = new Client(env.baseUrl);
    await editor.login(EDITOR.email, EDITOR.password);
    expect((await editor.post(`/api/playlists/${playlistId}/publish`, { deviceIds: [deviceId] })).status).toBe(403);
  });

  it('publica e o player recebe a nova programação em tempo real', async () => {
    const socket = playerSocket(env.baseUrl, deviceCookie);
    try {
      const initial = await waitFor<PlayerManifest>(socket, 'sync');
      expect(initial.version).toBeNull();
      const syncPromise = waitFor<PlayerManifest>(socket, 'sync', 10_000, (m) => !!m.version);
      const pub = await admin.post(`/api/playlists/${playlistId}/publish`, { deviceIds: [deviceId], applyMode: 'next', revision });
      expect(pub.status).toBe(200);
      expect(pub.body.version.number).toBe(1);
      const m = await syncPromise;
      expect(m.version!.number).toBe(1);
      expect(m.version!.items.map((i) => i.mediaId)).toEqual([media.video1, media.image, media.video2]);
      expect(m.version!.items[1]).toMatchObject({ type: 'image', durationMs: 15_000, customDuration: true });
      expect(m.version!.items[0]!.durationMs).toBeGreaterThan(1500);
      expect(m.version!.settings.imageDurationMs).toBe(30_000);
      expect(m.source).toBe('default');
    } finally {
      socket.disconnect();
    }
  });

  it('player baixa somente mídias da própria programação', async () => {
    const res = await fetch(`${env.baseUrl}/api/player/media/${media.video1}`, { headers: { cookie: deviceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-checksum-sha256')).toMatch(/^[0-9a-f]{64}$/);
    const notInPlaylist = await fetch(`${env.baseUrl}/api/player/media/${media.video3}`, { headers: { cookie: deviceCookie } });
    expect(notInPlaylist.status).toBe(403);
    const noCred = await fetch(`${env.baseUrl}/api/player/media/${media.video1}`);
    expect(noCred.status).toBe(401);
  });

  it('rascunho editado não afeta o telão até publicar', async () => {
    const pl = (await admin.get(`/api/playlists/${playlistId}`)).body.playlist;
    const items = pl.items.map((i: any) => ({ id: i.id, mediaId: i.media.id, durationSec: i.durationSec }));
    items.splice(2, 0, { mediaId: media.video3 });
    const saved = await admin.put(`/api/playlists/${playlistId}`, { revision: pl.revision, items });
    revision = saved.body.revision;
    const manifest = await fetch(`${env.baseUrl}/api/player/manifest`, { headers: { cookie: deviceCookie } }).then((r) => r.json());
    expect(manifest.version.number).toBe(1);
    expect(manifest.version.items).toHaveLength(3);
  });

  it('nova publicação durante reprodução gera versão 2 com o novo vídeo na posição definida', async () => {
    const socket = playerSocket(env.baseUrl, deviceCookie);
    try {
      await waitFor(socket, 'sync');
      const next = waitFor<PlayerManifest>(socket, 'sync', 10_000, (m) => m.version?.number === 2);
      await admin.post(`/api/playlists/${playlistId}/publish`, { deviceIds: [deviceId], revision });
      const m = await next;
      expect(m.version!.items.map((i) => i.mediaId)).toEqual([media.video1, media.image, media.video3, media.video2]);
      // IDs de itens existentes são estáveis entre versões (o player usa isso para manter a posição)
      const v1 = await env.db.playlistVersion.findFirstOrThrow({ where: { playlistId, number: 1 } });
      const v1Items = (v1.snapshot as any).items.map((i: any) => i.itemId);
      expect(m.version!.items.filter((i) => v1Items.includes(i.itemId))).toHaveLength(3);
    } finally {
      socket.disconnect();
    }
  });

  it('publicações simultâneas geram números de versão únicos e sequenciais', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => admin.post(`/api/playlists/${playlistId}/publish`, { deviceIds: [deviceId] })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const numbers = results.map((r) => r.body.version.number).sort((a, b) => a - b);
    expect(numbers).toEqual([3, 4, 5, 6, 7]);
    const device = await env.db.displayDevice.findUniqueOrThrow({ where: { id: deviceId } });
    const current = await env.db.playlistVersion.findUniqueOrThrow({ where: { id: device.publishedVersionId! } });
    expect(numbers).toContain(current.number);
  });

  it('protege a exclusão de mídia em uso pela programação publicada', async () => {
    const r = await admin.del(`/api/media/${media.video3}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MEDIA_IN_USE');
    expect(await env.db.media.count({ where: { id: media.video3 } })).toBe(1);
  });

  it('mídia somente em rascunho exige confirmação e é removida das playlists', async () => {
    const extra = await uploadReady(admin, await makePng('extra.png', { r: 0, g: 0, b: 0 }), 'Extra.png');
    const other = (await admin.post('/api/playlists', { name: 'Rascunho' })).body.playlist.id;
    const pl = (await admin.get(`/api/playlists/${other}`)).body.playlist;
    await admin.put(`/api/playlists/${other}`, { revision: pl.revision, items: [{ mediaId: extra }] });
    const r = await admin.del(`/api/media/${extra}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MEDIA_IN_DRAFTS');
    const forced = await admin.del(`/api/media/${extra}?force=true`);
    expect(forced.status).toBe(200);
    expect(await env.db.playlistItem.count({ where: { playlistId: other } })).toBe(0);
  });

  it('publicar playlist vazia ou com mídia em processamento falha sem afetar a versão atual', async () => {
    const empty = (await admin.post('/api/playlists', { name: 'Vazia' })).body.playlist.id;
    const before = await env.db.displayDevice.findUniqueOrThrow({ where: { id: deviceId } });
    const r = await admin.post(`/api/playlists/${empty}/publish`, { deviceIds: [deviceId] });
    expect(r.status).toBe(400);
    const after = await env.db.displayDevice.findUniqueOrThrow({ where: { id: deviceId } });
    expect(after.publishedVersionId).toBe(before.publishedVersionId);
  });

  it('desvincular a playlist envia programação vazia ao telão', async () => {
    const socket = playerSocket(env.baseUrl, deviceCookie);
    try {
      await waitFor(socket, 'sync');
      const empty = waitFor<PlayerManifest>(socket, 'sync', 10_000, (m) => m.version === null);
      expect((await admin.post(`/api/devices/${deviceId}/unassign`)).status).toBe(200);
      const m = await empty;
      expect(m.source).toBe('none');
    } finally {
      socket.disconnect();
    }
  });
});
