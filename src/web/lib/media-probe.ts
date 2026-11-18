/**
 * Análise das mídias no navegador do administrador, antes do envio.
 * Substitui o FFprobe/FFmpeg/Sharp do servidor da versão 1 (o Cloudflare Workers não executa binários):
 *  - valida que o arquivo é decodificável (imagem íntegra / vídeo reproduzível no navegador);
 *  - extrai largura, altura, duração e codec;
 *  - gera a miniatura (480×270) e a prévia (até 1600×900 / quadro do vídeo);
 *  - calcula o SHA-256 (usado pelo telão para verificar a integridade e para evitar uploads duplicados).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface ProbeResult {
  kind: 'image' | 'video';
  width: number;
  height: number;
  durationMs: number | null;
  videoCodec: string | null;
  thumbnail: Blob | null;
  preview: Blob | null;
}

const VIDEO_MSG = 'O navegador não conseguiu ler este vídeo. Envie MP4 (H.264) ou WebM.';

async function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality));
  if (webp && webp.type === 'image/webp') return webp;
  return new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
}

function draw(src: CanvasImageSource, sw: number, sh: number, w: number, h: number, mode: 'cover' | 'inside') {
  const canvas = document.createElement('canvas');
  let dw = w;
  let dh = h;
  let sx = 0;
  let sy = 0;
  let cw = sw;
  let ch = sh;
  if (mode === 'cover') {
    const scale = Math.max(w / sw, h / sh);
    cw = w / scale;
    ch = h / scale;
    sx = (sw - cw) / 2;
    sy = (sh - ch) / 2;
  } else {
    const scale = Math.min(1, w / sw, h / sh);
    dw = Math.max(1, Math.round(sw * scale));
    dh = Math.max(1, Math.round(sh * scale));
  }
  canvas.width = dw;
  canvas.height = dh;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, cw, ch, 0, 0, dw, dh);
  return canvas;
}

async function probeImage(file: File): Promise<ProbeResult> {
  let bmp: ImageBitmap;
  try {
    // respeita a orientação EXIF, como o .rotate() do Sharp
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Imagem inválida ou corrompida.');
  }
  try {
    const thumb = await toBlob(draw(bmp, bmp.width, bmp.height, 480, 270, 'cover'), 0.78);
    const preview = await toBlob(draw(bmp, bmp.width, bmp.height, 1600, 900, 'inside'), 0.82);
    return { kind: 'image', width: bmp.width, height: bmp.height, durationMs: null, videoCodec: null, thumbnail: thumb, preview };
  } finally {
    bmp.close();
  }
}

function once(el: HTMLMediaElement, ok: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => done(new Error(VIDEO_MSG)), timeoutMs);
    const onOk = () => done();
    const onErr = () => done(new Error(VIDEO_MSG));
    function done(err?: Error) {
      clearTimeout(t);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
      if (err) reject(err);
      else resolve();
    }
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

/** Identifica o codec de vídeo lendo a estrutura do MP4 (caixa moov) ou o cabeçalho do WebM */
export async function detectVideoCodec(file: File): Promise<string | null> {
  const find = (bytes: Uint8Array) => {
    const text = new TextDecoder('latin1').decode(bytes);
    const table: Array<[string, string]> = [
      ['avc1', 'h264'],
      ['avc3', 'h264'],
      ['hvc1', 'hevc'],
      ['hev1', 'hevc'],
      ['av01', 'av1'],
      ['vp09', 'vp9'],
      ['mp4v', 'mpeg4'],
      ['V_VP9', 'vp9'],
      ['V_VP8', 'vp8'],
      ['V_AV1', 'av1'],
      ['V_MPEG4/ISO/AVC', 'h264'],
      ['V_MPEGH/ISO/HEVC', 'hevc'],
    ];
    let best: { at: number; codec: string } | null = null;
    for (const [tag, codec] of table) {
      const at = text.indexOf(tag);
      if (at >= 0 && (!best || at < best.at)) best = { at, codec };
    }
    return best?.codec ?? null;
  };
  try {
    if (/\.webm$/i.test(file.name) || file.type === 'video/webm') return find(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()));
    // percorre as caixas de primeiro nível até a "moov" (pode estar no início ou no fim do arquivo)
    let offset = 0;
    for (let i = 0; i < 64 && offset + 8 <= file.size; i++) {
      const h = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
      let size = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (size === 1 && h.byteLength >= 16) size = Number(h.getBigUint64(8));
      else if (size === 0) size = file.size - offset;
      if (size < 8) break;
      if (type === 'moov') return find(new Uint8Array(await file.slice(offset, offset + Math.min(size, 64 * 1024 * 1024)).arrayBuffer()));
      offset += size;
    }
  } catch {
    /* estrutura não reconhecida */
  }
  return null;
}

async function probeVideo(file: File): Promise<ProbeResult> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  try {
    const meta = once(v, 'loadeddata', 60_000);
    v.src = url;
    await meta;
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Não foi possível determinar a duração do vídeo.');
    if (!v.videoWidth || !v.videoHeight) throw new Error('O arquivo não possui uma faixa de vídeo válida.');
    // Miniatura: quadro em ~10% da duração (máx. 3 s)
    const seek = once(v, 'seeked', 30_000);
    v.currentTime = Math.min(3, duration * 0.1);
    await seek;
    const frame = draw(v, v.videoWidth, v.videoHeight, 960, 2160, 'inside');
    const thumb = await toBlob(draw(frame, frame.width, frame.height, 480, 270, 'cover'), 0.78);
    const preview = await toBlob(frame, 0.8);
    return { kind: 'video', width: v.videoWidth, height: v.videoHeight, durationMs: Math.round(duration * 1000), videoCodec: await detectVideoCodec(file), thumbnail: thumb, preview };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

export async function probeFile(file: File, kind: 'image' | 'video'): Promise<ProbeResult> {
  const r = kind === 'image' ? await probeImage(file) : await probeVideo(file);
  if (r.kind === 'video' && /\.(mp4|m4v)$/i.test(file.name) && r.videoCodec && !['h264', 'av1'].includes(r.videoCodec))
    throw new Error(`O vídeo usa o codec ${r.videoCodec.toUpperCase()}, que não é reproduzido por todos os navegadores. Converta para MP4 (H.264) e envie novamente.`);
  return r;
}

/** SHA-256 do arquivo inteiro, lido em blocos (não carrega o arquivo todo em memória) */
export async function sha256File(file: File, onProgress?: (done: number) => void, isCancelled?: () => boolean): Promise<string> {
  const h = sha256.create();
  const block = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += block) {
    if (isCancelled?.()) throw new Error('Cancelado');
    h.update(new Uint8Array(await file.slice(off, Math.min(off + block, file.size)).arrayBuffer()));
    onProgress?.(Math.min(off + block, file.size));
    await new Promise((r) => setTimeout(r, 0));
  }
  return bytesToHex(h.digest());
}
