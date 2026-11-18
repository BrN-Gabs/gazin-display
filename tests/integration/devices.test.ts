import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceCommandMessage, PlayerManifest } from '../../src/shared/types.js';
import { adminSocket, ADMIN, Client, makePng, pairDevice, playerSocket, seedUsers, startTestApp, until, waitFor, type TestEnv } from '../helpers.js';

let env: TestEnv;
let admin: Client;

beforeAll(async () => {
  env = await startTestApp();
  await seedUsers(env.db);
  admin = new Client(env.baseUrl);
  await admin.login(ADMIN.email, ADMIN.password);
});
afterAll(() => env.close());

const fakeState = (over: Record<string, unknown> = {}) => ({
  status: 'playing',
  versionId: null,
  versionNumber: null,
  playlistName: null,
  index: 0,
  total: 0,
  itemId: null,
  mediaId: null,
  mediaName: null,
  mediaType: null,
  elapsedMs: 0,
  durationMs: 0,
  pendingVersionId: null,
  preparing: null,
  prepareError: null,
  cache: { usageBytes: 0, quotaBytes: 0, persisted: true, cachedItems: 0 },
  fitMode: 'contain',
  audio: false,
  audioBlocked: false,
  lastError: null,
  screen: { width: 1920, height: 1080, dpr: 1 },
  appVersion: 'test',
  uptimeSec: 1,
  ...over,
});

describe('telões: vinculação, status e controle remoto', () => {
  it('dispositivo não autorizado não acessa a programação nem o socket', async () => {
    const anon = new Client(env.baseUrl);
    expect((await anon.get('/api/player/manifest')).status).toBe(401);
    expect((await anon.get('/api/player/session')).status).toBe(401);
    const forged = new Client(env.baseUrl);
    forged.cookies.set('gd_device', '00000000-0000-0000-0000-000000000000.inventado');
    expect((await forged.get('/api/player/manifest')).status).toBe(401);
    const s = playerSocket(env.baseUrl, 'gd_device=abc.def');
    const err = await new Promise<Error>((resolve) => s.on('connect_error', resolve));
    expect(err.message).toMatch(/não autorizado/);
    s.disconnect();
  });

  it('código de vinculação inválido ou reutilizado é recusado', async () => {
    expect((await admin.post('/api/devices/pair', { code: 'ZZZ-ZZZ', name: 'Telão X' })).status).toBe(404);
    const player = new Client(env.baseUrl);
    const req = await player.post('/api/player/pairing');
    expect(req.body.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect((await player.post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: req.body.pollSecret })).body.status).toBe('pending');
    // segredo de consulta incorreto
    expect((await player.post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: 'x'.repeat(20) })).status).toBe(404);
    // código aceito sem hífen/minúsculas
    const ok = await admin.post('/api/devices/pair', { code: req.body.code.replace('-', '').toLowerCase(), name: 'Telão Recepção' });
    expect(ok.status).toBe(200);
    expect((await admin.post('/api/devices/pair', { code: req.body.code, name: 'Outro' })).status).toBe(409);
    const poll = await player.post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: req.body.pollSecret });
    expect(poll.body.status).toBe('approved');
    // a credencial é emitida uma única vez
    const again = await new Client(env.baseUrl).post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: req.body.pollSecret });
    expect(again.body.status).toBe('consumed');
  });

  it('status online/offline, estado em tempo real e reconexão com reconciliação', async () => {
    const { deviceId, cookie } = await pairDevice(admin, env.baseUrl, 'Telão Auditório');
    const adminWs = adminSocket(env.baseUrl, admin.cookieHeader);
    await new Promise((r) => adminWs.on('connect', r));
    let s = playerSocket(env.baseUrl, cookie);
    await waitFor(s, 'sync');
    expect((await admin.get(`/api/devices/${deviceId}`)).body.device.connection).toBe('online');
    const stateEvt = waitFor<any>(adminWs, 'device:state', 5000, (e) => e.deviceId === deviceId);
    s.emit('state', fakeState({ index: 1, total: 3, mediaName: 'Vídeo A' }));
    expect((await stateEvt).state.mediaName).toBe('Vídeo A');
    // queda de conexão
    s.disconnect();
    await until(async () => (await admin.get(`/api/devices/${deviceId}`)).body.device.connection === 'reconnecting');
    // enquanto offline, publica-se uma nova programação (evento perdido)
    const img = await admin.upload(await makePng('dev.png'), 'dev.png');
    await env.built.ctx.processor.whenIdle();
    const pl = (await admin.post('/api/playlists', { name: 'Auditório' })).body.playlist.id;
    const p = (await admin.get(`/api/playlists/${pl}`)).body.playlist;
    await admin.put(`/api/playlists/${pl}`, { revision: p.revision, items: [{ mediaId: img.body.media.id }] });
    await admin.post(`/api/playlists/${pl}/publish`, { deviceIds: [deviceId] });
    // ao reconectar, o servidor envia o manifest atual (reconciliação)
    s = playerSocket(env.baseUrl, cookie);
    const m = await waitFor<PlayerManifest>(s, 'sync');
    expect(m.version?.playlistName).toBe('Auditório');
    // e a rotina periódica (HTTP) retorna o mesmo estado
    const viaHttp = await fetch(`${env.baseUrl}/api/player/manifest`, { headers: { cookie } }).then((r) => r.json());
    expect(viaHttp.version.versionId).toBe(m.version!.versionId);
    s.disconnect();
    adminWs.disconnect();
  });

  it('comandos remotos são entregues ao dispositivo e só confirmam após resposta real', async () => {
    const { deviceId, cookie } = await pairDevice(admin, env.baseUrl, 'Telão Refeitório');
    // offline: não há confirmação falsa
    const offline = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'pause' });
    expect(offline.status).toBe(409);
    expect(offline.body.error).toBe('DEVICE_OFFLINE');
    const offlineSetting = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'set_fit', payload: { fitMode: 'cover' } });
    expect(offlineSetting.status).toBe(202);
    expect(offlineSetting.body.status).toBe('saved');

    const s = playerSocket(env.baseUrl, cookie);
    const first = await waitFor<PlayerManifest>(s, 'sync');
    expect(first.overrides.fitMode).toBe('cover');
    const received: DeviceCommandMessage[] = [];
    s.on('command', (cmd: DeviceCommandMessage, ack: (r: unknown) => void) => {
      received.push(cmd);
      if (cmd.type === 'goto' && cmd.payload?.index === 99) return ack({ ok: false, error: 'Item inexistente' });
      ack({ ok: true, state: fakeState({ status: cmd.type === 'pause' ? 'paused' : 'playing' }) });
    });
    const pause = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'pause' });
    expect(pause.status).toBe(200);
    expect(pause.body.status).toBe('acked');
    expect(pause.body.state.status).toBe('paused');
    for (const type of ['resume', 'next', 'previous', 'restart', 'reload', 'sync'] as const) {
      expect((await admin.post(`/api/devices/${deviceId}/commands`, { type })).status, type).toBe(200);
    }
    expect((await admin.post(`/api/devices/${deviceId}/commands`, { type: 'goto', payload: { index: 1 } })).status).toBe(200);
    expect((await admin.post(`/api/devices/${deviceId}/commands`, { type: 'set_audio', payload: { enabled: true } })).status).toBe(200);
    const rejected = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'goto', payload: { index: 99 } });
    expect(rejected.status).toBe(422);
    expect(received.map((c) => c.type)).toEqual(['pause', 'resume', 'next', 'previous', 'restart', 'reload', 'sync', 'goto', 'set_audio', 'goto']);
    const statuses = await env.db.deviceCommand.findMany({ where: { deviceId }, orderBy: { createdAt: 'asc' }, select: { status: true } });
    expect(statuses.filter((c) => c.status === 'ACKED')).toHaveLength(9);

    // dispositivo conectado que não responde: timeout, não sucesso
    s.off('command');
    s.on('command', () => {});
    const silent = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'next' });
    expect(silent.status).toBe(504);
    s.disconnect();
  }, 60_000);

  it('revogação desconecta o player e invalida a credencial; renovação exige credencial ativa', async () => {
    const { deviceId, cookie } = await pairDevice(admin, env.baseUrl, 'Telão Temporário');
    expect((await admin.post(`/api/devices/${deviceId}/renew`)).status).toBe(200);
    const s = playerSocket(env.baseUrl, cookie);
    await waitFor(s, 'sync');
    const revoked = waitFor(s, 'revoked');
    expect((await admin.post(`/api/devices/${deviceId}/revoke`)).status).toBe(200);
    await revoked;
    expect((await fetch(`${env.baseUrl}/api/player/manifest`, { headers: { cookie } })).status).toBe(401);
    expect((await admin.post(`/api/devices/${deviceId}/renew`)).status).toBe(409);
    s.disconnect();
  });
});
