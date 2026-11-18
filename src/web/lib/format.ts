export function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDurationLong(ms: number) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', s || (!h && !m) ? `${s} s` : ''].filter(Boolean).join(' ');
}

const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const df = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' });
const tf = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium', timeZone: 'America/Sao_Paulo' });

export const formatDateTime = (d: string | Date | null | undefined) => (d ? dtf.format(new Date(d)) : '—');
export const formatDate = (d: string | Date | null | undefined) => (d ? df.format(new Date(d)) : '—');
export const formatTime = (d: string | Date | null | undefined) => (d ? tf.format(new Date(d)) : '—');

export function relativeTime(d: string | Date | null | undefined, now = Date.now()) {
  if (!d) return 'nunca';
  const diff = Math.round((now - new Date(d).getTime()) / 1000);
  if (diff < 10) return 'agora';
  if (diff < 60) return `há ${diff} s`;
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `há ${Math.floor(diff / 86400)} dia(s)`;
  return formatDateTime(d);
}

export const resolution = (w?: number | null, h?: number | null) => (w && h ? `${w}×${h}` : '—');

export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const WEEKDAYS_LONG = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export function describeDays(days: number[]) {
  const s = [...days].sort().join(',');
  if (s === '0,1,2,3,4,5,6') return 'Todos os dias';
  if (s === '1,2,3,4,5') return 'Segunda a sexta';
  if (s === '0,6') return 'Fins de semana';
  return [...days].sort().map((d) => WEEKDAYS[d]).join(', ');
}
