import { useSyncExternalStore } from 'react';
import { api, ApiError, queryClient } from './api';
import { probeFile, sha256File, type ProbeResult } from './media-probe';

/**
 * Gerenciador de uploads em partes (retomáveis), direto ao Cloudflare R2.
 *
 * 1. O navegador analisa o arquivo (metadados, miniatura e SHA-256).
 * 2. O Worker cria um upload multipart no R2 e devolve, para cada parte, uma URL temporária assinada.
 * 3. Cada parte vai do navegador direto para o R2 (o arquivo não passa pelo Worker).
 * 4. O Worker conclui o multipart, confere o objeto e só então cadastra a mídia.
 * Falhas de rede são repetidas a partir da última parte confirmada.
 */
export type UploadStatus = 'queued' | 'preparing' | 'uploading' | 'finishing' | 'processing' | 'done' | 'error' | 'cancelled';

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
  /** progresso da análise (0–100) */
  prepPct: number;
  probe: (ProbeResult & { checksum: string }) | null;
}

const tasks: UploadTask[] = [];
const listeners = new Set<() => void>();
let snapshot: UploadTask[] = [];
const notify = () => {
  snapshot = tasks.map((t) => ({ ...t }));
  listeners.forEach((l) => l());
};
const MAX_PARALLEL = 2;
let config: { chunkBytes: number; maxBytes: number; ffmpeg: boolean; direct: boolean; storage?: { usedBytes: number; limitBytes: number; warn: boolean } } | null = null;

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm)$/i;
const CONVERTIBLE_EXT = /\.(mov|mkv|avi|mpe?g|ts)$/i;

const kindOf = (file: File): 'image' | 'video' | null =>
  IMAGE_EXT.test(file.name) || /^image\/(jpeg|png|webp)$/.test(file.type) ? 'image' : VIDEO_EXT.test(file.name) || /^video\/(mp4|webm)$/.test(file.type) ? 'video' : null;

export function validateFile(file: File, kind?: 'image' | 'video'): string | null {
  const k = kindOf(file);
  if (CONVERTIBLE_EXT.test(file.name)) return 'Este formato precisa ser convertido para MP4 (H.264) antes do envio.';
  if (kind === 'image' && k !== 'image') return 'Selecione imagens JPG, PNG ou WebP.';
  if (kind === 'video' && k !== 'video') return 'Selecione arquivos de vídeo (MP4/H.264 recomendado).';
  if (!k) return 'Formato não suportado. Use JPG, PNG, WebP, MP4 ou WebM.';
  if (config && file.size > config.maxBytes) return `Arquivo acima do limite de ${Math.round(config.maxBytes / 1024 / 1024)} MB.`;
  if (file.size === 0) return 'Arquivo vazio.';
  return null;
}

export async function loadUploadConfig(force = false) {
  if (!config || force) config = await api('/api/uploads/config');
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
    tasks.unshift({ key: crypto.randomUUID(), file, name: file.name, size: file.size, sent: 0, status: 'queued', error: null, uploadId: null, mediaId: null, xhr: null, cancelled: false, prepPct: 0, probe: null });
  }
  notify();
  pump();
  return rejected;
}

export function cancelUpload(key: string) {
  const t = tasks.find((x) => x.key === key);
  if (!t || !['queued', 'preparing', 'uploading'].includes(t.status)) return;
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
  if (!t || t.status === 'done') return;
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
  return tasks.some((t) => ['queued', 'preparing', 'uploading', 'finishing'].includes(t.status));
}

function pump() {
  const active = tasks.filter((t) => t.status === 'preparing' || t.status === 'uploading' || t.status === 'finishing').length;
  const next = [...tasks].reverse().filter((t) => t.status === 'queued').slice(0, Math.max(0, MAX_PARALLEL - active));
  for (const t of next) void run(t);
}

/** PUT de uma parte com progresso. Direto ao R2: devolve a ETag; pelo Worker: devolve o JSON da API. */
function putPart(t: UploadTask, url: string, blob: Blob, base: number, proxy: boolean): Promise<{ etag?: string; receivedBytes?: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    t.xhr = xhr;
    xhr.open('PUT', url);
    if (proxy) {
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-gd-csrf', '1');
    }
    xhr.upload.onprogress = (e) => {
      t.sent = base + e.loaded;
      notify();
    };
    xhr.onload = () => {
      t.xhr = null;
      if (proxy) {
        let body: any = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* sem corpo */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(xhr.status, body?.error ?? 'ERROR', body?.message ?? `Erro ${xhr.status}`, body?.details));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) reject(new ApiError(0, 'CORS', 'O R2 não informou a ETag da parte. Verifique o CORS do bucket (ExposeHeaders: ETag).'));
        else resolve({ etag });
      } else reject(new ApiError(xhr.status >= 500 ? xhr.status : 0, 'R2', `Falha ao enviar ao armazenamento (HTTP ${xhr.status}).`));
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

async function uploadDerivative(uploadId: string, kind: 'thumbnail' | 'preview', blob: Blob | null) {
  if (!blob) return;
  const res = await fetch(`/api/uploads/${uploadId}/derivative/${kind}`, { method: 'PUT', body: blob, credentials: 'same-origin', headers: { 'x-gd-csrf': '1', 'content-type': blob.type } });
  if (!res.ok) throw new ApiError(res.status, 'DERIVATIVE', 'Falha ao enviar a miniatura.');
}

async function run(t: UploadTask) {
  t.status = 'preparing';
  t.error = null;
  notify();
  try {
    await loadUploadConfig();
    // 1) análise local (uma vez por arquivo; reaproveitada ao tentar novamente)
    if (!t.probe) {
      const kind = kindOf(t.file)!;
      const probe = await probeFile(t.file, kind);
      const checksum = await sha256File(
        t.file,
        (done) => {
          t.prepPct = Math.floor((done / t.size) * 100);
          notify();
        },
        () => t.cancelled,
      );
      t.probe = { ...probe, checksum };
    }
    if (t.cancelled) return;
    t.status = 'uploading';
    notify();

    // 2) cria o upload multipart (o servidor recusa duplicados e o limite de armazenamento)
    if (!t.uploadId) {
      const init = await api<{ uploadId: string; chunkBytes: number }>('/api/uploads', {
        body: { filename: t.name, size: t.size, mimeType: t.file.type || undefined, checksum: t.probe.checksum },
      });
      t.uploadId = init.uploadId;
      await uploadDerivative(t.uploadId, 'thumbnail', t.probe.thumbnail).catch(() => {});
      await uploadDerivative(t.uploadId, 'preview', t.probe.preview).catch(() => {});
    }
    const info = await api<{ receivedBytes: number; chunkBytes: number }>(`/api/uploads/${t.uploadId}`);
    const chunk = info.chunkBytes;
    let offset = info.receivedBytes;
    let failures = 0;

    // 3) partes (sequenciais) direto ao R2
    while (offset < t.size) {
      if (t.cancelled) return;
      const part = Math.floor(offset / chunk) + 1;
      const start = (part - 1) * chunk;
      const end = Math.min(start + chunk, t.size);
      try {
        const target = await api<{ proxy: boolean; url: string }>(`/api/uploads/${t.uploadId}/parts/${part}/url`, { method: 'POST', body: {} });
        const r = await putPart(t, target.url, t.file.slice(start, end), start, target.proxy);
        const confirmed = target.proxy ? r : await api<{ receivedBytes: number }>(`/api/uploads/${t.uploadId}/parts/${part}`, { body: { etag: r.etag } });
        offset = confirmed.receivedBytes ?? end;
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
        if (e.code === 'CORS') throw err;
        if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw err;
        failures++;
        if (failures > 6) throw new ApiError(0, 'NETWORK', 'Conexão instável: envio interrompido. Clique em "Tentar novamente" para retomar.');
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** failures)));
        offset = (await api<{ receivedBytes: number }>(`/api/uploads/${t.uploadId}`)).receivedBytes;
      }
    }

    // 4) conclusão: o servidor confere o objeto no R2 antes de cadastrar a mídia
    t.status = 'finishing';
    notify();
    const p = t.probe;
    const done = await api<{ media: { id: string; status: string } }>(`/api/uploads/${t.uploadId}/complete`, {
      method: 'POST',
      body: { width: p.width, height: p.height, durationMs: p.durationMs, videoCodec: p.videoCodec, checksum: p.checksum },
    });
    t.mediaId = done.media.id;
    t.status = done.media.status === 'ready' ? 'done' : 'processing';
    void queryClient.invalidateQueries({ queryKey: ['media'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void loadUploadConfig(true).catch(() => {});
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
