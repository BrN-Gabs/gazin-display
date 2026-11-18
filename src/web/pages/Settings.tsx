import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MonitorPlay, Plus, Server, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes, formatDateTime, relativeTime } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Switch, cn } from '../components/ui';

interface GlobalSettings {
  imageDurationSec: number;
  loop: boolean;
  audio: boolean;
  fitMode: 'contain' | 'cover';
  emptyBehavior: 'black' | 'standby';
  maxUploadMb: number;
  offlineAfterSec: number;
  storageLimitGb: number;
}
interface SystemInfo {
  storageDriver: string;
  maxUploadMbEnv: number;
  chunkMb: number;
  ffmpeg: boolean;
  directUpload: boolean;
  storage: { usedBytes: number; reservedBytes: number; limitBytes: number; warn: boolean };
  timezone: string;
  sessionTtlHours: number;
  deviceTokenTtlDays: number;
}

const TABS = [
  { id: 'playback', label: 'Reprodução', icon: SlidersHorizontal },
  { id: 'system', label: 'Sistema', icon: Server },
  { id: 'users', label: 'Usuários', icon: Users, admin: true },
  { id: 'security', label: 'Segurança', icon: ShieldCheck },
] as const;

export default function SettingsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'playback';
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api<{ settings: GlobalSettings; system: SystemInfo }>('/api/settings') });
  return (
    <div>
      <PageHeader title="Configurações" description="Padrões de reprodução, limites do sistema, usuários e segurança." />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-ink-200">
        {TABS.filter((t) => !('admin' in t) || user.role === 'ADMIN').map((t) => (
          <button
            key={t.id}
            onClick={() => setParams({ tab: t.id })}
            className={cn('-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition', tab === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800')}
          >
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      {isLoading || !data ? (
        <Loading />
      ) : tab === 'playback' ? (
        <PlaybackSettings settings={data.settings} readOnly={user.role !== 'ADMIN'} />
      ) : tab === 'system' ? (
        <SystemSettings settings={data.settings} system={data.system} readOnly={user.role !== 'ADMIN'} />
      ) : tab === 'users' && user.role === 'ADMIN' ? (
        <UsersSettings />
      ) : (
        <SecuritySettings />
      )}
    </div>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async (patch: Partial<GlobalSettings>) => {
    setSaving(true);
    try {
      await api('/api/settings', { method: 'PUT', body: patch });
      toast.success('Configurações salvas');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return { save, saving };
}

function PlaybackSettings({ settings, readOnly }: { settings: GlobalSettings; readOnly: boolean }) {
  const [s, setS] = useState(settings);
  const { save, saving } = useSaveSettings();
  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Padrões de reprodução" description="Aplicados a novas playlists e às imagens sem duração definida. Cada playlist pode ajustar os seus." />
      <div className="space-y-6 p-5">
        {readOnly && <Alert tone="brand">Somente administradores podem alterar estas configurações.</Alert>}
        <Field label="Duração padrão das imagens (segundos)" hint="Padrão: 30 segundos. Vale para imagens sem duração personalizada (após a próxima publicação).">
          <Input type="number" min={1} max={86400} className="w-40" disabled={readOnly} value={s.imageDurationSec} onChange={(e) => setS({ ...s, imageDurationSec: Math.max(1, Math.min(86400, Number(e.target.value) || 1)) })} />
        </Field>
        <Switch disabled={readOnly} checked={s.loop} onChange={(v) => setS({ ...s, loop: v })} label="Loop automático" description="Novas playlists recomeçam ao terminar o último item." />
        <Switch disabled={readOnly} checked={s.audio} onChange={(v) => setS({ ...s, audio: v })} label="Áudio habilitado por padrão" description="Recomendado desligado para garantir a reprodução automática." />
        <Field label="Ajuste padrão das mídias">
          <Segmented disabled={readOnly} value={s.fitMode} onChange={(v) => setS({ ...s, fitMode: v })} options={[{ value: 'contain', label: 'Mostrar completo' }, { value: 'cover', label: 'Preencher a tela' }]} />
        </Field>
        <Field label="Quando não houver conteúdo publicado" hint="O que o telão mostra sem programação.">
          <Select disabled={readOnly} className="w-80" value={s.emptyBehavior} onChange={(e) => setS({ ...s, emptyBehavior: e.target.value as GlobalSettings['emptyBehavior'] })}>
            <option value="standby">Tela de espera discreta (GAZIN DISPLAY)</option>
            <option value="black">Tela preta</option>
          </Select>
        </Field>
        {!readOnly && (
          <div className="flex justify-end">
            <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => save(s)}>
              Salvar
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function SystemSettings({ settings, system, readOnly }: { settings: GlobalSettings; system: SystemInfo; readOnly: boolean }) {
  const [maxUploadMb, setMax] = useState(settings.maxUploadMb);
  const [offlineAfterSec, setOffline] = useState(settings.offlineAfterSec);
  const [storageLimitGb, setStorageLimit] = useState(settings.storageLimitGb);
  const usedPct = system.storage.limitBytes ? Math.round((system.storage.usedBytes / system.storage.limitBytes) * 100) : 0;
  const { save, saving } = useSaveSettings();
  return (
    <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Limites e monitoramento" />
        <div className="space-y-5 p-5">
          <Field label="Tamanho máximo por arquivo (MB)" hint={`Limite absoluto do servidor: ${system.maxUploadMbEnv.toLocaleString('pt-BR')} MB (MAX_UPLOAD_MB). Uploads são feitos em partes de ${system.chunkMb} MB.`}>
            <Input type="number" min={1} disabled={readOnly} className="w-48" value={maxUploadMb} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field
            label="Limite de armazenamento das mídias (GB)"
            hint={`Em uso: ${formatBytes(system.storage.usedBytes)} (${usedPct}%). Limite da aplicação: novos envios são recusados acima dele. Não substitui o controle de faturamento da Cloudflare.`}
          >
            <Input type="number" min={1} disabled={readOnly} className="w-48" value={storageLimitGb} onChange={(e) => setStorageLimit(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          {system.storage.warn && <Alert tone="amber">O armazenamento está acima de 85% do limite. Remova mídias sem uso ou aumente o limite.</Alert>}
          <Field label="Considerar telão offline após (segundos sem sinal)">
            <Input type="number" min={15} max={3600} disabled={readOnly} className="w-48" value={offlineAfterSec} onChange={(e) => setOffline(Math.max(15, Math.min(3600, Number(e.target.value) || 45)))} />
          </Field>
          {!readOnly && (
            <div className="flex justify-end">
              <Button variant="primary" loading={saving} disabled={maxUploadMb === settings.maxUploadMb && offlineAfterSec === settings.offlineAfterSec && storageLimitGb === settings.storageLimitGb} onClick={() => save({ maxUploadMb, offlineAfterSec, storageLimitGb })}>
                Salvar
              </Button>
            </div>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Ambiente do servidor" description="Cloudflare Workers — definido em wrangler.jsonc e nos secrets do Worker." />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 p-5 text-[13px]">
          <dt className="text-ink-500">Armazenamento</dt>
          <dd className="font-medium text-ink-800">{system.storageDriver === 'r2' ? 'Cloudflare R2' : system.storageDriver === 's3' ? 'S3 compatível' : 'Disco local persistente'}</dd>
          <dt className="text-ink-500">Envio de arquivos</dt>
          <dd>{system.directUpload ? <Badge tone="green">Direto ao R2 (URLs temporárias)</Badge> : <Badge tone="amber">Pelo Worker (credenciais do R2 não configuradas)</Badge>}</dd>
          <dt className="text-ink-500">Processamento de vídeo</dt>
          <dd>{system.ffmpeg ? <Badge tone="green">FFmpeg disponível</Badge> : <Badge tone="neutral">No navegador (sem conversão: envie MP4 H.264 ou WebM)</Badge>}</dd>
          <dt className="text-ink-500">Fuso horário</dt>
          <dd className="text-ink-800">{system.timezone}</dd>
          <dt className="text-ink-500">Sessão administrativa</dt>
          <dd className="text-ink-800">{system.sessionTtlHours} h (renovada com o uso)</dd>
          <dt className="text-ink-500">Credencial dos telões</dt>
          <dd className="text-ink-800">{system.deviceTokenTtlDays} dias (renovada automaticamente)</dd>
        </dl>
        <div className="border-t border-ink-100 px-5 py-4 text-[13px]">
          <Link to="/admin/devices" className="inline-flex items-center gap-1.5 font-medium text-brand-700 hover:underline">
            <MonitorPlay className="size-4" /> Gerenciar nomes e autorização dos telões
          </Link>
        </div>
      </Card>
    </div>
  );
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: 'ADMIN' | 'EDITOR';
  canPublish: boolean;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function UsersSettings() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserRow[] }>('/api/users') });
  const [form, setForm] = useState<{ id?: string; name: string; email: string; username: string; role: 'ADMIN' | 'EDITOR'; canPublish: boolean; active: boolean; password: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      if (form.id) await api(`/api/users/${form.id}`, { method: 'PATCH', body: { name: form.name, role: form.role, canPublish: form.canPublish, active: form.active, ...(form.password ? { password: form.password } : {}) } });
      else await api('/api/users', { body: { name: form.name, email: form.email, username: form.username || undefined, role: form.role, canPublish: form.canPublish, password: form.password } });
      toast.success(form.id ? 'Usuário atualizado' : 'Usuário criado');
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="max-w-5xl">
      <CardHeader
        title="Usuários autorizados"
        description="Administradores têm acesso completo. Editores enviam mídias e organizam playlists; publicam e controlam telões somente se autorizados."
        actions={
          <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setForm({ name: '', email: '', username: '', role: 'EDITOR', canPublish: true, active: true, password: '' })}>
            Novo usuário
          </Button>
        }
      />
      {isLoading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-ink-100 text-left text-xs font-medium text-ink-500">
              <tr>
                <th className="px-5 py-3">Nome</th>
                <th className="px-5 py-3">Perfil</th>
                <th className="px-5 py-3">Último acesso</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data?.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-5 py-3">
                    <p className="font-medium text-ink-900">
                      {u.name} {u.id === me.id && <span className="text-xs font-normal text-ink-400">(você)</span>}
                    </p>
                    <p className="text-xs text-ink-500">
                      {u.email}
                      {u.username ? ` · ${u.username}` : ''}
                    </p>
                  </td>
                  <td className="px-5 py-3">
                    {u.role === 'ADMIN' ? <Badge tone="brand">Administrador</Badge> : <Badge>Editor{u.canPublish ? ' · publica' : ''}</Badge>}
                  </td>
                  <td className="px-5 py-3 text-ink-600">{relativeTime(u.lastLoginAt)}</td>
                  <td className="px-5 py-3">{u.active ? <Badge tone="green">Ativo</Badge> : <Badge tone="red">Desativado</Badge>}</td>
                  <td className="px-5 py-3 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setForm({ id: u.id, name: u.name, email: u.email, username: u.username ?? '', role: u.role, canPublish: u.canPublish, active: u.active, password: '' })}>
                      Editar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal
          open
          onClose={() => setForm(null)}
          title={form.id ? 'Editar usuário' : 'Novo usuário'}
          footer={
            <>
              <Button onClick={() => setForm(null)}>Cancelar</Button>
              <Button variant="primary" loading={saving} disabled={!form.name.trim() || (!form.id && (!form.email.trim() || !form.password))} onClick={save}>
                Salvar
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" className="sm:col-span-2">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="E-mail">
              <Input type="email" value={form.email} disabled={!!form.id} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Usuário" hint="Opcional, para login">
              <Input value={form.username} disabled={!!form.id} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
            <Field label="Perfil">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'ADMIN' | 'EDITOR' })}>
                <option value="EDITOR">Editor</option>
                <option value="ADMIN">Administrador</option>
              </Select>
            </Field>
            <Field label={form.id ? 'Nova senha' : 'Senha inicial'} hint="Mín. 10 caracteres, com 3 tipos (maiúsculas, minúsculas, números, símbolos).">
              <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={form.id ? 'Manter a atual' : ''} />
            </Field>
            {form.role === 'EDITOR' && (
              <div className="sm:col-span-2">
                <Switch checked={form.canPublish} onChange={(v) => setForm({ ...form, canPublish: v })} label="Pode publicar e controlar telões" description="Sem esta permissão, o editor apenas prepara rascunhos." />
              </div>
            )}
            {form.id && form.id !== me.id && (
              <div className="sm:col-span-2">
                <Switch checked={form.active} onChange={(v) => setForm({ ...form, active: v })} label="Acesso ativo" description="Desativar encerra as sessões do usuário imediatamente." />
              </div>
            )}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function SecuritySettings() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: Array<{ id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean }> }>('/api/auth/sessions') });

  const change = async () => {
    if (next !== confirmPw) {
      toast.error('A confirmação não confere com a nova senha.');
      return;
    }
    setSaving(true);
    try {
      await api('/api/auth/password', { body: { currentPassword: current, newPassword: next } });
      toast.success('Senha alterada. As demais sessões foram encerradas.');
      setCurrent('');
      setNext('');
      setConfirm('');
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const revokeOthers = async () => {
    try {
      const r = await api<{ revoked: number }>('/api/auth/sessions', { method: 'DELETE' });
      toast.success(`${r.revoked} sessão(ões) encerrada(s)`);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const browser = (ua: string | null) => {
    if (!ua) return 'Navegador desconhecido';
    const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${b}${os ? ` · ${os}` : ''}`;
  };

  return (
    <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader icon={<KeyRound />} title="Alterar senha" />
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void change();
          }}
        >
          <Field label="Senha atual">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="Nova senha" hint="Mín. 10 caracteres, com 3 tipos (maiúsculas, minúsculas, números, símbolos).">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirme a nova senha">
            <Input type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving} disabled={!current || !next || !confirmPw}>
              Alterar senha
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <CardHeader
          icon={<ShieldCheck />}
          title="Sessões ativas"
          actions={
            <Button size="sm" disabled={(sessions.data?.sessions.length ?? 0) <= 1} onClick={revokeOthers}>
              Encerrar as outras
            </Button>
          }
        />
        <ul className="divide-y divide-ink-100">
          {sessions.data?.sessions.map((s) => (
            <li key={s.id} className="px-5 py-3 text-[13px]">
              <p className="font-medium text-ink-800">
                {browser(s.userAgent)} {s.current && <Badge tone="green">esta sessão</Badge>}
              </p>
              <p className="text-xs text-ink-500">
                Desde {formatDateTime(s.createdAt)} · ativa {relativeTime(s.lastSeenAt)}
                {s.ip ? ` · ${s.ip}` : ''}
              </p>
            </li>
          ))}
        </ul>
        <div className="border-t border-ink-100 px-5 py-4 text-[13px] text-ink-600">
          Para revogar o acesso de um telão, abra <Link to="/admin/devices" className="font-medium text-brand-700 hover:underline">Telões</Link> → controle remoto → Administração do dispositivo.
        </div>
      </Card>
    </div>
  );
}
