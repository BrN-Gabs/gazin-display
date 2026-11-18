import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Client, makePng, pairDevice, seedUsers, startTestApp, until, type TestEnv } from '../helpers.js';
import { localParts } from '../../src/shared/schedule-logic.js';

let env: TestEnv;
let admin: Client;
let deviceId: string;
let deviceCookie: string;
let defaultPl: string;
let campaignPl: string;

async function playlistWithImage(name: string, color: { r: number; g: number; b: number }) {
  const up = await admin.upload(await makePng(`${name}.png`, color), `${name}.png`);
  await env.built.ctx.processor.whenIdle();
  await until(async () => (await env.db.media.findUniqueOrThrow({ where: { id: up.body.media.id } })).status === 'READY');
  const id = (await admin.post('/api/playlists', { name })).body.playlist.id;
  const p = (await admin.get(`/api/playlists/${id}`)).body.playlist;
  await admin.put(`/api/playlists/${id}`, { revision: p.revision, items: [{ mediaId: up.body.media.id }] });
  return id as string;
}

const manifest = () => fetch(`${env.baseUrl}/api/player/manifest`, { headers: { cookie: deviceCookie } }).then((r) => r.json());

beforeAll(async () => {
  env = await startTestApp();
  await seedUsers(env.db);
  admin = new Client(env.baseUrl);
  await admin.login(ADMIN.email, ADMIN.password);
  ({ deviceId, cookie: deviceCookie } = await pairDevice(admin, env.baseUrl));
  defaultPl = await playlistWithImage('Institucional', { r: 0, g: 60, b: 140 });
  campaignPl = await playlistWithImage('Campanha', { r: 240, g: 180, b: 0 });
  await admin.post(`/api/playlists/${defaultPl}/publish`, { deviceIds: [deviceId] });
});
afterAll(() => env.close());

describe('programação (agendamentos)', () => {
  it('exige playlist publicada para agendar', async () => {
    const r = await admin.post('/api/schedules', { name: 'X', deviceId, playlistId: campaignPl, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '00:00' });
    expect(r.status).toBe(400);
  });

  it('agendamento ativo substitui a playlist padrão e volta ao padrão ao ser cancelado', async () => {
    await admin.post(`/api/playlists/${campaignPl}/publish`, { deviceIds: [] });
    expect((await manifest()).version.playlistName).toBe('Institucional');
    const now = localParts(new Date());
    const r = await admin.post('/api/schedules', { name: 'Campanha agora', deviceId, playlistId: campaignPl, daysOfWeek: [now.dow], startTime: '00:00', endTime: '00:00', priority: 20 });
    expect(r.status).toBe(200);
    const m = await manifest();
    expect(m.source).toBe('schedule');
    expect(m.scheduleName).toBe('Campanha agora');
    expect(m.version.playlistName).toBe('Campanha');
    const list = (await admin.get('/api/schedules')).body;
    expect(list.schedules[0].activeNow).toBe(true);
    expect(list.timezone).toBe('America/Sao_Paulo');
    await admin.del(`/api/schedules/${r.body.schedule.id}`);
    const back = await manifest();
    expect(back.source).toBe('default');
    expect(back.version.playlistName).toBe('Institucional');
  });

  it('agendamento fora do horário não altera a programação', async () => {
    const now = localParts(new Date());
    const otherDay = (now.dow + 3) % 7;
    const r = await admin.post('/api/schedules', { name: 'Outro dia', deviceId, playlistId: campaignPl, daysOfWeek: [otherDay], startTime: '08:00', endTime: '18:00' });
    expect(r.status).toBe(200);
    expect((await manifest()).source).toBe('default');
  });

  it('bloqueia conflito de horário na mesma prioridade e permite com prioridade diferente', async () => {
    const base = { deviceId, playlistId: campaignPl, daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00', startDate: '2030-01-01', endDate: '2030-12-31' };
    expect((await admin.post('/api/schedules', { ...base, name: 'Expediente', priority: 10 })).status).toBe(200);
    const clash = await admin.post('/api/schedules', { ...base, name: 'Choque', startTime: '17:00', endTime: '19:00', daysOfWeek: [3], priority: 10 });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('SCHEDULE_CONFLICT');
    const prio = await admin.post('/api/schedules', { ...base, name: 'Evento', startTime: '17:00', endTime: '19:00', daysOfWeek: [3], priority: 50 });
    expect(prio.status).toBe(200);
    expect(prio.body.overlaps).toHaveLength(1);
    const list = (await admin.get('/api/schedules')).body;
    expect(list.conflicts.some((c: any) => !c.samePriority)).toBe(true);
  });

  it('valida dados do agendamento', async () => {
    const bad = await admin.post('/api/schedules', { name: 'Inválido', deviceId, playlistId: campaignPl, daysOfWeek: [], startTime: '25:00', endTime: '10:00' });
    expect(bad.status).toBe(400);
    const badDates = await admin.post('/api/schedules', { name: 'Datas', deviceId, playlistId: campaignPl, daysOfWeek: [1], startTime: '08:00', endTime: '10:00', startDate: '2030-05-01', endDate: '2030-04-01' });
    expect(badDates.status).toBe(400);
  });

  it('o servidor aplica a troca sozinho (rotina periódica), sem o painel aberto', async () => {
    const now = new Date();
    const local = localParts(now);
    // janela que começa no próximo minuto
    const startMin = (local.minutes + 1) % 1440;
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const r = await admin.post('/api/schedules', { name: 'Próximo minuto', deviceId, playlistId: campaignPl, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: hh(startMin), endTime: hh((startMin + 30) % 1440), priority: 90 });
    expect(r.status).toBe(200);
    // simula a passagem do tempo chamando a mesma rotina que roda a cada 15s
    const future = new Date(now.getTime() + 2 * 60_000);
    await env.built.ctx.devices.recomputeAll(future);
    const device = await env.db.displayDevice.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.effectiveSource).toBe(`schedule:${r.body.schedule.id}`);
    expect(await env.db.auditLog.count({ where: { action: 'schedule.switched' } })).toBeGreaterThan(0);
  });
});
