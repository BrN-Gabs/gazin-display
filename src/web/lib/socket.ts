/**
 * Cliente WebSocket do GAZIN DISPLAY (substitui o socket.io-client da versão 1).
 * Usado pelo painel e pelo player. Protocolo JSON simples com o Durable Object RealtimeHub:
 *   servidor → cliente: { t: 'event', e, d } | { t: 'cmd', id, d } | { t: 'config', reportMs }
 *   cliente → servidor: { t: 'state', d } | { t: 'event', d } | { t: 'ack', id, d }
 * Reconexão automática com espera progressiva e "ping" periódico para detectar conexões mortas.
 */
type Handler = (data: any) => void;

export interface GdSocketOptions {
  /** Chamado quando a conexão não chega a abrir (ex.: credencial inválida) */
  onConnectFailed?: () => void;
  maxDelayMs?: number;
}

export class GdSocket {
  connected = false;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private cmdHandler: ((cmd: any) => Promise<unknown>) | null = null;
  private attempts = 0;
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private path: string,
    private opts: GdSocketOptions = {},
  ) {
    this.open();
  }

  on(event: string, handler: Handler) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return this;
  }

  onCommand(handler: (cmd: any) => Promise<unknown>) {
    this.cmdHandler = handler;
  }

  private fire(event: string, data?: unknown) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(data);
      } catch (err) {
        console.error(err);
      }
    });
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private open() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.path}`;
    let opened = false;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.attempts = 0;
      this.connected = true;
      this.startPing();
      this.fire('connect');
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      let msg: { t?: string; e?: string; d?: unknown; id?: string; reportMs?: number };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === 'event' && msg.e) this.fire(msg.e, msg.d);
      else if (msg.t === 'config') this.fire('config', msg);
      else if (msg.t === 'cmd' && msg.id) {
        const id = msg.id;
        const run = this.cmdHandler ? this.cmdHandler(msg.d) : Promise.resolve({ ok: false, error: 'Comando não suportado.' });
        void run.then(
          (ack) => this.send({ t: 'ack', id, d: ack }),
          (err) => this.send({ t: 'ack', id, d: { ok: false, error: err instanceof Error ? err.message : String(err) } }),
        );
      }
    };
    ws.onclose = () => {
      this.stopPing();
      const was = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (was) this.fire('disconnect');
      if (!opened) this.opts.onConnectFailed?.();
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose trata a reconexão */
    };
  }

  private scheduleReconnect() {
    if (this.retryTimer) return;
    this.attempts++;
    const delay = Math.min(this.opts.maxDelayMs ?? 15_000, 1000 * 2 ** Math.min(this.attempts - 1, 5)) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  private startPing() {
    this.stopPing();
    // respondido pela Cloudflare sem acordar o Durable Object (sem custo de duração)
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send('ping');
      if (!this.pongTimer)
        this.pongTimer = setTimeout(() => {
          this.pongTimer = null;
          this.ws?.close();
        }, 10_000);
    }, 25_000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  disconnect() {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
