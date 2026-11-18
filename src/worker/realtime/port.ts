import type { CommandAck, DeviceCommandMessage, PlayerStateReport } from '../../shared/types';
import { AppError } from '../lib/errors';
import type { Env } from '../env';

export interface LiveInfo {
  connected: boolean;
  state: PlayerStateReport | null;
  at: string | null;
}

/** Resultado de comando vindo do Durable Object (erros não atravessam o RPC com a classe original) */
export type CommandOutcome = { kind: 'ack'; ack: CommandAck } | { kind: 'offline' } | { kind: 'timeout' };

/**
 * Operações de tempo real usadas pelas rotas e serviços (equivalente à classe Realtime/Socket.IO da versão 1).
 * No Worker, cada chamada vai ao Durable Object RealtimeHub; dentro do próprio DO, a implementação é local.
 */
export interface RealtimePort {
  toAdmins(event: string, payload: unknown): void;
  toDevice(deviceId: string, event: string, payload: unknown): void;
  live(deviceIds: string[]): Promise<Record<string, LiveInfo>>;
  sendCommand(deviceId: string, msg: DeviceCommandMessage, timeoutMs?: number): Promise<CommandAck>;
  disconnectDevice(deviceId: string, reason?: string): void;
  disconnectUserSessions(userId: string, exceptSessionId?: string): void;
}

export const HUB_NAME = 'hub';

export function hubStub(env: Env) {
  return env.REALTIME.get(env.REALTIME.idFromName(HUB_NAME));
}

export function outcomeToAck(o: CommandOutcome): CommandAck {
  if (o.kind === 'offline') throw new AppError(409, 'DEVICE_OFFLINE', 'O telão está offline. O comando não foi enviado.');
  if (o.kind === 'timeout') throw new AppError(504, 'DEVICE_TIMEOUT', 'O telão não confirmou o comando a tempo.');
  const ack = o.ack;
  return ack && typeof ack.ok === 'boolean' ? ack : { ok: false, error: 'Resposta inválida do telão.' };
}

/** Implementação usada pelo Worker: encaminha ao Durable Object */
export class StubRealtime implements RealtimePort {
  constructor(
    private env: Env,
    private waitUntil: (p: Promise<unknown>) => void,
  ) {}

  private get hub() {
    return hubStub(this.env);
  }

  private fire(p: Promise<unknown>) {
    this.waitUntil(p.catch((err) => console.warn('tempo real indisponível', err)));
  }

  toAdmins(event: string, payload: unknown) {
    this.fire(this.hub.toAdmins(event, payload));
  }

  toDevice(deviceId: string, event: string, payload: unknown) {
    this.fire(this.hub.toDevice(deviceId, event, payload));
  }

  async live(deviceIds: string[]) {
    if (!deviceIds.length) return {};
    try {
      return await this.hub.live(deviceIds);
    } catch (err) {
      console.warn('tempo real indisponível', err);
      return {};
    }
  }

  async sendCommand(deviceId: string, msg: DeviceCommandMessage, timeoutMs = 10_000) {
    return outcomeToAck(await this.hub.sendCommand(deviceId, msg, timeoutMs));
  }

  disconnectDevice(deviceId: string, reason = 'revoked') {
    this.fire(this.hub.disconnectDevice(deviceId, reason));
  }

  disconnectUserSessions(userId: string, exceptSessionId?: string) {
    this.fire(this.hub.disconnectUserSessions(userId, exceptSessionId));
  }
}
