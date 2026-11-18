import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { fileTypeFromFile } from 'file-type';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { StorageDriver } from '../storage/storage.js';
import { ACCEPTED_IMAGE_MIME, ACCEPTED_VIDEO_MIME, TRANSCODABLE_VIDEO_MIME } from '../../shared/types.js';

const require = createRequire(import.meta.url);

export function resolveBinaries(cfg: AppConfig) {
  let ffmpeg = cfg.FFMPEG_PATH || null;
  let ffprobe = cfg.FFPROBE_PATH || null;
  try {
    ffmpeg ??= require('ffmpeg-static') as string;
  } catch {
    /* sem ffmpeg-static */
  }
  try {
    ffprobe ??= (require('ffprobe-static') as { path: string }).path;
  } catch {
    /* sem ffprobe-static */
  }
  if (ffmpeg && !fs.existsSync(ffmpeg)) ffmpeg = null;
  if (ffprobe && !fs.existsSync(ffprobe)) ffprobe = null;
  return { ffmpeg, ffprobe };
}

export interface Detected {
  kind: 'image' | 'video';
  mime: string;
  ext: string;
  transcodable: boolean;
}

/** Valida o conteúdo real do arquivo (assinatura binária), independente da extensão */
export async function detectFile(filePath: string): Promise<Detected | null> {
  const ft = await fileTypeFromFile(filePath);
  if (!ft) return null;
  if ((ACCEPTED_IMAGE_MIME as readonly string[]).includes(ft.mime)) return { kind: 'image', mime: ft.mime, ext: ft.ext === 'jpg' ? 'jpg' : ft.ext, transcodable: false };
  if ((ACCEPTED_VIDEO_MIME as readonly string[]).includes(ft.mime)) return { kind: 'video', mime: ft.mime, ext: ft.ext, transcodable: false };
  if ((TRANSCODABLE_VIDEO_MIME as readonly string[]).includes(ft.mime)) return { kind: 'video', mime: ft.mime, ext: ft.ext, transcodable: true };
  return null;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Tempo limite excedido (${path.basename(bin)})`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} falhou (código ${code}): ${err.split('\n').slice(-4).join(' ').trim()}`));
    });
  });
}

export async function sha256File(filePath: string) {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

interface ProbeResult {
  durationMs: number;
  width: number | null;
  height: number | null;
  videoCodec: string;
  audioCodec: string | null;
  formatName: string;
}

async function probe(ffprobe: string, filePath: string): Promise<ProbeResult> {
  const json = JSON.parse(
    await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], 120_000),
  ) as { format?: { duration?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && (s.disposition as { attached_pic?: number })?.attached_pic !== 1);
  if (!v) throw new Error('O arquivo não possui uma faixa de vídeo válida.');
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(json.format?.duration ?? v.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Não foi possível determinar a duração do vídeo.');
  let width = Number(v.width) || null;
  let height = Number(v.height) || null;
  const sideRot = (v.side_data_list as Array<{ rotation?: number }> | undefined)?.find((s) => s.rotation !== undefined)?.rotation;
  const rotate = Math.abs(Number((v.tags as { rotate?: string })?.rotate ?? sideRot ?? 0));
  if (rotate === 90 || rotate === 270) [width, height] = [height, width];
  return {
    durationMs: Math.round(duration * 1000),
    width,
    height,
    videoCodec: String(v.codec_name ?? 'desconhecido'),
    audioCodec: a ? String(a.codec_name) : null,
    formatName: String(json.format?.format_name ?? ''),
  };
}

const BROWSER_CODECS: Record<string, string[]> = {
  'video/mp4': ['h264', 'av1'],
  'video/webm': ['vp8', 'vp9', 'av1'],
};

export interface ProcessJob {
  mediaId: string;
  sourcePath: string;
  userId: string | null;
}

export interface ProcessorHooks {
  onDone(mediaId: string, ok: boolean, error?: string): void | Promise<void>;
}

export class MediaProcessor {
  private queue: ProcessJob[] = [];
  private running = false;
  readonly bins: { ffmpeg: string | null; ffprobe: string | null };
  readonly processingDir: string;
  readonly workDir: string;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private cfg: AppConfig,
    private db: Db,
    private storage: StorageDriver,
    private log: FastifyBaseLogger,
    private hooks: ProcessorHooks,
  ) {
    this.bins = resolveBinaries(cfg);
    this.processingDir = path.join(cfg.storageDir, 'tmp', 'processing');
    this.workDir = path.join(cfg.storageDir, 'tmp', 'work');
    fs.mkdirSync(this.processingDir, { recursive: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    if (!this.bins.ffmpeg || !this.bins.ffprobe) {
      log.warn('ffmpeg/ffprobe indisponível: vídeos não poderão ser processados (miniaturas, duração e conversão).');
    }
  }

  sourcePathFor(mediaId: string) {
    return path.join(this.processingDir, `${mediaId}.src`);
  }

  enqueue(job: ProcessJob) {
    this.queue.push(job);
    void this.pump();
  }

  /** Aguarda a fila esvaziar (usado em testes) */
  whenIdle() {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /** Retoma processamentos interrompidos por reinício do servidor */
  async recover() {
    const pending = await this.db.media.findMany({ where: { status: 'PROCESSING' } });
    for (const m of pending) {
      const src = this.sourcePathFor(m.id);
      if (fs.existsSync(src)) this.enqueue({ mediaId: m.id, sourcePath: src, userId: m.uploadedById });
      else
        await this.db.media.update({
          where: { id: m.id },
          data: { status: 'FAILED', error: 'Processamento interrompido. Envie o arquivo novamente.' },
        });
    }
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          await this.process(job);
          await this.hooks.onDone(job.mediaId, true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn({ err, mediaId: job.mediaId }, 'falha no processamento de mídia');
          await this.db.media
            .update({ where: { id: job.mediaId }, data: { status: 'FAILED', error: message.slice(0, 500) } })
            .catch(() => {});
          await this.hooks.onDone(job.mediaId, false, message);
        } finally {
          await fsp.rm(job.sourcePath, { force: true }).catch(() => {});
          await fsp.rm(path.join(this.workDir, job.mediaId), { recursive: true, force: true }).catch(() => {});
        }
      }
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((r) => r());
    }
  }

  private async process(job: ProcessJob) {
    const detected = await detectFile(job.sourcePath);
    if (!detected) throw new Error('Formato não suportado. Envie JPG, PNG, WebP, MP4 (H.264) ou WebM.');
    const work = path.join(this.workDir, job.mediaId);
    await fsp.mkdir(work, { recursive: true });
    const base = `media/${job.mediaId}`;
    if (detected.kind === 'image') return this.processImage(job, detected, work, base);
    return this.processVideo(job, detected, work, base);
  }

  private async processImage(job: ProcessJob, d: Detected, work: string, base: string) {
    const meta = await sharp(job.sourcePath, { failOn: 'error' }).metadata();
    if (!meta.width || !meta.height) throw new Error('Imagem inválida ou corrompida.');
    const swapped = (meta.orientation ?? 1) >= 5;
    const width = swapped ? meta.height : meta.width;
    const height = swapped ? meta.width : meta.height;
    const thumb = path.join(work, 'thumb.webp');
    const preview = path.join(work, 'preview.webp');
    // decodifica a imagem inteira (valida integridade) ao gerar as versões otimizadas
    await sharp(job.sourcePath, { failOn: 'error' }).rotate().resize({ width: 480, height: 270, fit: 'cover' }).webp({ quality: 78 }).toFile(thumb);
    await sharp(job.sourcePath).rotate().resize({ width: 1600, height: 900, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(preview);
    const size = (await fsp.stat(job.sourcePath)).size;
    const checksum = await sha256File(job.sourcePath);
    const key = `${base}/original.${d.ext}`;
    await this.storage.putFile(`${base}/thumb.webp`, thumb, 'image/webp');
    await this.storage.putFile(`${base}/preview.webp`, preview, 'image/webp');
    await this.storage.putFile(key, job.sourcePath, d.mime);
    await this.db.media.update({
      where: { id: job.mediaId },
      data: {
        type: 'IMAGE',
        status: 'READY',
        mimeType: d.mime,
        sizeBytes: BigInt(size),
        originalSize: BigInt(size),
        width,
        height,
        checksum,
        storageKey: key,
        originalKey: key,
        thumbnailKey: `${base}/thumb.webp`,
        previewKey: `${base}/preview.webp`,
        error: null,
      },
    });
  }

  private async processVideo(job: ProcessJob, d: Detected, work: string, base: string) {
    const { ffmpeg, ffprobe } = this.bins;
    if (!ffmpeg || !ffprobe) throw new Error('ffmpeg/ffprobe não está disponível no servidor para validar vídeos.');
    const info = await probe(ffprobe, job.sourcePath);
    const compatible = !d.transcodable && (BROWSER_CODECS[d.mime] ?? []).includes(info.videoCodec);
    let playbackPath = job.sourcePath;
    let playbackMime = d.mime;
    let playbackExt = d.ext;
    let finalInfo = info;
    const originalSize = (await fsp.stat(job.sourcePath)).size;

    if (!compatible) {
      // Converte para MP4/H.264 (compatível com qualquer navegador). O original é preservado.
      const out = path.join(work, 'playback.mp4');
      const timeout = Math.max(10 * 60_000, info.durationMs * 6);
      await run(
        ffmpeg,
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', job.sourcePath, '-map', '0:v:0', '-map', '0:a:0?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out],
        timeout,
      );
      playbackPath = out;
      playbackMime = 'video/mp4';
      playbackExt = 'mp4';
      finalInfo = await probe(ffprobe, out);
    }

    // Miniatura: quadro em ~10% da duração (máx. 3s)
    const frame = path.join(work, 'frame.png');
    const at = Math.min(3, (finalInfo.durationMs / 1000) * 0.1).toFixed(2);
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at, '-i', playbackPath, '-frames:v', '1', '-vf', 'scale=960:-2', frame], 120_000);
    const thumb = path.join(work, 'thumb.webp');
    const preview = path.join(work, 'preview.webp');
    await sharp(frame).resize({ width: 480, height: 270, fit: 'cover' }).webp({ quality: 78 }).toFile(thumb);
    await sharp(frame).webp({ quality: 80 }).toFile(preview);

    const size = (await fsp.stat(playbackPath)).size;
    const checksum = await sha256File(playbackPath);
    const playbackKey = `${base}/playback.${playbackExt}`;
    let originalKey = playbackKey;
    if (!compatible) {
      originalKey = `${base}/original.${d.ext}`;
      await this.storage.putFile(originalKey, job.sourcePath, d.mime);
    }
    await this.storage.putFile(`${base}/thumb.webp`, thumb, 'image/webp');
    await this.storage.putFile(`${base}/preview.webp`, preview, 'image/webp');
    await this.storage.putFile(playbackKey, playbackPath, playbackMime);

    await this.db.media.update({
      where: { id: job.mediaId },
      data: {
        type: 'VIDEO',
        status: 'READY',
        mimeType: playbackMime,
        sizeBytes: BigInt(size),
        originalSize: BigInt(originalSize),
        durationMs: finalInfo.durationMs,
        width: finalInfo.width,
        height: finalInfo.height,
        videoCodec: finalInfo.videoCodec,
        checksum,
        storageKey: playbackKey,
        originalKey,
        thumbnailKey: `${base}/thumb.webp`,
        previewKey: `${base}/preview.webp`,
        transcoded: !compatible,
        error: null,
      },
    });
  }
}
