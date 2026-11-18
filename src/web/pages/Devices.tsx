import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Link2, MonitorPlay, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatTime, relativeTime } from '../lib/format';
import { useLiveState } from '../lib/realtime';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Segmented, Select } from '../components/ui';
import { ConnectionBadge, PlaybackBadge } from '../components/domain';
import type { DeviceConnection, PlayerStateReport } from '../../shared/types';

export interface DeviceDto {
  id: string;
  name: string;
  identifier: string;
  location: string | null;
  createdAt: string;
  connection: DeviceConnection;
  lastSeenAt: string | null;
  applyMode: 'next' | 'immediate';
  overrides: { fitMode?: 'contain' | 'cover'; audio?: boolean };
  playlist: { id: string; name: string } | null;
  publishedVersion: { id: string; number: number; playlistName: string } | null;
  effectiveVersion: { id: string; number: number; itemCount: number; playlistId: string; playlistName: string } | null;
  effectiveSource: string | null;
  reportedVersion: { id: string; number: number; playlistName: string } | null;
  inSync: boolean;
  state: PlayerStateReport | null;
  stateAt: string | null;
  lastError: string | null;
  authorized: boolean;
  credentials: Array<{ id: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null }>;
}

export default function Devices() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [pairing, setPairing] = useState(params.get('pair') === '1');
  const { data, isLoading } = useQuery({ queryKey: ['devices'], queryFn: () => api<{ devices: DeviceDto[] }>('/api/devices'), refetchInterval: 20_000 });

  return (
    <div>
      <PageHeader
        title="Telões"
        description="Dispositivos autorizados a reproduzir a programação."
        actions={
          user.role === 'ADMIN' && (
            <Button variant="primary" icon={<Link2 />} onClick={() => setPairing(true)}>
              Vincular telão
            </Button>
          )
        }
      />
      {isLoading ? (
        <Loading />
      ) : !data?.devices.length ? (
        <Card>
          <EmptyState
            icon={<MonitorPlay />}
            title="Nenhum telão vinculado"
            description={
              <>
                No computador do telão, abra <b>{location.origin}/player</b>. Um código aparecerá na tela — informe-o aqui para autorizar o dispositivo.
              </>
            }
            action={
              user.role === 'ADMIN' && (
                <Button variant="primary" icon={<Link2 />} onClick={() => setPairing(true)}>
                  Vincular telão
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.devices.map((d) => (
            <DeviceCard key={d.id} d={d} />
          ))}
        </div>
      )}
      {pairing && (
        <PairDialog
          devices={data?.devices ?? []}
          onClose={() => {
            setPairing(false);
            if (params.has('pair')) setParams({});
          }}
        />
      )}
    </div>
  );
}

function DeviceCard({ d }: { d: DeviceDto }) {
  const live = useLiveState(d.id, d.state, d.stateAt);
  const st = live?.state;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
            <MonitorPlay className="size-5" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-semibold text-ink-900">{d.name}</h3>
            <p className="truncate text-xs text-ink-500">
              {d.location ? `${d.location} · ` : ''}
              <span className="font-mono">{d.identifier}</span>
            </p>
          </div>
        </div>
        <ConnectionBadge connection={d.connection} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-ink-500">Programação</dt>
        <dd className="truncate text-ink-800">
          {d.effectiveVersion ? `${d.effectiveVersion.playlistName} v${d.effectiveVersion.number}` : '—'}
          {d.effectiveSource?.startsWith('schedule:') && (
            <Badge tone="violet" className="ml-1.5">
              agendada
            </Badge>
          )}
        </dd>
        <dt className="text-ink-500">Em exibição</dt>
        <dd className="truncate text-ink-800">{d.connection === 'online' && st?.mediaName ? `${st.index + 1}/${st.total} · ${st.mediaName}` : '—'}</dd>
        <dt className="text-ink-500">Estado</dt>
        <dd>{d.connection === 'online' ? <PlaybackBadge status={st?.status} /> : <span className="text-ink-500">—</span>}</dd>
        <dt className="text-ink-500">Último sinal</dt>
        <dd className="text-ink-800">{d.connection === 'online' ? 'agora' : relativeTime(d.lastSeenAt)}</dd>
      </dl>
      {!d.authorized && (
        <Alert tone="red" className="mt-4">
          Sem credencial ativa — vincule novamente com um código.
        </Alert>
      )}
      {d.authorized && !d.inSync && d.effectiveVersion && <p className="mt-3 text-xs text-amber-700">{d.connection === 'online' ? 'Atualizando para a versão mais recente…' : 'Atualização pendente: será aplicada ao reconectar.'}</p>}
      <div className="mt-4 flex justify-end">
        <Link to={`/admin/devices/${d.id}`}>
          <Button size="sm" icon={<ArrowUpRight />}>
            Controle remoto
          </Button>
        </Link>
      </div>
    </Card>
  );
}

function PairDialog({ devices, onClose }: { devices: DeviceDto[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>(devices.length ? 'existing' : 'new');
  const [name, setName] = useState(devices.length ? '' : 'Telão da Matriz');
  const [location, setLocation] = useState('');
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const pending = useQuery({ queryKey: ['pairings'], queryFn: () => api<{ pairings: Array<{ id: string; code: string; createdAt: string; expiresAt: string; userAgent: string | null }> }>('/api/devices/pairings'), refetchInterval: 5000 });
  useEffect(() => {
    if (!devices.length) setMode('new');
  }, [devices.length]);

  const formatCode = (v: string) => {
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
  };

  const submit = async () => {
    setBusy(true);
    try {
      const body = mode === 'new' ? { code, name: name.trim(), location: location.trim() || undefined } : { code, deviceId };
      const r = await api<{ device: { name: string } }>('/api/devices/pair', { body });
      toast.success(`${r.device.name} vinculado. O telão carregará a programação em instantes.`);
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const valid = code.replace('-', '').length === 6 && (mode === 'new' ? name.trim().length >= 2 : !!deviceId);
  return (
    <Modal
      open
      onClose={onClose}
      title="Vincular telão"
      description="Autorize o computador do telão com o código exibido na tela dele."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Autorizar dispositivo
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <ol className="list-decimal space-y-1 pl-5 text-[13px] text-ink-600">
          <li>
            No computador do telão, abra <b className="font-mono">{window.location.origin}/player</b>.
          </li>
          <li>Um código de 6 caracteres aparecerá na tela.</li>
          <li>Digite o código abaixo. O dispositivo recebe uma credencial própria (sem usar sua senha).</li>
        </ol>
        <Field label="Código exibido no telão">
          <Input value={code} onChange={(e) => setCode(formatCode(e.target.value))} placeholder="ABC-123" className="h-12 text-center font-mono text-2xl tracking-[0.3em] uppercase" autoComplete="off" />
        </Field>
        {!!pending.data?.pairings.length && (
          <div className="rounded-lg border border-ink-200 bg-ink-50/60 p-3">
            <p className="mb-2 text-xs font-medium text-ink-600">Telões aguardando vinculação agora (confira o código na tela antes de aprovar):</p>
            <div className="flex flex-wrap gap-2">
              {pending.data.pairings.map((p) => (
                <button key={p.id} onClick={() => setCode(p.code)} className="rounded-md border border-ink-200 bg-white px-2.5 py-1 font-mono text-sm hover:border-brand-400" title={`Solicitado às ${formatTime(p.createdAt)}`}>
                  {p.code}
                </button>
              ))}
            </div>
          </div>
        )}
        {devices.length > 0 && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'existing', label: 'Telão já cadastrado' },
              { value: 'new', label: 'Novo telão', icon: <Plus /> },
            ]}
          />
        )}
        {mode === 'new' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome do telão">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Telão da Matriz" maxLength={80} />
            </Field>
            <Field label="Local" hint="Opcional">
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Recepção — térreo" maxLength={120} />
            </Field>
          </div>
        ) : (
          <Field label="Telão" hint="O computador anterior deste telão perde o acesso (útil ao trocar de máquina).">
            <Select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
