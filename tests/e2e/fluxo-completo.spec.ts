/**
 * Fluxo real ponta a ponta (cenário da seção 20 do escopo):
 * login → upload → playlist → vincular telão → publicar → reprodução em loop →
 * atualização durante a reprodução → controle remoto → queda de rede e recarga offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const require = createRequire(import.meta.url);
import { ADMIN } from '../worker-server';
const dir = path.resolve('.data/fixtures/e2e');

async function fixtures() {
  fs.mkdirSync(dir, { recursive: true });
  const img = async (name: string, rgb: [number, number, number]) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toFile(f);
    return f;
  };
  const video = path.join(dir, 'Video Institucional.mp4');
  if (!fs.existsSync(video)) {
    const ffmpeg = require('ffmpeg-static') as string;
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  }
  return {
    a: await img('Imagem Campanha.png', [21, 83, 204]),
    b: await img('Imagem Promocional.png', [240, 190, 20]),
    c: await img('Imagem Nova.png', [20, 160, 90]),
    video,
  };
}

type EngineSnap = { index: number; name: string | null; status: string; paused: boolean; version: number | null; total: number; online: boolean; elapsed: number };
const snap = (p: Page) =>
  p.evaluate((): EngineSnap => {
    const c = (window as any).__gdPlayer;
    const e = c.engine;
    return { index: e.index, name: e.current?.name ?? null, status: e.status, paused: e.paused, version: e.version?.number ?? null, total: e.version?.items.length ?? 0, online: c.online, elapsed: e.elapsedMs() };
  });

/** Registra a sequência de mídias exibidas pelo player durante `ms` */
async function recordSequence(p: Page, ms: number) {
  const seq: Array<{ name: string | null; at: number; status: string }> = [];
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = await snap(p);
    if (!seq.length || seq.at(-1)!.name !== s.name) seq.push({ name: s.name, at: Date.now() - start, status: s.status });
    await p.waitForTimeout(150);
  }
  return seq;
}

test.describe.configure({ mode: 'serial' });

let files: Awaited<ReturnType<typeof fixtures>>;
let admin: Page;
let playerCtx: BrowserContext;
let player: Page;
let playlistUrl = '';
let deviceUrl = '';

test.beforeAll(async ({ browser }) => {
  files = await fixtures();
  admin = await (await browser.newContext()).newPage();
});

test('login: rejeita credenciais inválidas e entra com as válidas', async () => {
  await admin.goto('/admin');
  await expect(admin).toHaveURL(/\/admin\/login/);
  await expect(admin.getByRole('heading', { name: 'GAZIN DISPLAY' })).toBeVisible();
  await expect(admin.getByText('Central de Gerenciamento de Mídias').first()).toBeVisible();
  await admin.getByLabel('E-mail ou usuário').fill(ADMIN.email);
  await admin.getByLabel('Senha', { exact: true }).fill('senha-errada');
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await expect(admin.getByRole('alert')).toContainText('incorretos');
  await admin.getByLabel('Senha', { exact: true }).fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Entrar' }).click();
  await expect(admin.getByRole('heading', { name: 'Visão Geral' })).toBeVisible();
  await expect(admin.getByText('Conectado', { exact: true })).toBeVisible();
});

test('formulário em modal: digitar em um campo de baixo não devolve o foco ao primeiro', async () => {
  await admin.goto(new URL('/admin/settings?tab=users', admin.url()).toString());
  await admin.getByRole('button', { name: 'Novo usuário' }).click();
  const dialog = admin.getByRole('dialog');
  await expect(dialog.getByLabel('Nome')).toBeFocused();
  await dialog.getByLabel('E-mail').click();
  await dialog.getByLabel('E-mail').pressSequentially('teste@gazin.com.br', { delay: 20 });
  await expect(dialog.getByLabel('E-mail')).toHaveValue('teste@gazin.com.br');
  await expect(dialog.getByLabel('E-mail')).toBeFocused();
  await expect(dialog.getByLabel('Nome')).toHaveValue('');
  await admin.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('biblioteca: envia imagens e vídeo e processa', async () => {
  await admin.getByRole('link', { name: 'Biblioteca de Mídias' }).click();
  await admin.locator('input[type=file][accept^="image"]').setInputFiles([files.a, files.b, files.c]);
  await admin.locator('input[type=file][accept^="video"]').setInputFiles([files.video]);
  await expect
    .poll(async () => {
      const r = await admin.request.get('/api/media');
      const { media } = await r.json();
      return media.filter((m: any) => m.status === 'ready').length;
    }, { timeout: 60_000 })
    .toBe(4);
  await expect(admin.getByText('Envios concluídos')).toBeVisible({ timeout: 30_000 });
  await expect(admin.getByRole('button', { name: /Video Institucional/ })).toBeVisible();
});

test('playlist: adiciona mídias, define duração, reordena por arrastar e salva', async () => {
  await admin.getByRole('link', { name: 'Playlists' }).click();
  await admin.getByRole('button', { name: 'Nova playlist' }).click();
  await admin.getByLabel('Nome').fill('Telão da Matriz');
  await admin.getByRole('button', { name: 'Criar e editar' }).click();
  await expect(admin).toHaveURL(/\/admin\/playlists\/[0-9a-f-]{36}/);
  playlistUrl = new URL(admin.url()).pathname;

  await admin.getByRole('button', { name: 'Adicionar mídias' }).first().click();
  const dialog = admin.getByRole('dialog');
  for (const name of ['Imagem Promocional', 'Video Institucional', 'Imagem Campanha']) await dialog.getByRole('button', { name: new RegExp(name) }).click();
  await dialog.getByRole('button', { name: 'Adicionar 3 mídias' }).click();

  for (const input of await admin.getByLabel('Duração em segundos').all()) await input.fill('3');

  // arrasta "Imagem Campanha" (3º) para o topo
  const handle = admin.getByLabel('Mover Imagem Campanha', { exact: true });
  const target = admin.getByLabel('Mover Imagem Promocional', { exact: true });
  const hb = (await handle.boundingBox())!;
  const tb = (await target.boundingBox())!;
  await admin.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await admin.mouse.down();
  await admin.mouse.move(hb.x + hb.width / 2, hb.y - 10, { steps: 5 });
  await admin.mouse.move(tb.x + tb.width / 2, tb.y + 2, { steps: 15 });
  await admin.mouse.up();
  await admin.waitForTimeout(300);

  await admin.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(admin.getByText('Rascunho salvo').first()).toBeVisible();
  const id = playlistUrl.split('/').pop();
  const { playlist } = await (await admin.request.get(`/api/playlists/${id}`)).json();
  expect(playlist.items.map((i: any) => i.media.name)).toEqual(['Imagem Campanha', 'Imagem Promocional', 'Video Institucional']);
  expect(playlist.items.map((i: any) => i.durationSec)).toEqual([3, 3, null]);
});

test('telão: vincula com código temporário e recebe a publicação', async ({ browser }) => {
  playerCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  player = await playerCtx.newPage();
  await player.goto('/player');
  const codeEl = player.locator('.code');
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);

  await admin.goto('/admin/devices');
  await admin.getByRole('button', { name: 'Vincular telão' }).first().click();
  await admin.getByPlaceholder('ABC-123').fill(code);
  await admin.getByRole('button', { name: 'Autorizar dispositivo' }).click();
  await expect(admin.getByText(/vinculado/).first()).toBeVisible();
  await expect(player.getByText('Nenhuma programação publicada para este telão.')).toBeVisible({ timeout: 20_000 });

  await admin.goto(playlistUrl);
  await admin.getByRole('button', { name: 'Publicar no telão' }).click();
  await admin.getByRole('button', { name: /Publicar em 1 telão/ }).click();
  await expect(admin.getByText('Atualizado e reproduzindo a nova versão.')).toBeVisible({ timeout: 40_000 });
  await admin.getByRole('button', { name: 'Concluir' }).click();
  await expect.poll(async () => (await snap(player)).version).toBe(1);
  // nada administrativo na tela do player
  await expect(player.locator('.overlay')).toBeHidden();
  await expect(player.locator('button')).toHaveCount(0);
});

test('player: imagem pelo tempo configurado, vídeo até o fim e retorno ao primeiro item', async () => {
  const seq = await recordSequence(player, 22_000);
  const names = seq.map((s) => s.name);
  // encontra um ciclo completo
  const i0 = names.indexOf('Imagem Campanha');
  expect(names.slice(i0, i0 + 4)).toEqual(['Imagem Campanha', 'Imagem Promocional', 'Video Institucional', 'Imagem Campanha']);
  const t = seq.slice(i0, i0 + 4).map((s) => s.at);
  const imageMs = t[2]! - t[1]!;
  const videoMs = t[3]! - t[2]!;
  expect(imageMs).toBeGreaterThan(2500);
  expect(imageMs).toBeLessThan(4500);
  expect(videoMs).toBeGreaterThan(2700); // vídeo de 3 s tocado até o fim
  expect(videoMs).toBeLessThan(5500);
  expect(seq.every((s) => s.status === 'playing' || s.status === 'starting')).toBe(true);
});

test('atualização durante a reprodução entra no próximo intervalo, sem interromper', async () => {
  const id = playlistUrl.split('/').pop();
  const csrf = { 'x-gd-csrf': '1' };
  const { playlist } = await (await admin.request.get(`/api/playlists/${id}`)).json();
  const { media } = await (await admin.request.get('/api/media?search=Nova')).json();
  const items = playlist.items.map((i: any) => ({ id: i.id, mediaId: i.media.id, durationSec: i.durationSec }));
  items.splice(1, 0, { mediaId: media[0].id, durationSec: 3 });
  const saved = await admin.request.put(`/api/playlists/${id}`, { headers: csrf, data: { revision: playlist.revision, items } });
  expect(saved.ok()).toBe(true);
  // rascunho salvo não altera o telão
  await player.waitForTimeout(1500);
  expect((await snap(player)).version).toBe(1);
  const before = await snap(player);
  const devices = await (await admin.request.get('/api/devices')).json();
  const deviceId = devices.devices[0].id;
  deviceUrl = `/admin/devices/${deviceId}`;
  const pub = await admin.request.post(`/api/playlists/${id}/publish`, { headers: csrf, data: { deviceIds: [deviceId], applyMode: 'next', revision: (await saved.json()).revision } });
  expect(pub.ok()).toBe(true);
  // durante a preparação, a mídia atual segue no ar
  const s1 = await snap(player);
  expect(s1.status).toBe('playing');
  await expect.poll(async () => (await snap(player)).version, { timeout: 30_000 }).toBe(2);
  const after = await snap(player);
  expect(after.total).toBe(4);
  expect(after.status).toBe('playing');
  expect(before.version).toBe(1);
  const seq = await recordSequence(player, 16_000);
  expect(seq.map((s) => s.name)).toContain('Imagem Nova');
});

test('controle remoto: pausar, continuar, avançar e ir para item com confirmação do telão', async () => {
  await admin.goto(deviceUrl);
  await expect(admin.getByText('Online', { exact: true }).first()).toBeVisible();
  await admin.getByRole('button', { name: 'Pausar' }).click();
  await expect(admin.getByText('Pausar: confirmado pelo telão')).toBeVisible();
  expect((await snap(player)).paused).toBe(true);
  const pausedAt = (await snap(player)).elapsed;
  await player.waitForTimeout(1500);
  expect(Math.abs((await snap(player)).elapsed - pausedAt)).toBeLessThan(300);
  await admin.getByRole('button', { name: 'Continuar' }).click();
  await expect(admin.getByText('Continuar: confirmado pelo telão')).toBeVisible();
  expect((await snap(player)).paused).toBe(false);
  const idx = (await snap(player)).index;
  await admin.getByRole('button', { name: 'Próxima' }).click();
  await expect(admin.getByText('Próxima: confirmado pelo telão')).toBeVisible();
  expect((await snap(player)).index).toBe((idx + 1) % 4);
  await admin.getByRole('button', { name: 'Exibir agora' }).nth(0).click();
  await expect(admin.getByText('Ir para item: confirmado pelo telão')).toBeVisible();
});

test('sem rede: continua o loop e recupera após recarregar a página offline', async () => {
  // aguarda o cache local completo da versão atual
  await expect.poll(async () => player.evaluate(async () => (await (await caches.open('gd-media-v1')).keys()).length), { timeout: 30_000 }).toBe(4);
  await playerCtx.setOffline(true);
  await expect.poll(async () => (await snap(player)).online, { timeout: 30_000 }).toBe(false);
  const seqOffline = await recordSequence(player, 9000);
  expect(new Set(seqOffline.map((s) => s.name)).size).toBeGreaterThanOrEqual(2);

  // reinício do navegador/página sem servidor: carrega do service worker e toca do cache
  await player.reload();
  await expect.poll(async () => (await snap(player).catch(() => ({ status: 'x' }) as EngineSnap)).status, { timeout: 30_000 }).toBe('playing');
  const seqReload = await recordSequence(player, 14_000);
  const names = seqReload.map((s) => s.name);
  expect(names).toContain('Video Institucional');
  expect(new Set(names).size).toBeGreaterThanOrEqual(3);

  // reconexão automática
  await playerCtx.setOffline(false);
  await expect.poll(async () => (await snap(player)).online, { timeout: 40_000 }).toBe(true);
  await admin.goto(deviceUrl);
  await expect(admin.getByText('Online', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});

test('revogação: o telão volta para a tela de vinculação', async () => {
  await admin.goto(deviceUrl);
  await admin.getByRole('button', { name: 'Revogar acesso' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Revogar' }).click();
  await expect(player.locator('.code')).toBeVisible({ timeout: 20_000 });
  expect((await snap(player)).total).toBe(0);
});
