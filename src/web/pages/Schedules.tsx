import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Plus, Trash } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { WEEKDAYS, describeDays, formatDate } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Switch, cn, useConfirm } from '../components/ui';
import { toMinutes } from '../../shared/schedule-logic';

interface ScheduleRow {
  id: string;
  name: string;
  device: { id: string; name: string };
  playlist: { id: string; name: string; published: boolean };
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priority: number;
  enabled: boolean;
  activeNow: boolean;
  createdBy: string | null;
}

interface FormState {
  id?: string;
  name: string;
  deviceId: string;
  playlistId: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  startDate: string;
  endDate: string;
  priority: number;
  enabled: boolean;
}

const COLORS = ['bg-brand-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-600'];

export default function Schedules() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ['schedules'], queryFn: () => api<{ schedules: ScheduleRow[]; conflicts: Array<{ aId: string; bId: string; aName: string; bName: string; samePriority: boolean }>; timezone: string }>('/api/schedules'), refetchInterval: 60_000 });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<{ devices: Array<{ id: string; name: string; playlist: { name: string } | null }> }>('/api/devices') });
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: Array<{ id: string; name: string; latestVersion: { number: number } | null }> }>('/api/playlists') });
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const colorOf = useMemo(() => {
    const ids = [...new Set((data?.schedules ?? []).map((s) => s.playlist.id))];
    return (playlistId: string) => COLORS[ids.indexOf(playlistId) % COLORS.length]!;
  }, [data]);

  const openNew = () =>
    setForm({ name: '', deviceId: devices.data?.devices[0]?.id ?? '', playlistId: '', daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00', startDate: '', endDate: '', priority: 10, enabled: true });

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const body = { name: form.name.trim(), deviceId: form.deviceId, playlistId: form.playlistId, daysOfWeek: form.daysOfWeek, startTime: form.startTime, endTime: form.endTime, startDate: form.startDate || null, endDate: form.endDate || null, priority: form.priority, enabled: form.enabled };
      const r = await api<{ overlaps: Array<{ name: string }> }>(form.id ? `/api/schedules/${form.id}` : '/api/schedules', { method: form.id ? 'PUT' : 'POST', body });
      toast.success(form.id ? 'Agendamento atualizado' : 'Agendamento criado');
      if (r.overlaps.length) toast.info(`Sobrepõe-se a: ${r.overlaps.map((o) => o.name).join(', ')}. Vale o de maior prioridade.`);
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: ScheduleRow) => {
    if (!(await confirm({ title: `Cancelar "${s.name}"?`, description: 'O agendamento será removido. Se estiver ativo, o telão volta à programação padrão.', confirmLabel: 'Cancelar agendamento' }))) return;
    try {
      await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
      toast.success('Agendamento cancelado');
      void qc.invalidateQueries({ queryKey: ['schedules'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const byDevice = new Map<string, ScheduleRow[]>();
  for (const s of data?.schedules ?? []) byDevice.set(s.device.id, [...(byDevice.get(s.device.id) ?? []), s]);

  return (
    <div>
      <PageHeader
        title="Programação"
        description={`Agende playlists por dia e horário (fuso ${data?.timezone ?? 'America/Sao_Paulo'}). Fora dos agendamentos, vale a playlist padrão do telão.`}
        actions={
          user.canPublish && (
            <Button variant="primary" icon={<Plus />} onClick={openNew} disabled={!devices.data?.devices.length}>
              Novo agendamento
            </Button>
          )
        }
      />
      {data?.conflicts.some((c) => c.samePriority) && (
        <Alert tone="red" className="mb-4" title="Conflitos de horário">
          {data.conflicts
            .filter((c) => c.samePriority)
            .map((c) => `“${c.aName}” × “${c.bName}”`)
            .join('; ')}
        </Alert>
      )}
      {data?.conflicts.some((c) => !c.samePriority) && (
        <Alert tone="brand" className="mb-4" title="Sobreposições resolvidas por prioridade">
          {data.conflicts
            .filter((c) => !c.samePriority)
            .map((c) => `“${c.aName}” × “${c.bName}”`)
            .join('; ')}
          . Nos horários em comum, vale o agendamento de maior prioridade.
        </Alert>
      )}

      {isLoading ? (
        <Loading />
      ) : !data?.schedules.length ? (
        <Card>
          <EmptyState icon={<CalendarClock />} title="Nenhum agendamento" description="Exemplo: Playlist Institucional de segunda a sexta, 08:00–18:00; Playlist de Campanha em um período promocional." action={user.canPublish && devices.data?.devices.length ? <Button variant="primary" icon={<Plus />} onClick={openNew}>Criar agendamento</Button> : undefined} />
        </Card>
      ) : (
        <div className="space-y-6">
          {[...byDevice.entries()].map(([deviceId, list]) => (
            <Card key={deviceId}>
              <CardHeader title={list[0]!.device.name} description={`Padrão fora dos agendamentos: ${devices.data?.devices.find((d) => d.id === deviceId)?.playlist?.name ?? 'nenhuma playlist'}`} />
              <WeekTimeline schedules={list} colorOf={colorOf} />
              <ul className="divide-y divide-ink-100 border-t border-ink-100">
                {list.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <span className={cn('h-8 w-1.5 shrink-0 rounded-full', colorOf(s.playlist.id))} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                        {s.name} {s.activeNow && <Badge tone="green" dot>Ativo agora</Badge>} {!s.enabled && <Badge>Desativado</Badge>}
                      </p>
                      <p className="text-xs text-ink-500">
                        {s.playlist.name} · {describeDays(s.daysOfWeek)} · {s.startTime === s.endTime ? 'dia inteiro' : `${s.startTime}–${s.endTime}`}
                        {s.startDate || s.endDate ? ` · ${s.startDate ? formatDate(`${s.startDate}T12:00:00`) : '…'} a ${s.endDate ? formatDate(`${s.endDate}T12:00:00`) : '…'}` : ''} · prioridade {s.priority}
                      </p>
                    </div>
                    {user.canPublish && (
                      <div className="flex gap-1">
                        <Button size="icon-sm" variant="ghost" title="Editar" onClick={() => setForm({ id: s.id, name: s.name, deviceId: s.device.id, playlistId: s.playlist.id, daysOfWeek: s.daysOfWeek, startTime: s.startTime, endTime: s.endTime, startDate: s.startDate ?? '', endDate: s.endDate ?? '', priority: s.priority, enabled: s.enabled })}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" title="Cancelar agendamento" onClick={() => remove(s)}>
                          <Trash />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {form && (
        <Modal
          open
          onClose={() => setForm(null)}
          title={form.id ? 'Editar agendamento' : 'Novo agendamento'}
          size="lg"
          footer={
            <>
              <Button onClick={() => setForm(null)}>Cancelar</Button>
              <Button variant="primary" loading={saving} disabled={!form.name.trim() || !form.deviceId || !form.playlistId || !form.daysOfWeek.length} onClick={save}>
                Salvar agendamento
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" className="sm:col-span-2">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Institucional — expediente" maxLength={120} />
            </Field>
            <Field label="Telão">
              <Select value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
                {devices.data?.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Playlist" hint="Usa sempre a última versão publicada da playlist.">
              <Select value={form.playlistId} onChange={(e) => setForm({ ...form, playlistId: e.target.value })}>
                <option value="">Selecione…</option>
                {playlists.data?.playlists.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.latestVersion}>
                    {p.name}
                    {p.latestVersion ? '' : ' (nunca publicada)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Dias da semana" className="sm:col-span-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {WEEKDAYS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setForm({ ...form, daysOfWeek: form.daysOfWeek.includes(i) ? form.daysOfWeek.filter((x) => x !== i) : [...form.daysOfWeek, i].sort() })}
                    className={cn('h-8 w-11 rounded-md border text-[13px] font-medium transition', form.daysOfWeek.includes(i) ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50')}
                  >
                    {d}
                  </button>
                ))}
                <span className="mx-1 text-ink-300">|</span>
                <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, daysOfWeek: [1, 2, 3, 4, 5] })}>
                  Dias úteis
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] })}>
                  Todos
                </Button>
              </div>
            </Field>
            <Field label="Início" hint="Horário de Brasília">
              <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            </Field>
            <Field label="Término" hint="Fim antes do início = atravessa a meia-noite. Iguais = dia inteiro.">
              <Input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </Field>
            <Field label="Data inicial" hint="Opcional (vazio = desde já)">
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </Field>
            <Field label="Data final" hint="Opcional (vazio = sem fim)">
              <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </Field>
            <Field label="Prioridade (1–100)" hint="Em horários sobrepostos vale a maior. Mesma prioridade sobreposta não é permitida.">
              <Input type="number" min={1} max={100} value={form.priority} onChange={(e) => setForm({ ...form, priority: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
            </Field>
            <div className="flex items-end pb-1">
              <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Agendamento ativo" />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Visualização semanal (0h–24h) dos agendamentos de um telão */
function WeekTimeline({ schedules, colorOf }: { schedules: ScheduleRow[]; colorOf: (playlistId: string) => string }) {
  const blocks: Array<{ day: number; start: number; end: number; s: ScheduleRow }> = [];
  for (const s of schedules.filter((x) => x.enabled)) {
    const a = toMinutes(s.startTime);
    const b = toMinutes(s.endTime);
    for (const d of s.daysOfWeek) {
      if (a === b) blocks.push({ day: d, start: 0, end: 1440, s });
      else if (a < b) blocks.push({ day: d, start: a, end: b, s });
      else {
        blocks.push({ day: d, start: a, end: 1440, s });
        blocks.push({ day: (d + 1) % 7, start: 0, end: b, s });
      }
    }
  }
  return (
    <div className="overflow-x-auto px-5 py-4">
      <div className="min-w-[640px]">
        <div className="ml-12 flex justify-between pb-1 text-[10.5px] text-ink-400">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
            <span key={h}>{String(h).padStart(2, '0')}h</span>
          ))}
        </div>
        {[1, 2, 3, 4, 5, 6, 0].map((day) => (
          <div key={day} className="flex items-center gap-2 py-0.5">
            <span className="w-10 text-right text-xs text-ink-500">{WEEKDAYS[day]}</span>
            <div className="relative h-6 flex-1 rounded bg-ink-100">
              {blocks
                .filter((b) => b.day === day)
                .sort((x, y) => x.s.priority - y.s.priority)
                .map((b, i) => (
                  <div
                    key={i}
                    title={`${b.s.name} · ${b.s.playlist.name} · prioridade ${b.s.priority}`}
                    className={cn('absolute inset-y-0.5 rounded-sm opacity-85', colorOf(b.s.playlist.id))}
                    style={{ left: `${(b.start / 1440) * 100}%`, width: `${((b.end - b.start) / 1440) * 100}%` }}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
