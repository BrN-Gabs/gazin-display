import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, PageHeader, Select } from '../components/ui';

interface Entry {
  id: string;
  action: string;
  summary: string;
  details: unknown;
  createdAt: string;
  user: string | null;
  device: string | null;
  ip: string | null;
}

const CATEGORIES: Array<{ value: string; label: string; tone: 'brand' | 'green' | 'amber' | 'red' | 'violet' | 'neutral' }> = [
  { value: 'auth.', label: 'Acesso', tone: 'neutral' },
  { value: 'media.', label: 'Mídias', tone: 'brand' },
  { value: 'playlist.', label: 'Playlists', tone: 'violet' },
  { value: 'playlist.published', label: 'Publicações', tone: 'green' },
  { value: 'device.command', label: 'Comandos remotos', tone: 'amber' },
  { value: 'device.', label: 'Telões', tone: 'brand' },
  { value: 'schedule.', label: 'Programação', tone: 'violet' },
  { value: 'settings.', label: 'Configurações', tone: 'neutral' },
  { value: 'user.', label: 'Usuários', tone: 'neutral' },
];

function categoryOf(action: string) {
  if (action === 'playlist.published') return CATEGORIES[3]!;
  if (action === 'device.command') return CATEGORIES[4]!;
  if (/error|failed/.test(action)) return { label: 'Erro', tone: 'red' as const };
  return CATEGORIES.find((c) => c.value.endsWith('.') && action.startsWith(c.value)) ?? { label: action, tone: 'neutral' as const };
}

export default function History() {
  const [filters, setFilters] = useState({ from: '', to: '', userId: '', action: '', deviceId: '' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['users', 'options'], queryFn: () => api<{ users: Array<{ id: string; name: string }> }>('/api/users/options') });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<{ devices: Array<{ id: string; name: string }> }>('/api/devices') });
  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const { data, isLoading, isFetching } = useQuery({ queryKey: ['audit', params.toString()], queryFn: () => api<{ total: number; entries: Entry[]; pageSize: number }>(`/api/audit?${params}`), placeholderData: keepPreviousData });
  const set = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <PageHeader title="Histórico" description="Registro das operações: envios, publicações, comandos, conexões e erros dos telões." />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="De">
          <Input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        </Field>
        <Field label="Até">
          <Input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </Field>
        <Field label="Usuário">
          <Select value={filters.userId} onChange={(e) => set('userId', e.target.value)}>
            <option value="">Todos</option>
            {users.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tipo de ação">
          <Select value={filters.action} onChange={(e) => set('action', e.target.value)}>
            <option value="">Todas</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            <option value="device.playback_error">Erros de reprodução</option>
          </Select>
        </Field>
        <Field label="Telão">
          <Select value={filters.deviceId} onChange={(e) => set('deviceId', e.target.value)}>
            <option value="">Todos</option>
            {devices.data?.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Card className="overflow-hidden">
        {isLoading ? (
          <Loading />
        ) : !data?.entries.length ? (
          <EmptyState icon={<ScrollText />} title="Nenhum registro encontrado" description="Ajuste os filtros." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs font-medium text-ink-500">
                <tr>
                  <th className="px-4 py-3">Data e hora</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Descrição</th>
                  <th className="px-4 py-3">Usuário / Telão</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.entries.map((e) => {
                  const c = categoryOf(e.action);
                  return (
                    <Fragment key={e.id}>
                      <tr className="cursor-pointer align-top hover:bg-ink-50" onClick={() => setOpen(open === e.id ? null : e.id)}>
                        <td className="tabular px-4 py-2.5 whitespace-nowrap text-ink-600">{formatDateTime(e.createdAt)}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={c.tone}>{c.label}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-ink-800">{e.summary}</td>
                        <td className="px-4 py-2.5 text-ink-600">{e.user ?? e.device ?? 'Sistema'}</td>
                      </tr>
                      {open === e.id && (
                        <tr className="bg-ink-50/60">
                          <td colSpan={4} className="px-4 py-3">
                            <div className="text-xs text-ink-500">
                              Ação: <code className="font-mono">{e.action}</code>
                              {e.ip ? ` · IP ${e.ip}` : ''}
                            </div>
                            {e.details ? <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-white p-3 font-mono text-[11.5px] text-ink-700 ring-1 ring-ink-200">{JSON.stringify(e.details, null, 2)}</pre> : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-ink-100 px-4 py-3 text-[13px] text-ink-500">
          <span>
            {data?.total ?? 0} registro(s) {isFetching && '· atualizando…'}
          </span>
          <div className="flex items-center gap-2">
            <Button size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Página anterior">
              <ChevronLeft />
            </Button>
            <span className="tabular">
              {page} / {pages}
            </span>
            <Button size="icon-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Próxima página">
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
