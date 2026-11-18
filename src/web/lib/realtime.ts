import { useEffect, useState, useSyncExternalStore } from 'react';
import { queryClient } from './api';
import { markProcessed } from './upload';
import { GdSocket } from './socket';
import { SocketEvents, type PlayerStateReport } from '../../shared/types';

/**
 * Conexão em tempo real do painel. Eventos do servidor invalidam as consultas
 * (react-query) e mantêm o estado ao vivo dos telões.
 */
type LiveState = { state: PlayerStateReport; at: number };

let socket: GdSocket | null = null;
let connected = false;
const live = new Map<string, LiveState>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function connectRealtime() {
  if (socket) return;
  socket = new GdSocket('/api/realtime/admin', { maxDelayMs: 10_000 });
  socket.on('connect', () => {
    connected = true;
    emit();
    void queryClient.invalidateQueries();
  });
  socket.on('disconnect', () => {
    connected = false;
    emit();
  });
  socket.on(SocketEvents.MediaUpdated, (e: { id: string; status?: string }) => {
    if (e.status) markProcessed(e.id, e.status === 'ready');
    void queryClient.invalidateQueries({ queryKey: ['media'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['playlist'] });
  });
  socket.on(SocketEvents.DeviceStatus, (e: { deviceId: string }) => {
    void queryClient.invalidateQueries({ queryKey: ['devices'] });
    void queryClient.invalidateQueries({ queryKey: ['device', e.deviceId] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  });
  socket.on(SocketEvents.DeviceState, (e: { deviceId: string; state: PlayerStateReport }) => {
    const prev = live.get(e.deviceId)?.state;
    live.set(e.deviceId, { state: e.state, at: Date.now() });
    emit();
    if (prev?.versionId !== e.state.versionId) {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['device', e.deviceId] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    }
  });
  socket.on(SocketEvents.Published, () => {
    for (const k of ['playlists', 'playlist', 'dashboard', 'devices', 'device']) void queryClient.invalidateQueries({ queryKey: [k] });
  });
  socket.on(SocketEvents.PlaylistChanged, () => void queryClient.invalidateQueries({ queryKey: ['playlists'] }));
  socket.on(SocketEvents.PairingPending, () => void queryClient.invalidateQueries({ queryKey: ['pairings'] }));
  socket.on(SocketEvents.CommandResult, (e: { deviceId: string }) => void queryClient.invalidateQueries({ queryKey: ['device', e.deviceId] }));
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
  connected = false;
  live.clear();
  emit();
}

export function useRealtimeConnected() {
  return useSyncExternalStore(subscribe, () => connected);
}

/** Estado ao vivo do player (mais recente que o salvo no banco) */
export function useLiveState(deviceId: string | undefined, fallback?: PlayerStateReport | null, fallbackAt?: string | null) {
  useSyncExternalStore(subscribe, () => version);
  const l = deviceId ? live.get(deviceId) : undefined;
  if (l) return l;
  return fallback ? { state: fallback, at: fallbackAt ? new Date(fallbackAt).getTime() : Date.now() } : null;
}

/** Re-renderiza periodicamente (para tempos relativos e barras de progresso) */
export function useTicker(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
