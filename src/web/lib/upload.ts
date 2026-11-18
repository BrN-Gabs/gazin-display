import { useSyncExternalStore } from 'react';
import { api, ApiError, queryClient } from './api';

/**
 * Gerenciador de uploads em partes (retomáveis). Cada arquivo é enviado em blocos;
 * falhas de rede são repetidas a partir da posição confirmada pelo servidor.
 */
export type UploadStatus = 'queued' | 'uploading' | 'finishing' | 'processing' | 'done' | 'error' | 'cancelled';

export interface UploadTask {
  key: string;
  file: File;
  name: string;
  size: number;
  sent: number;
  status: UploadStatus;
  error: string | null;
  uploadId: string | null;
  mediaId: string | null;
  xhr: XMLHttpRequest | null;
  cancelled: boolean;
}

const tasks: UploadTask[] = [];
const listeners = new Set<() => void>();
let snapshot: UploadTask[] = [];
const notify = () => {
  snapshot = tasks.map((t) => ({ ...t }));
  listeners.forEach((l) => l());
};
const MAX_PARALLEL = 2;
let config: { chunkBytes: number; maxBytes: number; ffmpeg: boolean } | null = null;

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|avi|mpe?g|ts)$/i;

export function validateFile(file: File, kind?: 'image' | 'video'): string | null {
  const isImage = IMAGE_EXT.test(file.name) || /^image\/(jpeg|png|webp)$/.test(file.type);
  const isVideo = VIDEO_EXT.test(file.name) || file.type.startsWith('video/');
  if (kind === 'image' && !isImage) return 'Selecione imagens JPG, PNG ou WebP.';
  if (kind === 'video' && !isVideo) return 'Selecione arquivos de vídeo (MP4/H.264 recomendado).';
  if (!isImage && !isVideo) return 'Formato não suportado. Use JPG, PNG, WebP, MP4 ou WebM.';
  if (config && file.size > config.maxBytes) return `Arquivo acima do limite de ${Math.round(config.maxBytes / 1024 / 1024)} MB.`;
  if (file.size === 0) return 'Arquivo vazio.';
  return null;
}

export async function loadUploadConfig() {
  config ??= await api('/api/uploads/config');
  return config!;
}

export function enqueueFiles(files: File[], kind?: 'image' | 'video') {
  const rejected: Array<{ name: string; error: string }> = [];
  for (const file of files) {
    const err = validateFile(file, kind);
    if (err) {
      rejected.push({ name: file.name, error: err });
      continue;
    }
    tasks.unshift({ key: crypto.randomUUID(), file, name: file.name, size: file.size, sent: 0, status: 'queued', error: null, uploadId: null, mediaId: null, xhr: null, cancelled: false });
  }
  notify();
  pump();
  return rejected;
}

export function cancelUpload(key: string) {
  const t = tasks.find((x) => x.key === key);
  if (!t || !['queued', 'uploading'].includes(t.status)) return;
  t.cancelled = true;
  t.xhr?.abort();
  t.status = 'cancelled';
  if (t.uploadId) void api(`/api/uploads/${t.uploadId}`, { method: 'DELETE' }).catch(() => {});
  notify();
  pump();
}

export function retryUpload(key: string) {
  const t = tasks.find((x) => x.key === key);
  if (!t || t.status !== 'error') return;
  t.status = 'queued';
  t.error = null;
  t.cancelled = false;
  notify();
  pump();
}

export function clearFinished() {
  for (let i = tasks.length - 1; i >= 0; i--) if (['done', 'cancelled', 'error'].includes(tasks[i]!.status)) tasks.splice(i, 1);
  notify();
}

/** Atualiza tarefas em processamento quando o servidor avisa que a mídia ficou pronta */
export function markProcessed(mediaId: string, ok: boolean, error?: string) {
  const t = tasks.find((x) => x.mediaId === mediaId);
  if (!t) return;
  t.status = ok ? 'done' : 'error';
  t.error = ok ? null : (error ?? 'Falha no processamento');
  notify();
}

export function useUploads() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export function hasActiveUploads() {
  return tasks.some((t) => ['queued', 'uploading', 'finishing'].includes(t.status));
}

function pump() {
  const active = tasks.filter((t) => t.status === 'uploading' || t.status === 'finishing').length;
  const next = [...tasks].reverse().filter((t) => t.status === 'queued').slice(0, Math.max(0, MAX_PARALLEL - active));
  for (const t of next) void run(t);
}

function putChunk(t: UploadTask, offset: number, blob: Blob, base: number): Promise<{ receivedBytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('PUT', `/api/uploads/${t.uploadId}/chunk?offset=${offset}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-gd-csrf', '1');
    xhr.upload.onprogress = (e) => {
      t.sent = base + e.loaded;
      notify();
    };
    xhr.onload = () => {
      t.xhr = null;
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* sem corpo */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiError(xhr.status, body?.error ?? 'ERROR', body?.message ?? `Erro ${xhr.status}`, body?.details));
    };
    xhr.onerror = () => {
      t.xhr = null;
      reject(new ApiError(0, 'NETWORK', 'Falha de rede'));
    };
    xhr.onabort = () => {
      t.xhr = null;
      reject(new ApiError(0, 'ABORTED', 'Cancelado'));
    };
    xhr.send(blob);
  });
}

async function run(t: UploadTask) {
  t.status = 'uploading';
  t.error = null;
  notify();
  try {
    const cfg = await loadUploadConfig();
    if (!t.uploadId) {
      const init = await api<{ uploadId: string; chunkBytes: number }>('/api/uploads', { body: { filename: t.name, size: t.size, mimeType: t.file.type || undefined } });
      t.uploadId = init.uploadId;
    }
    let offset = (await api<{ receivedBytes: number }>(`/api/uploads/${t.uploadId}`)).receivedBytes;
    let failures = 0;
    while (offset < t.size) {
      if (t.cancelled) return;
      const end = Math.min(offset + cfg.chunkBytes, t.size);
      try {
        const r = await putChunk(t, offset, t.file.slice(offset, end), offset);
        offset = r.receivedBytes;
        t.sent = offset;
        failures = 0;
        notify();
      } catch (err) {
        if (t.cancelled) return;
        const e = err as ApiError;
        if (e.code === 'OFFSET_MISMATCH' && typeof e.details?.receivedBytes === 'number') {
          offset = e.details.receivedBytes;
          continue;
        }
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && e.code !== 'CHUNK_IN_PROGRESS') throw err;
        failures++;
        if (failures > 6) throw new ApiError(0, 'NETWORK', 'Conexão instável: envio interrompido. Clique em "Tentar novamente" para retomar.');
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** failures)));
        offset = (await api<{ receivedBytes: number }>(`/api/uploads/${t.uploadId}`)).receivedBytes;
      }
    }
    t.status = 'finishing';
    notify();
    const done = await api<{ media: { id: string; status: string } }>(`/api/uploads/${t.uploadId}/complete`, { method: 'POST', body: {} });
    t.mediaId = done.media.id;
    t.status = done.media.status === 'ready' ? 'done' : 'processing';
    void queryClient.invalidateQueries({ queryKey: ['media'] });
  } catch (err) {
    if (t.cancelled) return;
    t.status = 'error';
    t.error = err instanceof Error ? err.message : 'Falha no envio';
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) t.uploadId = null; // recomeça do zero ao tentar novamente
  } finally {
    notify();
    pump();
  }
}

window.addEventListener('beforeunload', (e) => {
  if (hasActiveUploads()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
