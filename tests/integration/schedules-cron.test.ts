import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, connectSocket, isEvent, makePng, pairDevice, uniq } from '../helpers';
import { localParts } from '../../src/shared/schedule-logic';

/** Executa SQL direto no D1 local do Worker de teste (simula o passar do tempo) */
function sql(command: string) {
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', path.resolve('.data/test-worker'), '--command', JSON.stringify(command), '--json'], {
    encoding: 'utf8',
    shell: isWin,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout)[0].results as any[];
}

const past = () => new Date(Date.now() - 3600_000).toISOString();
const DAYS = [0, 1, 2, 3, 4, 5, 6];

describe('agendamentos, cron e expirações', () => {
  const admin = new Client();
  let media: any;
  beforeAll(async () => {
    await admin.login(ADMIN.email, ADMIN.password);
    media = (await admin.upload(await makePng('agenda.png', { r: 90, g: 30, b: 160 }), { width: 1280, height: 720 })).body.media;
  });

  async function publishedPlaylist(name: string) {
    const pl = (await admin.post('/api/playlists', { name: uniq(name) })).body.playlist;
    await admin.put(`/api/playlists/${pl.id}`, { revision: 1, items: [{ mediaId: media.id }] });
    await admin.post(`/api/playlists/${pl.id}/publish`, {});
    return pl.id as string;
  }

  it('agendamento ativo assume o telão; conflitos de mesma prioridade são bloqueados', async () => {
    const { deviceId, player } = await pairDevice(admin, uniq('Telão Agenda'));
    const unpublished = (await admin.post('/api/playlists', { name: uniq('Nunca publicada') })).body.playlist.id;
    const body = (playlistId: string, extra = {}) => ({ name: uniq('Agenda'), deviceId, playlistId, daysOfWeek: DAYS, startTime: '00:00', endTime: '00:00', priority: 10, ...extra });
    expect((await admin.post('/api/schedules', body(unpublished))).status).toBe(400);

    const pid = await publishedPlaylist('Agendada');
    const s = await admin.post('/api/schedules', body(pid));
    expect(s.status).toBe(200);
    const m = (await player.get('/api/player/manifest')).body;
    expect(m.source).toBe('schedule');
    expect(m.version.playlistId).toBe(pid);

    const clash = await admin.post('/api/schedules', body(pid));
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('SCHEDULE_CONFLICT');
    const list = (await admin.get('/api/schedules')).body;
    expect(list.schedules.find((x: any) => x.id === s.body.schedule.id).activeNow).toBe(true);

    expect((await admin.del(`/api/schedules/${s.body.schedule.id}`)).status).toBe(200);
    expect((await player.get('/api/player/manifest')).body.source).toBe('none');
  });

  it('o Cron Trigger aplica agendamentos sozinho e avisa o telão pelo WebSocket', async () => {
    const { deviceId, cookie } = await pairDevice(admin, uniq('Telão Cron'));
    const pid = await publishedPlaylist('Cron');
    // janela que NÃO está ativa agora
    const now = localParts(new Date());
    const h = (Math.floor(now.minutes / 60) + 12) % 24;
    const hh = String(h).padStart(2, '0');
    const s = await admin.post('/api/schedules', { name: uniq('Noturno'), deviceId, playlistId: pid, daysOfWeek: DAYS, startTime: `${hh}:00`, endTime: `${hh}:30`, priority: 20 });
    expect(s.status).toBe(200);
    const ws = await connectSocket('player', cookie);
    await ws.waitFor(isEvent('sync', (d) => d.source === 'none'));
    // o "relógio avança": a janela passa a cobrir o dia inteiro, sem passar pela API
    sql(`UPDATE "Schedule" SET "startTime" = '00:00', "endTime" = '00:00' WHERE "id" = '${s.body.schedule.id}'`);
    const r = await fetch(`${admin.baseUrl}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
    expect(r.status).toBe(200);
    const sync = await ws.waitFor(isEvent('sync', (d) => d.source === 'schedule'));
    expect(sync.d.version.playlistId).toBe(pid);
    const audit = (await admin.get(`/api/audit?deviceId=${deviceId}`)).body.entries;
    expect(audit.some((e: any) => e.action === 'schedule.switched')).toBe(true);
    ws.close();
  });

  it('sessão expirada e credencial de telão expirada são recusadas', async () => {
    const c = new Client();
    await c.login(ADMIN.email, ADMIN.password);
    sql(`UPDATE "Session" SET "expiresAt" = '${past()}' WHERE "id" = (SELECT "id" FROM "Session" ORDER BY "createdAt" DESC LIMIT 1)`);
    expect((await c.get('/api/auth/me')).status).toBe(401);

    const { player, deviceId } = await pairDevice(admin, uniq('Telão Expirado'));
    sql(`UPDATE "DeviceCredential" SET "expiresAt" = '${past()}' WHERE "deviceId" = '${deviceId}'`);
    expect((await player.get('/api/player/manifest')).status).toBe(401);
    // renovar exige credencial ativa
    expect((await admin.post(`/api/devices/${deviceId}/renew`)).body.error).toBe('NO_CREDENTIAL');
  });

  it('upload abandonado expira: a limpeza horária aborta o multipart e libera o espaço reservado', async () => {
    const data = Buffer.alloc(6 * 1024 * 1024, 3);
    const init = await admin.initUpload(data, 'abandonado.mp4');
    const id = init.body.uploadId;
    const u = await admin.post(`/api/uploads/${id}/parts/1/url`);
    expect((await admin.req('PUT', u.body.url, new Uint8Array(data.subarray(0, 5 * 1024 * 1024)))).status).toBe(200);
    expect((await admin.get(`/api/uploads/${id}`)).body.receivedBytes).toBe(5 * 1024 * 1024);
    sql(`UPDATE "UploadSession" SET "expiresAt" = '${past()}' WHERE "id" = '${id}'`);
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    await fetch(`${admin.baseUrl}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${hour.getTime()}`);
    const after = await admin.get(`/api/uploads/${id}`);
    expect(after.body.status).toBe('cancelled');
    expect(sql(`SELECT COUNT(*) AS n FROM "UploadPart" WHERE "uploadId" = '${id}'`)[0].n).toBe(0);
    expect((await admin.post(`/api/uploads/${id}/complete`, {})).body.error).toBe('UPLOAD_CLOSED');
  });
});
