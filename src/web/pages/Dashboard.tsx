import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Clock, HardDrive, Images, ListVideo, MonitorPlay, Send, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { formatBytes, formatDateTime, formatDuration, relativeTime } from '../lib/format';
import { useLiveState, useTicker } from '../lib/realtime';
import { Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Progress, Select, StatCard } from '../components/ui';
import { ConnectionBadge, MediaThumb, PlaybackBadge } from '../components/domain';
import { PreviewPlayer, snapshotToPreview } from '../components/PreviewPlayer';
import type { DeviceConnection, PlayerManifest, PlayerStateReport } from '../../shared/types';

interface DashboardData {
  stats: { devicesOnline: number; devicesTotal: number; mediaImages: number; mediaVideos: number; playlists: number; storageBytes: number; storageLimitBytes?: number; storageWarn?: boolean };
  devices: Array<{
    id: string;
    name: string;
    location: string | null;
    connection: DeviceConnection;
    lastSeenAt: string | null;
    effectiveVersion: { id: string; number: number; itemCount: number; playlistId: string; playlistName: string } | null;
    effectiveSource: string | null;
    inSync: boolean;
    state: PlayerStateReport | null;
    stateAt: string | null;
    lastError: string | null;
  }>;
  recentMedia: Array<{ id: string; name: string; type: 'image' | 'video'; status: 'processing' | 'ready' | 'failed'; createdAt: string; uploadedBy: string | null; thumbnailUrl: string | null }>;
  recentPublications: Array<{ id: string; number: number; itemCount: number; publishedAt: string; playlist: { id: string; name: string }; publishedBy: string | null }>;
  recentActivity: Array<{ id: string; action: string; summary: string; createdAt: string; user: string | null; device: string | null }>;
}

export default function Dashboard() {
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/api/dashboard'), refetchInterval: 30_000 });
  const [selected, setSelected] = useState<string | null>(null);
  useTicker(1000);
  if (isLoading || !data) return <Loading />;
  const device = data.devices.find((d) => d.id === selected) ?? data.devices[0];
  const active = data.devices.find((d) => d.effectiveVersion)?.effectiveVersion;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Visão Geral"
        description="Resumo da operação dos telões e das mídias."
        actions={
          <>
            <Link to="/admin/media">
              <Button icon={<Upload />}>Enviar mídias</Button>
            </Link>
            <Link to="/admin/playlists">
              <Button variant="primary" icon={<ListVideo />}>
                Editar programação
              </Button>
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<MonitorPlay />} label="Telões conectados" value={`${data.stats.devicesOnline} de ${data.stats.devicesTotal}`} detail={data.stats.devicesTotal ? 'dispositivos ativos agora' : 'nenhum telão cadastrado'} tone="green" />
        <StatCard icon={<Images />} label="Mídias cadastradas" value={data.stats.mediaImages + data.stats.mediaVideos} detail={`${data.stats.mediaVideos} vídeo(s) · ${data.stats.mediaImages} imagem(ns)`} />
        <StatCard icon={<ListVideo />} label="Playlist ativa" value={active?.playlistName ?? '—'} detail={active ? `${active.itemCount} conteúdo(s) · versão ${active.number}` : 'nada publicado'} tone="violet" />
        <StatCard icon={<HardDrive />} label="Armazenamento" value={formatBytes(data.stats.storageBytes)}
          detail={
            data.stats.storageLimitBytes ? (
              <span className={data.stats.storageWarn ? 'font-medium text-red-600' : undefined}>
                {`${Math.round((data.stats.storageBytes / data.stats.storageLimitBytes) * 100)}% de ${formatBytes(data.stats.storageLimitBytes)}${data.stats.storageWarn ? ' · próximo do limite' : ''}`}
              </span>
            ) : (
              'ocupado pelas mídias'
            )
          }
          tone="amber"
        />
      </div>

      {!device ? (
        <Card>
          <EmptyState
            icon={<MonitorPlay />}
            title="Nenhum telão vinculado"
            description="Abra /player no computador conectado ao telão e vincule-o com o código exibido na tela."
            action={
              <Link to="/admin/devices">
                <Button variant="primary">Vincular telão</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <DeviceMonitor device={device} devices={data.devices} onSelect={setSelected} />
          <DevicePreview deviceId={device.id} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Últimas mídias" actions={<Link to="/admin/media" className="text-xs font-medium text-brand-700 hover:underline">Ver biblioteca</Link>} />
          {data.recentMedia.length ? (
            <ul className="divide-y divide-ink-100">
              {data.recentMedia.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-5 py-2.5">
                  <MediaThumb media={{ ...m, durationMs: null }} className="w-16 shrink-0" showType={false} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-800">{m.name}</p>
                    <p className="text-xs text-ink-500">
                      {m.type === 'video' ? 'Vídeo' : 'Imagem'} · {relativeTime(m.createdAt)}
                      {m.uploadedBy ? ` · ${m.uploadedBy}` : ''}
                    </p>
                  </div>
                  {m.status !== 'ready' && <Badge tone={m.status === 'failed' ? 'red' : 'amber'}>{m.status === 'failed' ? 'Falhou' : 'Processando'}</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-ink-500">Nenhuma mídia enviada.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Últimas publicações" />
          {data.recentPublications.length ? (
            <ul className="divide-y divide-ink-100">
              {data.recentPublications.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                    <Send className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link to={`/admin/playlists/${p.playlist.id}`} className="block truncate text-sm font-medium text-ink-800 hover:text-brand-700">
                      {p.playlist.name} <span className="font-normal text-ink-500">v{p.number}</span>
                    </Link>
                    <p className="text-xs text-ink-500">
                      {p.itemCount} itens · {formatDateTime(p.publishedAt)}
                      {p.publishedBy ? ` · ${p.publishedBy}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-ink-500">Nenhuma publicação ainda.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Atividade recente" actions={<Link to="/admin/history" className="text-xs font-medium text-brand-700 hover:underline">Histórico</Link>} />
          <ul className="divide-y divide-ink-100">
            {data.recentActivity.map((a) => (
              <li key={a.id} className="px-5 py-2.5">
                <p className="text-[13px] text-ink-800">{a.summary}</p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {relativeTime(a.createdAt)}
                  {a.user ? ` · ${a.user}` : a.device ? ` · ${a.device}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function DeviceMonitor({ device, devices, onSelect }: { device: DashboardData['devices'][number]; devices: DashboardData['devices']; onSelect: (id: string) => void }) {
  const live = useLiveState(device.id, device.state, device.stateAt);
  const st = live?.state;
  const sinceReport = live ? Date.now() - live.at : 0;
  const elapsed = st ? Math.min(st.durationMs, st.elapsedMs + (st.status === 'playing' && device.connection === 'online' ? sinceReport : 0)) : 0;
  const remaining = st ? Math.max(0, st.durationMs - elapsed) : 0;
  return (
    <Card>
      <CardHeader
        icon={<MonitorPlay />}
        title={device.name}
        description={device.location ?? 'Monitoramento em tempo real'}
        actions={
          <>
            {devices.length > 1 && (
              <Select value={device.id} onChange={(e) => onSelect(e.target.value)} className="h-8 w-44 text-xs">
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
            <ConnectionBadge connection={device.connection} />
          </>
        }
      />
      <div className="grid gap-5 p-5 sm:grid-cols-[200px_minmax(0,1fr)]">
        <MediaThumb media={{ thumbnailUrl: st?.mediaId ? `/api/media/${st.mediaId}/thumbnail` : null, type: st?.mediaType ?? 'image', durationMs: null, name: st?.mediaName ?? '', status: 'ready' }} className="w-full rounded-lg" showType={false} />
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-500 uppercase">Em reprodução</p>
            <p className="mt-1 truncate text-lg font-semibold text-ink-900">{st?.mediaName ?? (device.effectiveVersion ? 'Aguardando informações do telão' : 'Nenhuma programação publicada')}</p>
          </div>
          {st && st.total > 0 && (
            <div>
              <Progress value={st.durationMs ? (elapsed / st.durationMs) * 100 : 0} />
              <div className="tabular mt-1.5 flex justify-between text-xs text-ink-500">
                <span>
                  Item {st.index + 1} de {st.total} · {formatDuration(elapsed)}
                </span>
                <span>-{formatDuration(remaining)}</span>
              </div>
            </div>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-ink-500">Estado</dt>
            <dd>{device.connection === 'online' ? <PlaybackBadge status={st?.status} /> : <span className="text-ink-500">sem sinal</span>}</dd>
            <dt className="text-ink-500">Playlist ativa</dt>
            <dd className="truncate font-medium text-ink-800">
              {device.effectiveVersion ? `${device.effectiveVersion.playlistName} (v${device.effectiveVersion.number})` : '—'}
              {device.effectiveSource?.startsWith('schedule:') && <Badge tone="violet" className="ml-1.5">agendada</Badge>}
            </dd>
            <dt className="text-ink-500">Conteúdos</dt>
            <dd className="text-ink-800">{device.effectiveVersion?.itemCount ?? 0}</dd>
            <dt className="text-ink-500">Última comunicação</dt>
            <dd className="flex items-center gap-1 text-ink-800">
              <Clock className="size-3.5 text-ink-400" /> {device.connection === 'online' ? 'agora' : relativeTime(device.lastSeenAt)}
            </dd>
          </dl>
          {!device.inSync && device.effectiveVersion && device.connection === 'online' && (
            <p className="text-xs text-amber-700">{st?.preparing ? `Preparando nova versão: ${st.preparing.doneItems}/${st.preparing.totalItems} arquivos…` : 'Sincronizando a versão mais recente…'}</p>
          )}
          {st?.prepareError && <p className="text-xs text-red-700">{st.prepareError}</p>}
          <Link to={`/admin/devices/${device.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline">
            Abrir controle remoto <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </Card>
  );
}

function DevicePreview({ deviceId }: { deviceId: string }) {
  const { data } = useQuery({ queryKey: ['device', deviceId, 'manifest'], queryFn: () => api<{ manifest: PlayerManifest }>(`/api/devices/${deviceId}/manifest`) });
  const v = data?.manifest.version;
  return (
    <Card>
      <CardHeader title="Prévia da programação" description="Reproduz aqui, sem interferir no telão físico." />
      <div className="p-5">
        <PreviewPlayer key={v?.versionId ?? 'none'} items={v ? snapshotToPreview(v.items) : []} fit={data?.manifest.overrides.fitMode ?? v?.settings.fitMode} loop autoPlay={false} />
      </div>
    </Card>
  );
}
