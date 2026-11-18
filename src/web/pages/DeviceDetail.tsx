import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, HardDrive, Monitor, Pause, Play, RefreshCw, RotateCcw, ShieldCheck, SkipBack, SkipForward, Trash, Unlink, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes, formatDate, formatDateTime, formatDuration, relativeTime } from '../lib/format';
import { useLiveState, useTicker } from '../lib/realtime';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Progress, Segmented, Switch, cn, useConfirm } from '../components/ui';
import { ConnectionBadge, MediaThumb, PlaybackBadge } from '../components/domain';
import type { CommandType, PlayerManifest } from '../../shared/types';
import type { DeviceDto } from './Devices';

interface CommandRow {
  id: string;
  type: string;
  payload: { index?: number; enabled?: boolean; fitMode?: string } | null;
  status: 'PENDING' | 'ACKED' | 'FAILED' | 'TIMEOUT';
  error: string | null;
  createdAt: string;
  respondedAt: string | null;
  createdBy: string | null;
}

const CMD_LABEL: Record<string, string> = {
  pause: 'Pausar',
  resume: 'Continuar',
  next: 'Próxima',
  previous: 'Anterior',
  restart: 'Reiniciar playlist',
  goto: 'Ir para item',
  reload: 'Recarregar player',
  set_audio: 'Áudio',
  set_fit: 'Ajuste de tela',
  sync: 'Sincronizar',
};

export default function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ['device', id], queryFn: () => api<{ device: DeviceDto; commands: CommandRow[] }>(`/api/devices/${id}`), refetchInterval: 15_000 });
  const manifest = useQuery({ queryKey: ['device', id, 'manifest'], queryFn: () => api<{ manifest: PlayerManifest }>(`/api/devices/${id}/manifest`) });
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ name: string; location: string } | null>(null);
  useTicker(500);
  const live = useLiveState(id, data?.device.state, data?.device.stateAt);
  if (isLoading || !data) return <Loading />;
  const d = data.device;
  const st = live?.state;
  const online = d.connection === 'online';
  const canControl = user.canPublish;
  const items = manifest.data?.manifest.version?.items ?? [];
  const sinceReport = live ? Date.now() - live.at : 0;
  const elapsed = st ? Math.min(st.durationMs, st.elapsedMs + (st.status === 'playing' && online ? sinceReport : 0)) : 0;
  const fit = st?.fitMode ?? d.overrides.fitMode ?? manifest.data?.manifest.version?.settings.fitMode ?? 'contain';
  const audio = st?.audio ?? d.overrides.audio ?? manifest.data?.manifest.version?.settings.audio ?? false;

  const send = async (type: CommandType, payload?: Record<string, unknown>) => {
    setBusy(type + JSON.stringify(payload ?? {}));
    try {
      const r = await api<{ status: string; message?: string }>(`/api/devices/${id}/commands`, { body: { type, payload } });
      if (r.status === 'saved') toast.info(r.message);
      else toast.success(`${CMD_LABEL[type]}: confirmado pelo telão`);
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'DEVICE_TIMEOUT' ? 'O telão não confirmou o comando. Verifique a conexão dele.' : errorMessage(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['device', id] });
    }
  };
  const isBusy = (type: string, payload?: Record<string, unknown>) => busy === type + JSON.stringify(payload ?? {});

  const admin = async (action: 'revoke' | 'renew' | 'unassign' | 'delete') => {
    const texts = {
      revoke: { title: 'Revogar acesso deste telão?', description: 'O computador deixará de reproduzir e voltará à tela de vinculação. Será preciso vincular de novo com um código.', label: 'Revogar' },
      renew: { title: 'Renovar autorização?', description: `A credencial do dispositivo terá a validade estendida.`, label: 'Renovar' },
      unassign: { title: 'Desvincular a playlist?', description: 'O telão ficará sem programação padrão (agendamentos continuam valendo).', label: 'Desvincular' },
      delete: { title: `Excluir "${d.name}"?`, description: 'O telão, seus agendamentos e o histórico de comandos serão removidos e o acesso revogado.', label: 'Excluir' },
    }[action];
    if (!(await confirm({ title: texts.title, description: texts.description, confirmLabel: texts.label, tone: action === 'renew' ? 'primary' : 'danger' }))) return;
    try {
      if (action === 'delete') {
        await api(`/api/devices/${id}`, { method: 'DELETE' });
        toast.success('Telão excluído');
        void qc.invalidateQueries({ queryKey: ['devices'] });
        navigate('/admin/devices');
        return;
      }
      await api(`/api/devices/${id}/${action}`, { body: {} });
      toast.success('Concluído');
      void qc.invalidateQueries({ queryKey: ['device', id] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const saveInfo = async () => {
    if (!edit) return;
    try {
      await api(`/api/devices/${id}`, { method: 'PATCH', body: { name: edit.name.trim(), location: edit.location.trim() || null } });
      toast.success('Telão atualizado');
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['device', id] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const activeCred = d.credentials.find((c) => !c.revokedAt && new Date(c.expiresAt) > new Date());

  return (
    <div>
      <Link to="/admin/devices" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" /> Telões
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[22px] font-semibold tracking-tight text-ink-900">{d.name}</h1>
            <ConnectionBadge connection={d.connection} />
          </div>
          <p className="mt-1 text-sm text-ink-500">
            Controle remoto · {d.location ? `${d.location} · ` : ''}
            <span className="font-mono">{d.identifier}</span> · último sinal {online ? 'agora' : relativeTime(d.lastSeenAt)}
          </p>
        </div>
      </div>

      {!online && (
        <Alert className="mb-5" tone={d.connection === 'reconnecting' ? 'amber' : 'red'} title={d.connection === 'reconnecting' ? 'Telão reconectando' : 'Telão offline'}>
          Os comandos só são executados com o telão conectado. Enquanto isso, ele continua reproduzindo a última programação baixada.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Em reprodução" actions={online && <PlaybackBadge status={st?.status} />} />
            <div className="grid gap-5 p-5 sm:grid-cols-[240px_minmax(0,1fr)]">
              <MediaThumb media={{ thumbnailUrl: st?.mediaId ? `/api/media/${st.mediaId}/thumbnail` : null, type: st?.mediaType ?? 'image', durationMs: null, name: '', status: 'ready' }} className="w-full rounded-lg" showType={false} />
              <div className="min-w-0 space-y-3">
                <p className="truncate text-lg font-semibold text-ink-900">{st?.mediaName ?? '—'}</p>
                <p className="text-[13px] text-ink-500">
                  {st?.playlistName ? `${st.playlistName} · v${st.versionNumber}` : 'Sem programação'} {st && st.total > 0 && `· item ${st.index + 1} de ${st.total}`}
                </p>
                {st && st.total > 0 && (
                  <div>
                    <Progress value={st.durationMs ? (elapsed / st.durationMs) * 100 : 0} />
                    <div className="tabular mt-1.5 flex justify-between text-xs text-ink-500">
                      <span>Decorrido {formatDuration(elapsed)}</span>
                      <span>Restante {formatDuration(Math.max(0, st.durationMs - elapsed))}</span>
                    </div>
                  </div>
                )}
                {st?.lastError && <p className="text-xs text-red-700">Último erro: {st.lastError}</p>}
                {st?.audioBlocked && <p className="text-xs text-amber-700">O navegador do telão bloqueou o áudio. Veja o guia do modo quiosque para liberar autoplay com som.</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-5 py-4">
              <Button icon={<SkipBack />} disabled={!online || !canControl} loading={isBusy('previous')} onClick={() => send('previous')}>
                Anterior
              </Button>
              {st?.status === 'paused' ? (
                <Button variant="primary" icon={<Play />} disabled={!online || !canControl} loading={isBusy('resume')} onClick={() => send('resume')}>
                  Continuar
                </Button>
              ) : (
                <Button variant="primary" icon={<Pause />} disabled={!online || !canControl} loading={isBusy('pause')} onClick={() => send('pause')}>
                  Pausar
                </Button>
              )}
              <Button icon={<SkipForward />} disabled={!online || !canControl} loading={isBusy('next')} onClick={() => send('next')}>
                Próxima
              </Button>
              <Button icon={<RotateCcw />} disabled={!online || !canControl} loading={isBusy('restart')} onClick={() => send('restart')}>
                Reiniciar playlist
              </Button>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" icon={<RefreshCw />} disabled={!online || !canControl} loading={isBusy('sync')} onClick={() => send('sync')} title="Verificar atualizações agora">
                  Sincronizar
                </Button>
                <Button variant="ghost" icon={<Monitor />} disabled={!online || !canControl} loading={isBusy('reload')} onClick={() => send('reload')} title="Recarrega a página do player">
                  Recarregar player
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-6 border-t border-ink-100 px-5 py-4">
              <div className="flex items-center gap-2">
                {audio ? <Volume2 className="size-4 text-ink-500" /> : <VolumeX className="size-4 text-ink-500" />}
                <Switch checked={audio} disabled={!canControl || !!busy} onChange={(v) => send('set_audio', { enabled: v })} label="Áudio" />
              </div>
              <div className="flex items-center gap-2 text-[13px] text-ink-700">
                Ajuste:
                <Segmented size="sm" value={fit} disabled={!canControl || !!busy} onChange={(v) => send('set_fit', { fitMode: v })} options={[{ value: 'contain', label: 'Mostrar completo' }, { value: 'cover', label: 'Preencher' }]} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Programação atual" description={manifest.data?.manifest.source === 'schedule' ? `Agendamento: ${manifest.data.manifest.scheduleName}` : manifest.data?.manifest.version ? 'Programação padrão' : undefined} />
            {items.length ? (
              <ol className="scrollbar-thin max-h-[420px] divide-y divide-ink-100 overflow-y-auto">
                {items.map((it, i) => {
                  const current = st?.versionId === manifest.data?.manifest.version?.versionId && st?.index === i;
                  return (
                    <li key={it.itemId} className={cn('flex items-center gap-3 px-5 py-2', current && 'bg-brand-50/70')}>
                      <span className="tabular w-6 text-center text-xs font-semibold text-ink-400">{i + 1}</span>
                      <MediaThumb media={{ thumbnailUrl: `/api/media/${it.mediaId}/thumbnail`, type: it.type, durationMs: null, name: it.name, status: 'ready' }} className="w-16 shrink-0" showType={false} />
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate text-[13px]', current ? 'font-semibold text-brand-800' : 'text-ink-800')}>{it.name}</p>
                        <p className="text-xs text-ink-500">
                          {it.type === 'video' ? 'Vídeo' : 'Imagem'} · {formatDuration(it.durationMs)}
                        </p>
                      </div>
                      {current ? (
                        <Badge tone="brand">No ar</Badge>
                      ) : (
                        <Button size="sm" variant="ghost" disabled={!online || !canControl} loading={isBusy('goto', { index: i })} onClick={() => send('goto', { index: i })}>
                          Exibir agora
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="px-5 py-6 text-[13px] text-ink-500">
                Nenhuma playlist publicada para este telão. <Link to="/admin/playlists" className="text-brand-700 hover:underline">Publicar uma playlist</Link>
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Sincronização e dispositivo" />
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 p-5 text-[13px]">
              <dt className="text-ink-500">Versão-alvo</dt>
              <dd className="text-ink-800">{d.effectiveVersion ? `${d.effectiveVersion.playlistName} v${d.effectiveVersion.number}` : '—'}</dd>
              <dt className="text-ink-500">Versão no telão</dt>
              <dd className="text-ink-800">
                {d.reportedVersion ? `${d.reportedVersion.playlistName} v${d.reportedVersion.number}` : '—'} {d.inSync ? <Badge tone="green">sincronizado</Badge> : d.effectiveVersion && <Badge tone="amber">pendente</Badge>}
              </dd>
              {st?.preparing && (
                <>
                  <dt className="text-ink-500">Baixando</dt>
                  <dd>
                    <Progress value={st.preparing.totalBytes ? (st.preparing.doneBytes / st.preparing.totalBytes) * 100 : 0} />
                    <span className="text-xs text-ink-500">
                      {st.preparing.doneItems}/{st.preparing.totalItems} arquivos · {formatBytes(st.preparing.doneBytes)} de {formatBytes(st.preparing.totalBytes)}
                    </span>
                  </dd>
                </>
              )}
              {st?.prepareError && (
                <>
                  <dt className="text-ink-500">Falha</dt>
                  <dd className="text-red-700">{st.prepareError}</dd>
                </>
              )}
              <dt className="text-ink-500">Aplicação</dt>
              <dd className="text-ink-800">{d.applyMode === 'immediate' ? 'Imediata' : 'No próximo intervalo'}</dd>
              <dt className="text-ink-500">Cache local</dt>
              <dd className="flex items-center gap-1 text-ink-800">
                <HardDrive className="size-3.5 text-ink-400" />
                {st?.cache.usageBytes !== null && st?.cache.usageBytes !== undefined ? `${formatBytes(st.cache.usageBytes)} de ${formatBytes(st.cache.quotaBytes)} · ${st.cache.cachedItems} arquivo(s)${st.cache.persisted ? ' · persistente' : ''}` : 'indisponível (requer HTTPS)'}
              </dd>
              <dt className="text-ink-500">Tela</dt>
              <dd className="text-ink-800">{st ? `${Math.round(st.screen.width * st.screen.dpr)}×${Math.round(st.screen.height * st.screen.dpr)}` : '—'}</dd>
              <dt className="text-ink-500">Player</dt>
              <dd className="text-ink-800">{st ? `${st.appVersion} · ativo há ${formatDuration(st.uptimeSec * 1000)}` : '—'}</dd>
              <dt className="text-ink-500">Cadastro</dt>
              <dd className="text-ink-800">{formatDate(d.createdAt)}</dd>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Comandos recentes" />
            {data.commands.length ? (
              <ul className="scrollbar-thin max-h-72 divide-y divide-ink-100 overflow-y-auto">
                {data.commands.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-2 text-[13px]">
                    <div className="min-w-0">
                      <p className="truncate text-ink-800">
                        {CMD_LABEL[c.type] ?? c.type}
                        {c.type === 'goto' && c.payload?.index !== undefined ? ` #${c.payload.index + 1}` : ''}
                        {c.type === 'set_audio' ? (c.payload?.enabled ? ' ligado' : ' desligado') : ''}
                        {c.type === 'set_fit' ? ` (${c.payload?.fitMode === 'cover' ? 'preencher' : 'completo'})` : ''}
                      </p>
                      <p className="truncate text-xs text-ink-500">
                        {formatDateTime(c.createdAt)} · {c.createdBy ?? '—'}
                        {c.error ? ` · ${c.error}` : ''}
                      </p>
                    </div>
                    <Badge tone={c.status === 'ACKED' ? 'green' : c.status === 'PENDING' ? 'neutral' : c.status === 'TIMEOUT' ? 'amber' : 'red'}>
                      {{ ACKED: 'Confirmado', PENDING: 'Enviado', FAILED: 'Falhou', TIMEOUT: 'Sem resposta' }[c.status]}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-[13px] text-ink-500">Nenhum comando enviado.</p>
            )}
          </Card>

          {user.role === 'ADMIN' && (
            <Card>
              <CardHeader icon={<ShieldCheck />} title="Administração do dispositivo" />
              <div className="space-y-4 p-5">
                {edit ? (
                  <div className="space-y-3">
                    <Field label="Nome">
                      <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} />
                    </Field>
                    <Field label="Local">
                      <Input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} maxLength={120} />
                    </Field>
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" disabled={edit.name.trim().length < 2} onClick={saveInfo}>
                        Salvar
                      </Button>
                      <Button size="sm" onClick={() => setEdit(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" onClick={() => setEdit({ name: d.name, location: d.location ?? '' })}>
                    Editar nome e local
                  </Button>
                )}
                <div className="text-[13px] text-ink-600">
                  {activeCred ? (
                    <>
                      Credencial ativa desde {formatDate(activeCred.createdAt)}, válida até <b>{formatDate(activeCred.expiresAt)}</b> (renovada automaticamente com o uso).
                    </>
                  ) : (
                    <span className="text-red-700">Sem credencial ativa.</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!activeCred} onClick={() => admin('renew')}>
                    Renovar autorização
                  </Button>
                  <Link to="/admin/devices?pair=1">
                    <Button size="sm">Vincular outro computador</Button>
                  </Link>
                  <Button size="sm" variant="outline" disabled={!activeCred} onClick={() => admin('revoke')}>
                    Revogar acesso
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-4">
                  <Button size="sm" variant="ghost" icon={<Unlink />} disabled={!d.playlist} onClick={() => admin('unassign')}>
                    Desvincular playlist
                  </Button>
                  <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" icon={<Trash />} onClick={() => admin('delete')}>
                    Excluir telão
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
