import { Film, ImageIcon } from 'lucide-react';
import type { DeviceConnection, PlaybackStatus } from '../../shared/types';
import { Badge, cn } from './ui';
import { formatDuration } from '../lib/format';

export interface MediaItem {
  id: string;
  name: string;
  description: string | null;
  originalFilename: string;
  type: 'image' | 'video';
  status: 'processing' | 'ready' | 'failed';
  mimeType: string;
  sizeBytes: number;
  originalSize: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  transcoded: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  uploadedBy: string | null;
  playlistCount?: number;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  fileUrl: string | null;
}

export function ConnectionBadge({ connection }: { connection: DeviceConnection }) {
  const map = {
    online: { tone: 'green', label: 'Online' },
    reconnecting: { tone: 'amber', label: 'Reconectando' },
    offline: { tone: 'red', label: 'Offline' },
    never: { tone: 'neutral', label: 'Aguardando conexão' },
  } as const;
  const m = map[connection];
  return (
    <Badge tone={m.tone} dot className={cn(connection === 'reconnecting' && '[&>span:first-child]:animate-pulse')}>
      {m.label}
    </Badge>
  );
}

export function PlaybackBadge({ status }: { status: PlaybackStatus | undefined | null }) {
  if (!status) return <Badge>—</Badge>;
  const map = {
    playing: { tone: 'brand', label: 'Reproduzindo' },
    paused: { tone: 'amber', label: 'Pausado' },
    error: { tone: 'red', label: 'Erro' },
    idle: { tone: 'neutral', label: 'Sem conteúdo' },
    starting: { tone: 'neutral', label: 'Iniciando' },
  } as const;
  const m = map[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function MediaThumb({ media, className, showType = true }: { media: Pick<MediaItem, 'thumbnailUrl' | 'type' | 'durationMs' | 'name' | 'status'>; className?: string; showType?: boolean }) {
  return (
    <div className={cn('relative aspect-video overflow-hidden rounded-md bg-ink-100', className)}>
      {media.thumbnailUrl ? (
        <img src={media.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="grid h-full w-full place-items-center text-ink-400 [&_svg]:size-6">{media.type === 'video' ? <Film /> : <ImageIcon />}</div>
      )}
      {showType && media.type === 'video' && media.durationMs ? (
        <span className="tabular absolute right-1 bottom-1 rounded bg-black/70 px-1.5 py-0.5 text-[10.5px] font-medium text-white">{formatDuration(media.durationMs)}</span>
      ) : null}
    </div>
  );
}

export function MediaTypeBadge({ type }: { type: 'image' | 'video' }) {
  return type === 'video' ? (
    <Badge tone="violet">
      <Film /> Vídeo
    </Badge>
  ) : (
    <Badge tone="brand">
      <ImageIcon /> Imagem
    </Badge>
  );
}

export function MediaStatusBadge({ status }: { status: MediaItem['status'] }) {
  if (status === 'ready') return null;
  return status === 'processing' ? <Badge tone="amber">Processando</Badge> : <Badge tone="red">Falhou</Badge>;
}
