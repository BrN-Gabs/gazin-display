import type { FitMode, PlaybackStatus, SnapshotItem, VersionSnapshot } from '../shared/types';

/**
 * Motor de reprodução do telão.
 *
 * - Duas camadas (A/B): a próxima mídia é pré-carregada na camada oculta e só é exibida
 *   quando está pronta (imagem decodificada / vídeo com dados para tocar). A mídia anterior
 *   permanece visível até lá — sem tela preta ou branca entre mídias.
 * - Imagens: tempo configurado. Vídeos: até o fim (evento `ended`), com watchdog de travamento.
 * - Falhas não travam o loop: a mídia é pulada; se todas falharem, exibe o fallback e tenta de novo.
 * - Uma nova versão pode ser aplicada na transição entre mídias (`beforeAdvance`).
 */

export interface EngineCallbacks {
  mediaUrl(item: SnapshotItem): string;
  onItemStart(item: SnapshotItem, index: number): void;
  onError(item: SnapshotItem | null, message: string): void;
  /** Chamado antes de avançar; retorna uma versão pronta para entrar no próximo intervalo */
  beforeAdvance(): VersionSnapshot | null;
  onVersionApplied(version: VersionSnapshot): void;
  onChange(): void;
}

interface Slot {
  root: HTMLDivElement;
  img: HTMLImageElement;
  video: HTMLVideoElement;
  item: SnapshotItem | null;
  ready: Promise<boolean> | null;
  error: string | null;
  loadToken: number;
}

const FADE_MS = 350;
const IMAGE_TIMEOUT_MS = 20_000;
const VIDEO_TIMEOUT_MS = 45_000;
const STALL_LIMIT_CHECKS = 6; // x 2.5s = 15s sem avançar
const ALL_FAILED_RETRY_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

export class PlaybackEngine {
  version: VersionSnapshot | null = null;
  index = -1;
  status: PlaybackStatus = 'idle';
  paused = false;
  fit: FitMode = 'contain';
  audio = false;
  audioBlocked = false;
  lastError: string | null = null;

  private slots: [Slot, Slot];
  private front = 0;
  private token = 0;
  private loadSeq = 0;
  private imageTimer: ReturnType<typeof setTimeout> | null = null;
  private imageDeadline = 0;
  private imageRemaining = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private stallChecks = 0;
  private lastVideoTime = -1;
  private showingFallback = false;

  constructor(
    private stage: HTMLElement,
    private cb: EngineCallbacks,
  ) {
    this.slots = [this.createSlot('a'), this.createSlot('b')];
    setInterval(() => this.watchdog(), 2500);
  }

  private createSlot(name: string): Slot {
    const root = document.createElement('div');
    root.className = 'slot';
    root.dataset.slot = name;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    root.append(img, video);
    this.stage.append(root);
    const slot: Slot = { root, img, video, item: null, ready: null, error: null, loadToken: 0 };
    video.addEventListener('ended', () => {
      if (this.slots[this.front] === slot && !this.paused) this.onVideoEnded();
    });
    video.addEventListener('error', () => {
      if (this.slots[this.front] === slot && slot.item && this.status === 'playing') this.fail(slot.item, this.describeVideoError(video));
    });
    return slot;
  }

  private describeVideoError(v: HTMLVideoElement) {
    const code = v.error?.code;
    return code === 4 ? 'Formato de vídeo não suportado pelo navegador' : code === 3 ? 'Erro ao decodificar o vídeo' : code === 2 ? 'Erro de rede ao carregar o vídeo' : 'Erro ao reproduzir o vídeo';
  }

  get current(): SnapshotItem | null {
    return this.version?.items[this.index] ?? null;
  }

  get frontSlot() {
    return this.slots[this.front];
  }

  // ---------------- API pública ----------------

  load(version: VersionSnapshot, startIndex = 0) {
    this.version = version;
    this.status = 'starting';
    this.paused = false;
    this.consecutiveFailures = 0;
    this.cb.onVersionApplied(version);
    void this.go(startIndex);
  }

  /** Sem programação: para tudo e mostra tela vazia (preta ou standby) */
  clear() {
    this.token++;
    this.clearTimers();
    this.version = null;
    this.index = -1;
    this.status = 'idle';
    this.paused = false;
    for (const s of this.slots) this.unloadSlot(s, true);
    this.cb.onChange();
  }

  pause() {
    if (!this.version || this.paused) return;
    this.paused = true;
    const item = this.current;
    if (item?.type === 'image' && this.imageTimer) {
      this.imageRemaining = Math.max(0, this.imageDeadline - performance.now());
      clearTimeout(this.imageTimer);
      this.imageTimer = null;
    } else if (item?.type === 'video') {
      this.frontSlot.video.pause();
    }
    this.status = 'paused';
    this.cb.onChange();
  }

  resume() {
    if (!this.version || !this.paused) return;
    this.paused = false;
    this.status = 'playing';
    const item = this.current;
    if (item?.type === 'image') this.armImageTimer(this.imageRemaining || item.durationMs);
    else if (item?.type === 'video') void this.playVideo(this.frontSlot, this.token);
    this.cb.onChange();
  }

  next() {
    if (!this.version) return;
    this.paused = false;
    this.advance();
  }

  previous() {
    if (!this.version) return;
    this.paused = false;
    void this.go(this.index - 1);
  }

  restart() {
    if (!this.version) return;
    this.paused = false;
    void this.go(0);
  }

  goto(index: number) {
    if (!this.version || index < 0 || index >= this.version.items.length) return false;
    this.paused = false;
    void this.go(index);
    return true;
  }

  setFit(mode: FitMode) {
    this.fit = mode;
    for (const s of this.slots) {
      s.img.style.objectFit = mode;
      s.video.style.objectFit = mode;
    }
    this.cb.onChange();
  }

  setAudio(on: boolean) {
    this.audio = on;
    this.audioBlocked = false;
    const v = this.frontSlot.video;
    v.muted = !on;
    if (this.current?.type === 'video' && !this.paused) void this.playVideo(this.frontSlot, this.token);
    this.cb.onChange();
  }

  /** Operador clicou na tela: libera áudio bloqueado pelo navegador */
  unlockAudio() {
    if (!this.audio) return;
    this.audioBlocked = false;
    const v = this.frontSlot.video;
    v.muted = false;
    if (this.current?.type === 'video') void v.play().catch(() => {});
    this.cb.onChange();
  }

  elapsedMs() {
    const item = this.current;
    if (!item) return 0;
    if (item.type === 'image') {
      const remaining = this.paused || !this.imageTimer ? this.imageRemaining : Math.max(0, this.imageDeadline - performance.now());
      return Math.max(0, item.durationMs - remaining);
    }
    return Math.round((this.frontSlot.video.currentTime || 0) * 1000);
  }

  durationMs() {
    const item = this.current;
    if (!item) return 0;
    if (item.type === 'video') {
      const d = this.frontSlot.video.duration;
      return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : item.durationMs;
    }
    return item.durationMs;
  }

  // ---------------- Núcleo ----------------

  private clearTimers() {
    if (this.imageTimer) clearTimeout(this.imageTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.imageTimer = null;
    this.retryTimer = null;
  }

  private armImageTimer(ms: number) {
    if (this.imageTimer) clearTimeout(this.imageTimer);
    this.imageRemaining = ms;
    this.imageDeadline = performance.now() + ms;
    const token = this.token;
    this.imageTimer = setTimeout(() => {
      this.imageTimer = null;
      if (token === this.token && !this.paused) this.advance();
    }, ms);
  }

  private unloadSlot(slot: Slot, hide: boolean) {
    slot.loadToken = ++this.loadSeq;
    slot.video.pause();
    slot.video.removeAttribute('src');
    slot.video.load();
    slot.img.removeAttribute('src');
    slot.item = null;
    slot.ready = null;
    slot.error = null;
    if (hide) slot.root.classList.remove('visible', 'is-image', 'is-video');
  }

  /** Carrega a mídia na camada; resolve `true` quando ela pode ser exibida sem tela preta */
  private loadInto(slot: Slot, item: SnapshotItem) {
    const seq = ++this.loadSeq;
    slot.loadToken = seq;
    slot.item = item;
    slot.error = null;
    const url = this.cb.mediaUrl(item);
    if (item.type === 'image') {
      slot.video.pause();
      slot.video.removeAttribute('src');
      slot.video.load();
      slot.img.src = url;
      slot.ready = withTimeout(
        slot.img.decode().then(() => true),
        IMAGE_TIMEOUT_MS,
        false,
      ).then((ok) => {
        if (!ok && slot.loadToken === seq) slot.error = 'Não foi possível abrir a imagem';
        return ok;
      });
    } else {
      slot.img.removeAttribute('src');
      const v = slot.video;
      v.muted = !this.audio || this.audioBlocked;
      v.src = url;
      v.load();
      slot.ready = withTimeout(
        new Promise<boolean>((resolve) => {
          const done = (ok: boolean) => {
            v.removeEventListener('canplay', onOk);
            v.removeEventListener('error', onErr);
            resolve(ok);
          };
          const onOk = () => done(true);
          const onErr = () => {
            if (slot.loadToken === seq) slot.error = this.describeVideoError(v);
            done(false);
          };
          if (v.readyState >= 3) return resolve(true);
          v.addEventListener('canplay', onOk);
          v.addEventListener('error', onErr);
        }),
        VIDEO_TIMEOUT_MS,
        false,
      ).then((ok) => {
        if (!ok && slot.loadToken === seq && !slot.error) slot.error = 'Tempo esgotado ao carregar o vídeo';
        return ok;
      });
    }
    return slot.ready;
  }

  private show(slot: Slot) {
    const old = this.slots[this.front];
    this.front = this.slots.indexOf(slot);
    slot.root.classList.toggle('is-image', slot.item?.type === 'image');
    slot.root.classList.toggle('is-video', slot.item?.type === 'video');
    slot.root.style.zIndex = '2';
    old.root.style.zIndex = '1';
    slot.root.classList.add('visible');
    if (old !== slot) {
      const oldToken = old.loadToken;
      setTimeout(() => {
        // a camada antiga só some depois que a nova cobriu a tela
        if (this.slots[this.front] !== old && old.loadToken === oldToken) {
          old.root.classList.remove('visible');
          old.video.pause();
          this.preloadNext();
        }
      }, FADE_MS + 50);
    }
  }

  private nextIndex() {
    if (!this.version) return -1;
    const n = this.index + 1;
    if (n < this.version.items.length) return n;
    return this.version.settings.loop ? 0 : -1;
  }

  /** Pré-carrega a próxima mídia na camada oculta */
  private preloadNext() {
    if (!this.version) return;
    const ni = this.nextIndex();
    if (ni < 0) return;
    const item = this.version.items[ni]!;
    const back = this.slots[1 - this.front]!;
    if (item.itemId === this.current?.itemId) return; // playlist de 1 item
    if (back.item?.itemId === item.itemId && back.item.mediaId === item.mediaId && back.ready) return;
    void this.loadInto(back, item);
  }

  private async playVideo(slot: Slot, token: number) {
    const v = slot.video;
    v.muted = !this.audio || this.audioBlocked;
    try {
      await v.play();
    } catch (err) {
      if (token !== this.token) return;
      if (!v.muted) {
        // autoplay com áudio bloqueado pelo navegador: continua sem áudio
        this.audioBlocked = true;
        this.cb.onError(slot.item, 'O navegador bloqueou o áudio automático; reproduzindo sem som.');
        v.muted = true;
        try {
          await v.play();
          this.cb.onChange();
          return;
        } catch {
          /* cai na falha abaixo */
        }
      }
      if ((err as DOMException)?.name === 'AbortError') return;
      if (slot.item) this.fail(slot.item, 'O navegador não conseguiu iniciar o vídeo');
    }
  }

  private async go(i: number) {
    const version = this.version;
    if (!version || !version.items.length) {
      this.clear();
      return;
    }
    const token = ++this.token;
    this.clearTimers();
    const len = version.items.length;
    const index = ((i % len) + len) % len;
    const item = version.items[index]!;
    this.index = index;
    this.status = this.status === 'idle' ? 'starting' : this.status;
    this.cb.onChange();

    const front = this.slots[this.front]!;
    let target = this.slots[1 - this.front]!;
    // mesmo item em exibição (ex.: reiniciar playlist de 1 item): reutiliza a camada atual
    if (front.item?.itemId === item.itemId && front.item.mediaId === item.mediaId && front.ready && (await front.ready)) {
      if (token !== this.token) return;
      target = front;
      if (item.type === 'video') front.video.currentTime = 0;
    } else {
      const preloaded = target.item?.itemId === item.itemId && target.item.mediaId === item.mediaId && target.ready;
      const ok = await (preloaded ? target.ready! : this.loadInto(target, item));
      if (token !== this.token) return;
      if (!ok) {
        this.fail(item, target.error ?? 'Falha ao carregar a mídia');
        return;
      }
    }

    this.show(target);
    this.showingFallback = false;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.status = this.paused ? 'paused' : 'playing';
    this.stallChecks = 0;
    this.lastVideoTime = -1;
    if (item.type === 'image') {
      if (this.paused) this.imageRemaining = item.durationMs;
      else this.armImageTimer(item.durationMs);
    } else if (!this.paused) {
      await this.playVideo(target, token);
    }
    if (token !== this.token) return;
    this.cb.onItemStart(item, index);
    this.cb.onChange();
    if (target === front) this.preloadNext();
  }

  private onVideoEnded() {
    const v = this.version;
    if (v && v.items.length === 1 && v.settings.loop) {
      // playlist de um único vídeo: reinicia sem recarregar (a menos que haja nova versão)
      const pending = this.cb.beforeAdvance();
      if (!pending) {
        const s = this.frontSlot;
        s.video.currentTime = 0;
        void this.playVideo(s, this.token);
        this.cb.onItemStart(v.items[0]!, 0);
        return;
      }
    }
    this.advance();
  }

  private advance() {
    if (!this.version) return;
    const pending = this.cb.beforeAdvance();
    if (pending) {
      // aplica a nova versão no intervalo entre mídias, mantendo a sequência
      const currentId = this.current?.itemId;
      const pos = pending.items.findIndex((it) => it.itemId === currentId);
      let next = pos >= 0 ? pos + 1 : Math.max(0, this.index);
      if (next >= pending.items.length) next = 0;
      this.version = pending;
      this.cb.onVersionApplied(pending);
      void this.go(next);
      return;
    }
    const ni = this.nextIndex();
    if (ni < 0) {
      // sem loop: mantém a última mídia na tela
      this.status = 'idle';
      this.cb.onChange();
      return;
    }
    if (ni === this.index && this.current?.type === 'image') {
      // playlist de uma única imagem
      this.armImageTimer(this.current.durationMs);
      this.cb.onItemStart(this.current, this.index);
      return;
    }
    void this.go(ni);
  }

  private fail(item: SnapshotItem, message: string) {
    const token = ++this.token;
    this.clearTimers();
    this.lastError = `${item.name}: ${message}`;
    this.consecutiveFailures++;
    this.cb.onError(item, message);
    const total = this.version?.items.length ?? 0;
    if (this.consecutiveFailures >= total) {
      // nada reproduzível: fallback (se houver) e nova tentativa depois
      this.status = 'error';
      void this.showFallback(token);
      this.retryTimer = setTimeout(() => {
        if (token !== this.token) return;
        this.consecutiveFailures = 0;
        void this.go(this.index + 1);
      }, ALL_FAILED_RETRY_MS);
      this.cb.onChange();
      return;
    }
    this.retryTimer = setTimeout(() => {
      if (token === this.token) {
        this.token++;
        const pending = this.cb.beforeAdvance();
        if (pending) {
          this.version = pending;
          this.cb.onVersionApplied(pending);
          void this.go(0);
        } else void this.go(this.index + 1);
      }
    }, 400);
  }

  private async showFallback(token: number) {
    const fb = this.version?.fallback;
    if (!fb || this.showingFallback) return;
    const back = this.slots[1 - this.front]!;
    const ok = await this.loadInto(back, fb);
    if (ok && token === this.token) {
      this.show(back);
      this.showingFallback = true;
    }
  }

  private watchdog() {
    if (this.status !== 'playing' || this.paused || this.current?.type !== 'video') return;
    const v = this.frontSlot.video;
    if (v.paused && !v.ended && v.readyState >= 2) {
      // pausado sem motivo (ex.: política do navegador) — tenta retomar
      void this.playVideo(this.frontSlot, this.token);
    }
    if (v.currentTime === this.lastVideoTime) this.stallChecks++;
    else this.stallChecks = 0;
    this.lastVideoTime = v.currentTime;
    if (this.stallChecks >= STALL_LIMIT_CHECKS && this.current) {
      this.stallChecks = 0;
      this.fail(this.current, 'Vídeo travado (sem progresso por 15 s)');
    }
  }
}
