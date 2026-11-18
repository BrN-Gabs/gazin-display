import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, connectSocket, isEvent, pairDevice, uniq, until } from '../helpers';

describe('telões: vinculação, controle remoto e autorização', () => {
  const admin = new Client();
  beforeAll(async () => {
    await admin.login(ADMIN.email, ADMIN.password);
  });

  it('dispositivo não vinculado recebe 401 e não conecta ao tempo real', async () => {
    const anon = new Client();
    expect((await anon.get('/api/player/session')).status).toBe(401);
    expect((await anon.get('/api/player/manifest')).status).toBe(401);
    await expect(connectSocket('player', 'gd_device=00000000-0000-0000-0000-000000000000.forjado')).rejects.toThrow();
    await expect(connectSocket('admin', '')).rejects.toThrow();
  });

  it('código de vinculação inválido é recusado; código usado não pode ser reutilizado', async () => {
    expect((await admin.post('/api/devices/pair', { code: 'ZZZ-ZZZ', name: 'Telão X' })).status).toBe(404);
    const player = new Client();
    const req = await player.post('/api/player/pairing');
    expect(req.body.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect((await admin.post('/api/devices/pair', { code: req.body.code.replace('-', '').toLowerCase(), name: uniq('Telão') })).status).toBe(200);
    expect((await admin.post('/api/devices/pair', { code: req.body.code, name: 'Outro' })).body.error).toBe('PAIRING_USED');
  });

  it('comandos remotos: confirmados pelo telão, recusados e sem confirmação (timeout)', async () => {
    const { deviceId, cookie } = await pairDevice(admin, uniq('Telão Controle'));
    const ws = await connectSocket('player', cookie);
    await ws.waitFor(isEvent('sync'));

    ws.onCommand = (cmd) => ({ ok: true, state: { status: cmd.type === 'pause' ? 'paused' : 'playing' } });
    const ok = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'pause' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('acked');
    expect(ok.body.state.status).toBe('paused');

    ws.onCommand = () => ({ ok: false, error: 'Item inexistente na programação atual.' });
    const rejected = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'goto', payload: { index: 99 } });
    expect(rejected.status).toBe(422);
    expect(rejected.body.message).toMatch(/Item inexistente/);

    ws.onCommand = () => null; // não responde
    const timeout = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'next' });
    expect(timeout.status).toBe(504);
    expect(timeout.body.error).toBe('DEVICE_TIMEOUT');

    const history = (await admin.get(`/api/devices/${deviceId}/commands`)).body.commands;
    expect(history.map((c: any) => c.status).slice(0, 3)).toEqual(['TIMEOUT', 'FAILED', 'ACKED']);

    // validação do comando
    expect((await admin.post(`/api/devices/${deviceId}/commands`, { type: 'set_fit' })).status).toBe(400);
    ws.close();
  });

  it('telão offline: comando não é enviado (409) e ajustes persistentes ficam salvos (202)', async () => {
    const { deviceId, cookie, player } = await pairDevice(admin, uniq('Telão Offline'));
    const ws = await connectSocket('player', cookie);
    await ws.waitFor(isEvent('sync'));
    ws.close();
    await ws.closed;
    await until(async () => (await admin.get(`/api/devices/${deviceId}`)).body.device.connection !== 'online', 15_000);
    const r = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'pause' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('DEVICE_OFFLINE');
    const fit = await admin.post(`/api/devices/${deviceId}/commands`, { type: 'set_fit', payload: { fitMode: 'cover' } });
    expect(fit.status).toBe(202);
    // ao reconectar, o manifest já traz o ajuste salvo
    expect((await player.get('/api/player/manifest')).body.overrides.fitMode).toBe('cover');
  });

  it('revogação: o telão é desconectado e perde o acesso imediatamente', async () => {
    const { deviceId, cookie, player } = await pairDevice(admin, uniq('Telão Revogado'));
    const ws = await connectSocket('player', cookie);
    await ws.waitFor(isEvent('sync'));
    expect((await admin.post(`/api/devices/${deviceId}/revoke`)).body.revoked).toBe(1);
    await ws.waitFor(isEvent('revoked'));
    await ws.closed;
    expect((await player.get('/api/player/manifest')).status).toBe(401);
    expect((await player.get('/api/player/session')).status).toBe(401);
    await expect(connectSocket('player', cookie)).rejects.toThrow();
    // credencial forjada com ID real
    const credId = cookie.split('=')[1]!.split('.')[0];
    expect((await new Client().req('GET', '/api/player/manifest', undefined, { cookie: `gd_device=${credId}.segredo-falso` })).status).toBe(401);
  });

  it('troca do computador do telão: o anterior perde o acesso', async () => {
    const first = await pairDevice(admin, uniq('Telão Troca'));
    const player2 = new Client();
    const req = await player2.post('/api/player/pairing');
    expect((await admin.post('/api/devices/pair', { code: req.body.code, deviceId: first.deviceId })).status).toBe(200);
    await player2.post(`/api/player/pairing/${req.body.id}/poll`, { pollSecret: req.body.pollSecret });
    expect((await player2.get('/api/player/session')).body.device.id).toBe(first.deviceId);
    expect((await first.player.get('/api/player/session')).status).toBe(401);
  });

  it('desvincular a playlist deixa o telão sem programação', async () => {
    const { deviceId, player } = await pairDevice(admin, uniq('Telão Desvincular'));
    expect((await admin.post(`/api/devices/${deviceId}/unassign`)).status).toBe(200);
    expect((await player.get('/api/player/manifest')).body.source).toBe('none');
  });
});
