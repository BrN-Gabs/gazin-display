import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LoaderCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useLiveState } from '../lib/realtime';
import { Alert, Button, Modal, cn } from './ui';
import { ConnectionBadge } from './domain';
import type { DeviceConnection, PlayerStateReport } from '../../shared/types';

interface DeviceRow {
  id: string;
  name: string;
  location: string | null;
  connection: DeviceConnection;
  playlist: { id: string; name: string } | null;
  effectiveVersion: { id: string; number: number; playlistName: string } | null;
  reportedVersion: { id: string } | null;
  effectiveSource: string | null;
  state: PlayerStateReport | null;
  stateAt: string | null;
}

/**
 * Publicação: cria uma nova versão imutável e a envia aos telões selecionados.
 * Após publicar, acompanha a confirmação real de cada telão.
 */
export function PublishDialog({ open, onClose, playlistId, playlistName, beforePublish }: { open: boolean; onClose: () => void; playlistId: string; playlistName: string; beforePublish?: () => Promise<number | null> }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['devices'], queryFn: () => api<{ devices: DeviceRow[] }>('/api/devices'), enabled: open });
  const devices = data?.devices ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'next' | 'immediate'>('next');
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<{ versionId: string; number: number; deviceIds: string[] } | null>(null);

  useEffect(() => {
    if (!open) {
      setPublished(null);
      return;
    }
    if (!data) return;
    const using = devices.filter((d) => d.playlist?.id === playlistId).map((d) => d.id);
    setSelected(using.length ? using : devices.length === 1 ? [devices[0]!.id] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data]);

  const publish = async () => {
    setBusy(true);
    try {
      const revision = beforePublish ? await beforePublish() : undefined;
      if (revision === null) return;
      const r = await api<{ version: { id: string; number: number } }>(`/api/playlists/${playlistId}/publish`, { body: { deviceIds: selected, applyMode: mode, ...(revision !== undefined ? { revision } : {}) } });
      setPublished({ versionId: r.version.id, number: r.version.number, deviceIds: selected });
      toast.success(`Versão ${r.version.number} de "${playlistName}" publicada`);
      for (const k of ['playlists', 'playlist', 'devices', 'dashboard']) void qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={published ? `Versão ${published.number} publicada` : 'Publicar no telão'}
      description={published ? 'Acompanhe a atualização em cada telão.' : `"${playlistName}" — o rascunho salvo vira uma nova versão oficial.`}
      footer={
        published ? (
          <Button variant="primary" onClick={onClose}>
            Concluir
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" icon={<Send />} loading={busy} onClick={publish}>
              {selected.length ? `Publicar em ${selected.length} telão(ões)` : 'Publicar versão sem atribuir'}
            </Button>
          </>
        )
      }
    >
      {published ? (
        <div className="space-y-3">
          {published.deviceIds.length === 0 && <p className="text-sm text-ink-600">A versão foi salva. Ela será usada por agendamentos desta playlist ou quando você a publicar em um telão.</p>}
          {devices
            .filter((d) => published.deviceIds.includes(d.id))
            .map((d) => (
              <SyncRow key={d.id} device={d} versionId={published.versionId} />
            ))}
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-700">Telões</p>
            {devices.length === 0 ? (
              <Alert tone="brand">Nenhum telão vinculado ainda. Você pode publicar a versão agora e atribuí-la depois.</Alert>
            ) : (
              <div className="space-y-2">
                {devices.map((d) => (
                  <label key={d.id} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition', selected.includes(d.id) ? 'border-brand-300 bg-brand-50/60' : 'border-ink-200 hover:bg-ink-50')}>
                    <input
                      type="checkbox"
                      className="size-4 accent-brand-600"
                      checked={selected.includes(d.id)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)))}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-900">{d.name}</p>
                      <p className="truncate text-xs text-ink-500">{d.effectiveVersion ? `Atual: ${d.effectiveVersion.playlistName} v${d.effectiveVersion.number}` : 'Sem programação'}</p>
                    </div>
                    <ConnectionBadge connection={d.connection} />
                  </label>
                ))}
              </div>
            )}
            {devices.some((d) => selected.includes(d.id) && d.effectiveSource?.startsWith('schedule:')) && (
              <p className="mt-2 text-xs text-amber-700">Um dos telões está com um agendamento ativo: a nova versão vira a programação padrão e aparece quando o agendamento terminar.</p>
            )}
          </div>
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-700">Quando aplicar</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { v: 'next' as const, title: 'No próximo intervalo', desc: 'A mídia atual termina e a nova programação entra em seguida. Recomendado.' },
                { v: 'immediate' as const, title: 'Imediatamente', desc: 'Interrompe a mídia atual assim que os arquivos estiverem prontos.' },
              ].map((o) => (
                <label key={o.v} className={cn('cursor-pointer rounded-lg border p-3 transition', mode === o.v ? 'border-brand-300 bg-brand-50/60' : 'border-ink-200 hover:bg-ink-50')}>
                  <div className="flex items-center gap-2">
                    <input type="radio" name="apply" className="accent-brand-600" checked={mode === o.v} onChange={() => setMode(o.v)} />
                    <span className="text-sm font-medium text-ink-900">{o.title}</span>
                  </div>
                  <p className="mt-1 pl-5 text-xs text-ink-500">{o.desc}</p>
                </label>
              ))}
            </div>
          </div>
          <p className="text-xs text-ink-500">O telão baixa e valida os arquivos antes de trocar. Se algo falhar, a programação anterior continua no ar.</p>
        </div>
      )}
    </Modal>
  );
}

function SyncRow({ device, versionId }: { device: DeviceRow; versionId: string }) {
  const live = useLiveState(device.id, device.state, device.stateAt);
  const st = live?.state;
  const applied = st?.versionId === versionId;
  const preparing = st?.preparing?.versionId === versionId ? st.preparing : null;
  const pending = st?.pendingVersionId === versionId;
  let label = 'Aguardando o telão…';
  if (device.connection !== 'online') label = 'Telão offline: a atualização será aplicada quando ele reconectar.';
  else if (applied) label = 'Atualizado e reproduzindo a nova versão.';
  else if (pending) label = 'Arquivos prontos: entra no próximo intervalo entre mídias.';
  else if (preparing) label = `Baixando arquivos: ${preparing.doneItems}/${preparing.totalItems}`;
  else if (st?.prepareError) label = st.prepareError;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-200 px-3 py-3">
      {applied ? <CircleCheck className="size-5 text-emerald-600" /> : <LoaderCircle className={cn('size-5', device.connection === 'online' ? 'animate-spin text-brand-600' : 'text-ink-300')} />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink-900">{device.name}</p>
        <p className={cn('text-xs', st?.prepareError && !applied ? 'text-red-700' : 'text-ink-500')}>{label}</p>
      </div>
    </div>
  );
}
