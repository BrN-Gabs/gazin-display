import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, connectSocket, isEvent, makePng, makeVideo, pairDevice, sha256, uniq } from '../helpers';

describe('playlists, publicação e sincronização com o telão', () => {
  const admin = new Client();
  let img: any;
  let img2: any;
  let vid: any;

  beforeAll(async () => {
    await admin.login(ADMIN.email, ADMIN.password);
    img = (await admin.upload(await makePng('pub-a.png', { r: 21, g: 83, b: 204 }), { width: 1280, height: 720 })).body.media;
    img2 = (await admin.upload(await makePng('pub-b.png', { r: 240, g: 190, b: 20 }), { width: 1280, height: 720 })).body.media;
    vid = (await admin.upload(makeVideo('pub-video.mp4', 2), { width: 1280, height: 720, durationMs: 2000, videoCodec: 'h264' })).body.media;
    expect(img?.id && img2?.id && vid?.id).toBeTruthy();
  });

  it('cria, reordena e salva com controle de concorrência (revisão)', async () => {
    const pl = (await admin.post('/api/playlists', { name: uniq('Institucional') })).body.playlist;
    const s1 = await admin.put(`/api/playlists/${pl.id}`, { revision: 1, items: [{ mediaId: img.id, durationSec: 5 }, { mediaId: vid.id }] });
    expect(s1.body.revision).toBe(2);
    const p = (await admin.get(`/api/playlists/${pl.id}`)).body.playlist;
    expect(p.items.map((i: any) => i.media.id)).toEqual([img.id, vid.id]);
    // reordena mantendo os IDs dos itens
    const s2 = await admin.put(`/api/playlists/${pl.id}`, { revision: 2, items: [{ id: p.items[1].id, mediaId: vid.id }, { id: p.items[0].id, mediaId: img.id, durationSec: 8 }] });
    expect(s2.status).toBe(200);
    const p2 = (await admin.get(`/api/playlists/${pl.id}`)).body.playlist;
    expect(p2.items.map((i: any) => i.id)).toEqual([p.items[1].id, p.items[0].id]);
    expect(p2.items[1].durationSec).toBe(8);
    // revisão desatualizada: nada é alterado
    const stale = await admin.put(`/api/playlists/${pl.id}`, { revision: 2, items: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('STALE_REVISION');
    expect((await admin.get(`/api/playlists/${pl.id}`)).body.playlist.items).toHaveLength(2);
    // duplicar
    const dup = await admin.post(`/api/playlists/${pl.id}/duplicate`);
    expect((await admin.get(`/api/playlists/${dup.body.playlist.id}`)).body.playlist.items).toHaveLength(2);
  });

  it('publica no telão: o player recebe o manifest pelo WebSocket, baixa as mídias e reporta o estado', async () => {
    const { player, deviceId, cookie } = await pairDevice(admin, uniq('Telão'));
    const ws = await connectSocket('player', cookie);
    // ao conectar, recebe a configuração e a programação atual (vazia)
    await ws.waitFor((m) => m.t === 'config');
    const first = await ws.waitFor(isEvent('sync'));
    expect(first.d.version).toBeNull();

    const pl = (await admin.post('/api/playlists', { name: uniq('Programação') })).body.playlist;
    await admin.put(`/api/playlists/${pl.id}`, { revision: 1, items: [{ mediaId: img.id, durationSec: 3 }, { mediaId: vid.id }] });
    const pub = await admin.post(`/api/playlists/${pl.id}/publish`, { deviceIds: [deviceId], applyMode: 'next' });
    expect(pub.status).toBe(200);
    expect(pub.body.version.number).toBe(1);

    const sync = await ws.waitFor(isEvent('sync', (d) => d.version?.number === 1));
    expect(sync.d.version.items.map((i: any) => i.mediaId)).toEqual([img.id, vid.id]);
    expect(sync.d.version.items[0].durationMs).toBe(3000);
    expect(sync.d.version.items[1].durationMs).toBe(2000);

    // o mesmo manifest por HTTP (reconciliação periódica)
    const manifest = await player.get('/api/player/manifest');
    expect(manifest.body.version.versionId).toBe(sync.d.version.versionId);

    // download das mídias pelo player, com verificação de integridade
    const media = await player.get(`/api/player/media/${vid.id}`);
    expect(media.status).toBe(200);
    expect(sha256(media.body)).toBe(sync.d.version.items[1].checksum);
    expect(media.headers.get('cache-control')).toContain('immutable');
    // mídia fora da programação do telão: proibida
    expect((await player.get(`/api/player/media/${img2.id}`)).status).toBe(403);
    // credencial do player não acessa a API administrativa
    expect((await player.get('/api/media')).status).toBe(401);

    // estado reportado aparece para o painel em tempo real e é persistido
    const adminWs = await connectSocket('admin', admin.cookieHeader);
    ws.send({ t: 'state', d: { status: 'playing', versionId: sync.d.version.versionId, versionNumber: 1, index: 0, total: 2, lastError: null } });
    const live = await adminWs.waitFor(isEvent('device:state', (d) => d.deviceId === deviceId));
    expect(live.d.state.status).toBe('playing');
    const dev = (await admin.get(`/api/devices/${deviceId}`)).body.device;
    expect(dev.connection).toBe('online');
    expect(dev.reportedVersion.number).toBe(1);
    expect(dev.inSync).toBe(true);

    // atualização durante a reprodução: nova versão chega sem recarregar
    const p = (await admin.get(`/api/playlists/${pl.id}`)).body.playlist;
    await admin.put(`/api/playlists/${pl.id}`, { revision: p.revision, items: [...p.items.map((i: any) => ({ id: i.id, mediaId: i.media.id, durationSec: i.durationSec })), { mediaId: img2.id }] });
    await admin.post(`/api/playlists/${pl.id}/publish`, { deviceIds: [deviceId] });
    const sync2 = await ws.waitFor(isEvent('sync', (d) => d.version?.number === 2));
    expect(sync2.d.version.items).toHaveLength(3);
    // agora a nova mídia é acessível ao telão
    expect((await player.get(`/api/player/media/${img2.id}`)).status).toBe(200);

    // mídia em uso na programação publicada não pode ser excluída
    const del = await admin.del(`/api/media/${img2.id}?force=true`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('MEDIA_IN_USE');
    // playlist publicada não pode ser excluída
    expect((await admin.del(`/api/playlists/${pl.id}`)).body.error).toBe('PLAYLIST_IN_USE');

    ws.close();
    adminWs.close();
  });

  it('publicações simultâneas geram números de versão sequenciais e únicos', async () => {
    const pl = (await admin.post('/api/playlists', { name: uniq('Concorrência') })).body.playlist;
    await admin.put(`/api/playlists/${pl.id}`, { revision: 1, items: [{ mediaId: img.id }] });
    const results = await Promise.all(Array.from({ length: 5 }, () => admin.post(`/api/playlists/${pl.id}/publish`, {})));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.map((r) => r.body.version.number).sort()).toEqual([1, 2, 3, 4, 5]);
    // revisão esperada desatualizada
    const stale = await admin.post(`/api/playlists/${pl.id}/publish`, { revision: 99 });
    expect(stale.body.error).toBe('STALE_REVISION');
  });

  it('não publica playlist vazia', async () => {
    const pl = (await admin.post('/api/playlists', { name: uniq('Vazia') })).body.playlist;
    expect((await admin.post(`/api/playlists/${pl.id}/publish`, {})).status).toBe(400);
  });

  it('visão geral e histórico refletem as operações', async () => {
    const d = await admin.get('/api/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.stats.mediaImages).toBeGreaterThan(0);
    expect(d.body.stats.storageBytes).toBeGreaterThan(fs.statSync(makeVideo('pub-video.mp4', 2)).size);
    const audit = await admin.get('/api/audit?action=playlist.');
    expect(audit.body.entries.some((e: any) => e.action === 'playlist.published')).toBe(true);
  });
});
