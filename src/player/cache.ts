import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SnapshotItem } from '../shared/types';

/**
 * Cache persistente das mídias (Cache Storage). O service worker entrega estes arquivos
 * ao <video>/<img> mesmo sem servidor. Disponível apenas em contexto seguro (HTTPS ou localhost).
 */
export const MEDIA_CACHE = 'gd-media-v1';
export const mediaPath = (mediaId: string) => `/api/player/media/${mediaId}`;

export class StorageInsufficientError extends Error {
  constructor(
    public needed: number,
    public available: number,
  ) {
    super(`Espaço insuficiente no navegador do telão: necessário ${(needed / 1e9).toFixed(2)} GB, disponível ${(available / 1e9).toFixed(2)} GB.`);
  }
}

export interface PrepareProgress {
  doneItems: number;
  totalItems: number;
  doneBytes: number;
  totalBytes: number;
}

export class MediaCache {
  readonly supported: boolean;
  persisted: boolean | null = null;

  constructor() {
    this.supported = typeof caches !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator;
  }

  async init() {
    if (!this.supported) return;
    try {
      this.persisted = (await navigator.storage?.persisted?.()) ?? null;
      if (!this.persisted && navigator.storage?.persist) this.persisted = await navigator.storage.persist();
    } catch {
      this.persisted = null;
    }
  }

  async estimate() {
    try {
      const e = await navigator.storage.estimate();
      return { usage: e.usage ?? null, quota: e.quota ?? null };
    } catch {
      return { usage: null, quota: null };
    }
  }

  private open() {
    return caches.open(MEDIA_CACHE);
  }

  /** Verificação rápida: existe, tamanho e checksum registrados conferem */
  async has(item: Pick<SnapshotItem, 'mediaId' | 'checksum' | 'sizeBytes'>) {
    if (!this.supported) return false;
    const res = await (await this.open()).match(mediaPath(item.mediaId));
    if (!res) return false;
    const len = Number(res.headers.get('content-length'));
    return res.headers.get('x-gd-checksum') === item.checksum && (!len || len === item.sizeBytes);
  }

  async count() {
    if (!this.supported) return 0;
    return (await (await this.open()).keys()).length;
  }

  async remove(mediaId: string) {
    if (!this.supported) return;
    await (await this.open()).delete(mediaPath(mediaId));
  }

  /** Remove do cache tudo que não estiver na lista informada */
  async retainOnly(mediaIds: Set<string>) {
    if (!this.supported) return 0;
    const cache = await this.open();
    let removed = 0;
    for (const req of await cache.keys()) {
      const id = new URL(req.url).pathname.split('/').pop()!;
      if (!mediaIds.has(id)) {
        await cache.delete(req);
        removed++;
      }
    }
    return removed;
  }

  /** Baixa e verifica integridade (SHA-256) de uma mídia */
  async download(item: SnapshotItem, onBytes: (n: number) => void, signal?: AbortSignal) {
    const cache = await this.open();
    const path = mediaPath(item.mediaId);
    // ?network=1 faz o service worker ignorar o cache e ir ao servidor
    const res = await fetch(`${path}?network=1`, { cache: 'no-store', credentials: 'same-origin', signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ao baixar "${item.name}"`);
    const hasher = sha256.create();
    let received = 0;
    const verify = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hasher.update(chunk);
        received += chunk.byteLength;
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
    const stored = new Response(res.body.pipeThrough(verify), {
      headers: { 'Content-Type': item.mimeType, 'Content-Length': String(item.sizeBytes), 'X-GD-Checksum': item.checksum },
    });
    await cache.put(path, stored);
    const digest = bytesToHex(hasher.digest());
    if (received !== item.sizeBytes || (item.checksum && digest !== item.checksum)) {
      await cache.delete(path);
      throw new Error(`Arquivo corrompido durante o download: "${item.name}"`);
    }
  }

  /**
   * Garante que todas as mídias da versão estejam no cache local antes de aplicá-la.
   * Nunca remove mídias da versão ativa (`protect`).
   */
  async prepare(items: SnapshotItem[], protect: Set<string>, onProgress: (p: PrepareProgress) => void, signal?: AbortSignal) {
    if (!this.supported) return;
    const unique = [...new Map(items.map((i) => [i.mediaId, i])).values()];
    const missing: SnapshotItem[] = [];
    for (const it of unique) if (!(await this.has(it))) missing.push(it);
    const totalBytes = missing.reduce((s, i) => s + i.sizeBytes, 0);
    const progress: PrepareProgress = { doneItems: unique.length - missing.length, totalItems: unique.length, doneBytes: 0, totalBytes };
    onProgress(progress);
    if (!missing.length) return;

    // espaço: libera primeiro o que não pertence nem à versão ativa nem à nova
    let { usage, quota } = await this.estimate();
    if (usage !== null && quota !== null && totalBytes > (quota - usage) * 0.95) {
      await this.retainOnly(new Set([...protect, ...unique.map((i) => i.mediaId)]));
      ({ usage, quota } = await this.estimate());
      if (usage !== null && quota !== null && totalBytes > (quota - usage) * 0.95) throw new StorageInsufficientError(totalBytes, quota - usage);
    }

    for (const item of missing) {
      let attempt = 0;
      for (;;) {
        attempt++;
        let bytes = 0;
        try {
          await this.download(item, (n) => {
            bytes += n;
            progress.doneBytes += n;
            onProgress(progress);
          }, signal);
          break;
        } catch (err) {
          progress.doneBytes -= bytes;
          if (signal?.aborted || attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      progress.doneItems++;
      onProgress(progress);
    }
  }
}
