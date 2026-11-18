import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { FitMode } from '../../shared/types';
import { formatDuration } from '../lib/format';
import { cn } from './ui';

export interface PreviewItem {
  key: string;
  mediaId: string;
  type: 'image' | 'video';
  name: string;
  durationMs: number;
}

/**
 * Prévia 16:9 da programação, executada apenas neste navegador
 * (não interfere no telão físico). Usa as versões otimizadas para imagens.
 */
export function PreviewPlayer({ items, fit = 'contain', loop = true, autoPlay = true, className, startIndex = 0 }: { items: PreviewItem[]; fit?: FitMode; loop?: boolean; autoPlay?: boolean; className?: string; startIndex?: number }) {
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, items.length - 1)));
  const [playing, setPlaying] = useState(autoPlay);
  const [muted, setMuted] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const startRef = useRef(performance.now());
  const elapsedBefore = useRef(0);
  const item = items[index];

  const next = useCallback(() => {
    setElapsed(0);
    elapsedBefore.current = 0;
    startRef.current = performance.now();
    setIndex((i) => (i + 1 < items.length ? i + 1 : loop ? 0 : i));
  }, [items.length, loop]);
  const prev = () => {
    setElapsed(0);
    elapsedBefore.current = 0;
    startRef.current = performance.now();
    setIndex((i) => (i - 1 + items.length) % items.length);
  };

  useEffect(() => {
    if (index >= items.length) setIndex(0);
  }, [items.length, index]);

  // temporizador das imagens
  useEffect(() => {
    if (!item || item.type !== 'image' || !playing) return;
    startRef.current = performance.now();
    const t = setInterval(() => {
      const e = elapsedBefore.current + performance.now() - startRef.current;
      setElapsed(e);
      if (e >= item.durationMs) next();
    }, 200);
    return () => {
      elapsedBefore.current += performance.now() - startRef.current;
      clearInterval(t);
    };
  }, [item, playing, next]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || item?.type !== 'video') return;
    if (playing) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, item]);

  if (!item)
    return (
      <div className={cn('grid aspect-video w-full place-items-center rounded-xl bg-ink-900 text-sm text-ink-400', className)}>
        Nenhum conteúdo para pré-visualizar
      </div>
    );

  const duration = item.type === 'video' ? (videoRef.current?.duration ? videoRef.current.duration * 1000 : item.durationMs) : item.durationMs;
  return (
    <div className={cn('group relative aspect-video w-full overflow-hidden rounded-xl bg-black', className)}>
      {item.type === 'image' ? (
        <img key={item.key} src={`/api/media/${item.mediaId}/preview`} alt={item.name} className="absolute inset-0 h-full w-full animate-fade-in" style={{ objectFit: fit }} />
      ) : (
        <video
          key={item.key}
          ref={videoRef}
          src={`/api/media/${item.mediaId}/file`}
          className="absolute inset-0 h-full w-full animate-fade-in"
          style={{ objectFit: fit }}
          muted={muted}
          playsInline
          autoPlay={playing}
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime * 1000)}
          onEnded={next}
          onError={next}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pt-8 pb-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <div className="mb-2 h-1 overflow-hidden rounded-full bg-white/25">
          <div className="h-full bg-white" style={{ width: `${duration ? Math.min(100, (elapsed / duration) * 100) : 0}%` }} />
        </div>
        <div className="flex items-center gap-1 text-white">
          <button className="rounded p-1.5 hover:bg-white/15" onClick={prev} aria-label="Anterior">
            <SkipBack className="size-4" />
          </button>
          <button className="rounded p-1.5 hover:bg-white/15" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pausar prévia' : 'Reproduzir prévia'}>
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <button className="rounded p-1.5 hover:bg-white/15" onClick={next} aria-label="Próximo">
            <SkipForward className="size-4" />
          </button>
          {item.type === 'video' && (
            <button className="rounded p-1.5 hover:bg-white/15" onClick={() => setMuted((m) => !m)} aria-label="Áudio da prévia">
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
          )}
          <span className="ml-2 min-w-0 flex-1 truncate text-xs">
            {index + 1}/{items.length} · {item.name}
          </span>
          <span className="tabular text-xs text-white/80">
            {formatDuration(elapsed)} / {formatDuration(duration)}
          </span>
        </div>
      </div>
      <span className="absolute top-2 left-2 rounded bg-black/55 px-2 py-0.5 text-[10.5px] font-medium tracking-wide text-white/90 uppercase">Prévia</span>
    </div>
  );
}

/** Converte um snapshot de versão para itens de prévia */
export function snapshotToPreview(items: Array<{ itemId: string; mediaId: string; type: 'image' | 'video'; name: string; durationMs: number }>): PreviewItem[] {
  return items.map((i) => ({ key: i.itemId, mediaId: i.mediaId, type: i.type, name: i.name, durationMs: i.durationMs }));
}
