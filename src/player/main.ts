import { io, type Socket } from 'socket.io-client';
import './player.css';
import { PlaybackEngine } from './engine';
import { MediaCache, StorageInsufficientError, mediaPath, type PrepareProgress } from './cache';
import {
  SocketEvents,
  type CommandAck,
  type DeviceCommandMessage,
  type PlayerEventMessage,
  type PlayerManifest,
  type PlayerStateReport,
  type SnapshotItem,
  type VersionSnapshot,
} from '../shared/types';

const APP_VERSION = '1.0.0';
const STATE_KEY = 'gd.player.manifest';
const POSITION_KEY = 'gd.player.position';
const RECONCILE_MS = 60_000;
const STATE_REPORT_MS = 5_000;
const bootAt = Date.now();

// ---------------- persistência local (sobrevive a reinícios) ----------------
const store = {
  get<T>(key: string): T | null {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível */
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};

const csrf = { 'x-gd-csrf': '1' };
async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
  const res = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { ...csrf, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------- telas auxiliares (pareamento / sem conteúdo) ----------------
const stageEl = document.getElementById('stage')!;
const overlay = document.createElement('div');
overlay.className = 'overlay hidden';
document.body.append(overlay);
const audioHint = document.createElement('div');
audioHint.className = 'audio-hint hidden';
audioHint.textContent = 'Clique na tela para ativar o áudio';
document.body.append(audioHint);

function showOverlay(html: string, kind: 'pairing' | 'standby' | 'black' | 'message') {
  overlay.className = `overlay ${kind}`;
  overlay.innerHTML = html;
}
function hideOverlay() {
  overlay.className = 'overlay hidden';
  overlay.innerHTML = '';
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------- controlador ----------------
class PlayerController {
  engine: PlaybackEngine;
  cache = new MediaCache();
  socket: Socket | null = null;
  manifest: PlayerManifest | null = store.get<PlayerManifest>(STATE_KEY);
  /** versão já baixada e pronta, aguardando o próximo intervalo */
  pending: VersionSnapshot | null = null;
  preparingId: string | null = null;
  preparing: PrepareProgress | null = null;
  prepareError: string | null = null;
  lastPrepareAttempt = new Map<string, number>();
  paired = false;
  online = false;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor() {
    this.engine = new PlaybackEngine(stageEl, {
      mediaUrl: (item) => mediaPath(item.mediaId),
      onItemStart: (item, index) => {
        store.set(POSITION_KEY, { versionId: this.engine.version?.versionId, itemId: item.itemId, index });
        this.maybeNightlyReload();
        this.reportState();
      },
      onError: (item, message) => {
        this.emitEvent({ type: message.includes('áudio') ? 'audio_blocked' : 'playback_error', message: item ? `${item.name}: ${message}` : message, mediaId: item?.mediaId, versionId: this.engine.version?.versionId });
        // se a mídia do cache falhar, remove para baixar novamente
        if (item && !message.includes('áudio') && this.cache.supported) void this.cache.remove(item.mediaId).then(() => this.reconcileSoon());
        this.reportState();
      },
      beforeAdvance: () => {
        if (!this.pending) return null;
        const v = this.pending;
        this.pending = null;
        return v;
      },
      onVersionApplied: (version) => {
        hideOverlay();
        this.applySettings();
        this.emitEvent({ type: 'version_applied', message: `Reproduzindo "${version.playlistName}" versão ${version.number}`, versionId: version.versionId });
        void this.cleanupCache();
        this.reportState();
      },
      onChange: () => this.updateAudioHint(),
    });
  }

  async boot() {
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('click', () => this.engine.unlockAudio());
    void this.acquireWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.acquireWakeLock();
    });
    if (this.cache.supported) {
      try {
        await navigator.serviceWorker.register('/player/sw.js', { scope: '/player/', type: import.meta.env.DEV ? 'module' : 'classic' });
      } catch (err) {
        console.warn('service worker indisponível', err);
      }
      await this.cache.init();
    }

    // 1) Começa imediatamente com a última programação salva (funciona sem servidor)
    if (this.manifest?.version) this.startFromLocal(this.manifest);
    else showOverlay('<div class="boot"><div class="spinner"></div></div>', 'black');

    // 2) Conecta ao servidor
    await this.checkSession();
    setInterval(() => void this.reconcile(), RECONCILE_MS);
    setInterval(() => this.reportState(), STATE_REPORT_MS);
    window.addEventListener('online', () => void this.checkSession());
  }

  private startFromLocal(m: PlayerManifest) {
    const pos = store.get<{ versionId: string; itemId: string; index: number }>(POSITION_KEY);
    let start = 0;
    if (pos && pos.versionId === m.version!.versionId) {
      const i = m.version!.items.findIndex((it) => it.itemId === pos.itemId);
      start = i >= 0 ? i : 0;
    }
    this.engine.setFit(m.overrides.fitMode ?? m.version!.settings.fitMode);
    this.engine.audio = m.overrides.audio ?? m.version!.settings.audio;
    this.engine.load(m.version!, start);
  }

  private async acquireWakeLock() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* sem suporte */
    }
  }

  // ---------------- sessão / pareamento ----------------

  async checkSession() {
    let res: { status: number; body: { paired: boolean } | null };
    try {
      res = await api('/api/player/session');
    } catch {
      this.online = false;
      setTimeout(() => void this.checkSession(), 15_000);
      return;
    }
    this.online = true;
    if (res.status === 401) return this.startPairing();
    if (res.status !== 200) {
      setTimeout(() => void this.checkSession(), 15_000);
      return;
    }
    this.paired = true;
    this.connectSocket();
    await this.reconcile();
  }

  private async startPairing() {
    this.paired = false;
    this.socket?.disconnect();
    this.socket = null;
    // dispositivo não autorizado: não reproduz conteúdo
    this.engine.clear();
    this.manifest = null;
    this.pending = null;
    store.del(STATE_KEY);
    store.del(POSITION_KEY);
    try {
      const { status, body } = await api<{ id: string; code: string; pollSecret: string; expiresAt: string }>('/api/player/pairing', { method: 'POST', body: '{}' });
      if (status !== 200 || !body) throw new Error(String(status));
      this.renderPairing(body.code, new Date(body.expiresAt));
      this.pollPairing(body.id, body.pollSecret, new Date(body.expiresAt));
    } catch {
      showOverlay('<div class="pair"><div class="brand">GAZIN DISPLAY</div><p class="muted">Sem conexão com o servidor. Tentando novamente…</p></div>', 'pairing');
      this.pairingTimer = setTimeout(() => void this.checkSession(), 15_000);
    }
  }

  private renderPairing(code: string, expiresAt: Date) {
    const url = `${location.origin}/admin/devices`;
    showOverlay(
      `<div class="pair">
        <div class="brand">GAZIN DISPLAY</div>
        <h1>Vincular este telão</h1>
        <p class="muted">No painel administrativo, acesse <b>Telões → Vincular telão</b> e informe o código:</p>
        <div class="code">${esc(code)}</div>
        <p class="muted small">${esc(url)} · o código expira às ${expiresAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</p>
      </div>`,
      'pairing',
    );
  }

  private pollPairing(id: string, secret: string, expiresAt: Date) {
    const tick = async () => {
      if (Date.now() > expiresAt.getTime()) return void this.startPairing();
      try {
        const { body } = await api<{ status: string }>(`/api/player/pairing/${id}/poll`, { method: 'POST', body: JSON.stringify({ pollSecret: secret }) });
        if (body?.status === 'approved') {
          showOverlay('<div class="pair"><div class="brand">GAZIN DISPLAY</div><h1>Telão vinculado</h1><p class="muted">Carregando programação…</p></div>', 'pairing');
          return void this.checkSession();
        }
        if (body?.status === 'expired' || body?.status === 'consumed') return void this.startPairing();
      } catch {
        /* rede instável: tenta de novo */
      }
      this.pairingTimer = setTimeout(() => void tick(), 3000);
    };
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = setTimeout(() => void tick(), 3000);
  }

  // ---------------- tempo real ----------------

  private connectSocket() {
    if (this.socket) return;
    const socket = io('/player', { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 15_000, timeout: 10_000 });
    this.socket = socket;
    socket.on('connect', () => {
      this.online = true;
      this.reportState();
    });
    socket.on('disconnect', () => {
      this.online = false;
    });
    socket.on('connect_error', (err) => {
      this.online = false;
      if (/não autorizado/i.test(err.message)) {
        socket.disconnect();
        this.socket = null;
        void this.checkSession();
      }
    });
    socket.on(SocketEvents.Sync, (m: PlayerManifest) => void this.handleManifest(m));
    socket.on(SocketEvents.Revoked, () => {
      socket.disconnect();
      this.socket = null;
      void this.startPairing();
    });
    socket.on(SocketEvents.Command, (cmd: DeviceCommandMessage, ack: (r: CommandAck) => void) => {
      void this.handleCommand(cmd).then(ack, (err) => ack({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
  }

  /** Reconciliação periódica via HTTP: não depende de mensagens WebSocket (que podem ser perdidas) */
  async reconcile() {
    if (!this.paired) return;
    try {
      const { status, body } = await api<PlayerManifest>('/api/player/manifest');
      if (status === 401) return void this.startPairing();
      if (status === 200 && body) {
        this.online = true;
        await this.handleManifest(body);
      }
    } catch {
      this.online = false;
    }
  }

  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileSoon() {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile();
    }, 5000);
  }

  async handleManifest(m: PlayerManifest) {
    const prevOverrides = JSON.stringify(this.manifest?.overrides ?? {});
    // mantém a versão em uso localmente; demais campos (ajustes, comportamento) seguem o servidor
    this.manifest = { ...m, version: this.manifest?.version ?? null };
    if (JSON.stringify(m.overrides) !== prevOverrides) this.applySettings(m);
    if (this.manifest.version) store.set(STATE_KEY, this.manifest);

    const target = m.version;
    const current = this.engine.version;
    if (!target) {
      this.pending = null;
      this.saveManifest(m, null);
      if (current) this.engine.clear();
      this.showEmpty(m);
      return;
    }
    if (current?.versionId === target.versionId) {
      this.pending = null;
      this.saveManifest(m, target);
      if (!this.engine.version || this.engine.status === 'idle') hideOverlay();
      return;
    }
    if (this.pending?.versionId === target.versionId || this.preparingId === target.versionId) return;
    if (this.preparingId) {
      // outra versão está sendo baixada: processa esta (a mais recente) quando terminar
      this.queued = m;
      return;
    }
    // evita repetir falhas em sequência (ex.: falta de espaço) — tenta no máximo a cada 2 min
    const last = this.lastPrepareAttempt.get(target.versionId) ?? 0;
    if (this.prepareError && Date.now() - last < 120_000) return;
    this.lastPrepareAttempt.set(target.versionId, Date.now());
    await this.prepareAndApply(m, target);
    const q = this.queued;
    this.queued = null;
    if (q) await this.handleManifest(q);
  }

  private queued: PlayerManifest | null = null;

  /** Baixa e valida todos os arquivos da nova versão; só então a aplica. Em caso de falha, mantém a atual. */
  private async prepareAndApply(m: PlayerManifest, target: VersionSnapshot) {
    this.preparingId = target.versionId;
    this.prepareError = null;
    const needed: SnapshotItem[] = [...target.items, ...(target.fallback ? [target.fallback] : [])];
    const protect = new Set((this.engine.version ? [...this.engine.version.items, ...(this.engine.version.fallback ? [this.engine.version.fallback] : [])] : []).map((i) => i.mediaId));
    try {
      await this.cache.prepare(needed, protect, (p) => {
        this.preparing = { ...p };
        this.reportStateThrottled();
      });
    } catch (err) {
      this.preparingId = null;
      this.preparing = null;
      this.prepareError = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: err instanceof StorageInsufficientError ? 'storage_insufficient' : 'prepare_error',
        message: `Versão ${target.number} de "${target.playlistName}" não aplicada: ${this.prepareError}. A programação anterior continua no ar.`,
        versionId: target.versionId,
      });
      this.reportState();
      if (!this.engine.version) this.showEmpty(m, this.prepareError);
      return;
    }
    this.preparingId = null;
    this.preparing = null;
    // a programação mudou enquanto baixava: a versão mais nova (na fila) será processada em seguida
    if (this.queued && this.queued.version?.versionId !== target.versionId) return;
    this.saveManifest(m, target);
    const engineIdle = !this.engine.version || this.engine.status === 'idle' || this.engine.status === 'error';
    if (engineIdle || m.applyMode === 'immediate') {
      this.pending = null;
      this.engine.setFit(m.overrides.fitMode ?? target.settings.fitMode);
      this.engine.audio = m.overrides.audio ?? target.settings.audio;
      this.engine.load(target, 0);
    } else {
      // entra no próximo intervalo entre mídias
      this.pending = target;
    }
    this.reportState();
  }

  private saveManifest(m: PlayerManifest, version: VersionSnapshot | null) {
    this.manifest = { ...m, version };
    store.set(STATE_KEY, this.manifest);
  }

  private applySettings(m = this.manifest) {
    const v = this.engine.version;
    if (!m || !v) return;
    const fit = m.overrides.fitMode ?? v.settings.fitMode;
    const audio = m.overrides.audio ?? v.settings.audio;
    if (fit !== this.engine.fit) this.engine.setFit(fit);
    if (audio !== this.engine.audio) this.engine.setAudio(audio);
  }

  private showEmpty(m: PlayerManifest, error?: string | null) {
    if (m.emptyBehavior === 'black' && !error) return showOverlay('', 'black');
    showOverlay(
      `<div class="standby"><div class="brand">GAZIN DISPLAY</div><p>${error ? esc(error) : 'Nenhuma programação publicada para este telão.'}</p><p class="small">${esc(m.device.name)}</p></div>`,
      'standby',
    );
  }

  private async cleanupCache() {
    if (!this.cache.supported) return;
    const keep = new Set<string>();
    for (const v of [this.engine.version, this.pending]) {
      if (!v) continue;
      for (const i of v.items) keep.add(i.mediaId);
      if (v.fallback) keep.add(v.fallback.mediaId);
    }
    // só limpa quando não há download em andamento
    if (this.preparingId || !keep.size) return;
    await this.cache.retainOnly(keep).catch(() => {});
  }

  // ---------------- comandos remotos ----------------

  private async handleCommand(cmd: DeviceCommandMessage): Promise<CommandAck> {
    const e = this.engine;
    const needsContent = ['pause', 'resume', 'next', 'previous', 'restart', 'goto'];
    if (needsContent.includes(cmd.type) && !e.version) return { ok: false, error: 'Não há programação em reprodução neste telão.' };
    switch (cmd.type) {
      case 'pause':
        e.pause();
        break;
      case 'resume':
        e.resume();
        break;
      case 'next':
        e.next();
        break;
      case 'previous':
        e.previous();
        break;
      case 'restart':
        e.restart();
        break;
      case 'goto':
        if (!e.goto(cmd.payload?.index ?? -1)) return { ok: false, error: 'Item inexistente na programação atual.' };
        break;
      case 'set_audio':
        if (this.manifest) this.manifest.overrides = { ...this.manifest.overrides, audio: !!cmd.payload?.enabled };
        e.setAudio(!!cmd.payload?.enabled);
        break;
      case 'set_fit':
        if (this.manifest) this.manifest.overrides = { ...this.manifest.overrides, fitMode: cmd.payload?.fitMode === 'cover' ? 'cover' : 'contain' };
        e.setFit(cmd.payload?.fitMode === 'cover' ? 'cover' : 'contain');
        break;
      case 'sync':
        void this.reconcile();
        break;
      case 'reload':
        setTimeout(() => location.reload(), 500);
        return { ok: true, state: this.state() };
      default:
        return { ok: false, error: 'Comando desconhecido.' };
    }
    if (this.manifest) store.set(STATE_KEY, this.manifest);
    // aguarda a mídia começar para devolver o estado real
    await new Promise((r) => setTimeout(r, 300));
    this.reportState();
    return { ok: true, state: this.state() };
  }

  // ---------------- estado ----------------

  private uptimeReloadChecked = false;
  /** Recarrega a página uma vez por dia (madrugada), em um intervalo entre mídias, para liberar memória */
  private maybeNightlyReload() {
    const hours = (Date.now() - bootAt) / 3600_000;
    const h = new Date().getHours();
    if (hours > 20 && h >= 3 && h < 5 && this.online && !this.uptimeReloadChecked) {
      this.uptimeReloadChecked = true;
      setTimeout(() => location.reload(), 200);
    }
  }

  private updateAudioHint() {
    audioHint.classList.toggle('hidden', !this.engine.audioBlocked || !this.engine.audio);
  }

  state(): PlayerStateReport {
    const e = this.engine;
    const item = e.current;
    return {
      status: e.status,
      versionId: e.version?.versionId ?? null,
      versionNumber: e.version?.number ?? null,
      playlistName: e.version?.playlistName ?? null,
      index: e.index,
      total: e.version?.items.length ?? 0,
      itemId: item?.itemId ?? null,
      mediaId: item?.mediaId ?? null,
      mediaName: item?.name ?? null,
      mediaType: item?.type ?? null,
      elapsedMs: e.elapsedMs(),
      durationMs: e.durationMs(),
      pendingVersionId: this.pending?.versionId ?? null,
      preparing: this.preparingId && this.preparing ? { versionId: this.preparingId, ...this.preparing } : null,
      prepareError: this.prepareError,
      cache: { usageBytes: this.lastEstimate.usage, quotaBytes: this.lastEstimate.quota, persisted: this.cache.supported ? this.cache.persisted : null, cachedItems: this.lastCount },
      fitMode: e.fit,
      audio: e.audio,
      audioBlocked: e.audioBlocked,
      lastError: e.lastError,
      screen: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight), dpr: window.devicePixelRatio || 1 },
      appVersion: `${APP_VERSION}${this.cache.supported ? '' : ' (sem cache offline: requer HTTPS)'}`,
      uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    };
  }

  private lastEstimate: { usage: number | null; quota: number | null } = { usage: null, quota: null };
  private lastCount = 0;
  private lastEstimateAt = 0;
  reportState() {
    if (Date.now() - this.lastEstimateAt > 30_000 && this.cache.supported) {
      this.lastEstimateAt = Date.now();
      void this.cache.estimate().then((e) => (this.lastEstimate = e));
      void this.cache.count().then((c) => (this.lastCount = c));
    }
    if (this.socket?.connected) this.socket.emit(SocketEvents.State, this.state());
  }

  private lastThrottled = 0;
  private reportStateThrottled() {
    if (Date.now() - this.lastThrottled > 1000) {
      this.lastThrottled = Date.now();
      this.reportState();
    }
  }

  private emitEvent(ev: PlayerEventMessage) {
    if (this.socket?.connected) this.socket.emit(SocketEvents.PlayerEvent, ev);
  }
}

const controller = new PlayerController();
(window as unknown as { __gdPlayer: PlayerController }).__gdPlayer = controller;
void controller.boot();
