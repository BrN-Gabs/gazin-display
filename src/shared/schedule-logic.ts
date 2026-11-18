/**
 * Regras de agendamento (funções puras, testadas em tests/unit/schedule.test.ts).
 * Todos os horários são interpretados no fuso America/Sao_Paulo.
 */

export const TIMEZONE = 'America/Sao_Paulo';

export interface ScheduleRule {
  id: string;
  name: string;
  deviceId: string;
  playlistId: string;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;
  daysOfWeek: number[]; // 0=domingo
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  priority: number;
  enabled: boolean;
  createdAt: Date | string;
}

export interface LocalParts {
  date: string;
  dow: number;
  minutes: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz = TIMEZONE): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow: DOW[parts.weekday as string] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function toMinutes(hhmm: string) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateInRange(date: string, start: string | null, end: string | null) {
  return (!start || date >= start) && (!end || date <= end);
}

/** A janela começa em `startTime` do dia em que ocorre; se end <= start, termina no dia seguinte. start == end = 24h. */
export function isScheduleActive(rule: ScheduleRule, at: Date, tz = TIMEZONE) {
  if (!rule.enabled) return false;
  const now = localParts(at, tz);
  const s = toMinutes(rule.startTime);
  const e = toMinutes(rule.endTime);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  const days = new Set(rule.daysOfWeek);
  const occursOn = (date: string, dow: number) => days.has(dow) && dateInRange(date, rule.startDate, rule.endDate);

  if (s === e) return occursOn(now.date, now.dow);
  if (s < e) return occursOn(now.date, now.dow) && now.minutes >= s && now.minutes < e;
  // atravessa a meia-noite
  if (now.minutes >= s) return occursOn(now.date, now.dow);
  if (now.minutes < e) return occursOn(addDays(now.date, -1), (now.dow + 6) % 7);
  return false;
}

/** Maior prioridade vence; empate: o agendamento mais recente */
export function pickActiveSchedule<T extends ScheduleRule>(rules: T[], at: Date, tz = TIMEZONE): T | null {
  const active = rules.filter((r) => isScheduleActive(r, at, tz));
  active.sort((a, b) => b.priority - a.priority || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return active[0] ?? null;
}

const WEEK = 7 * 1440;
function weeklyIntervals(rule: ScheduleRule): Array<[number, number]> {
  const s = toMinutes(rule.startTime);
  const e = toMinutes(rule.endTime);
  const len = s === e ? 1440 : e > s ? e - s : 1440 - s + e;
  const out: Array<[number, number]> = [];
  for (const d of rule.daysOfWeek) {
    const start = d * 1440 + s;
    const end = start + len;
    if (end <= WEEK) out.push([start, end]);
    else {
      out.push([start, WEEK]);
      out.push([0, end - WEEK]);
    }
  }
  return out;
}

function datesOverlap(a: ScheduleRule, b: ScheduleRule) {
  // margem de 1 dia por causa de janelas que atravessam a meia-noite
  const startsBeforeEnd = (start: string | null, end: string | null) => !start || !end || start <= addDays(end, 1);
  return startsBeforeEnd(a.startDate, b.endDate) && startsBeforeEnd(b.startDate, a.endDate);
}

export function schedulesOverlap(a: ScheduleRule, b: ScheduleRule) {
  if (a.deviceId !== b.deviceId || !a.enabled || !b.enabled) return false;
  if (!datesOverlap(a, b)) return false;
  const ia = weeklyIntervals(a);
  const ib = weeklyIntervals(b);
  return ia.some(([s1, e1]) => ib.some(([s2, e2]) => s1 < e2 && s2 < e1));
}

export interface ScheduleConflict {
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  samePriority: boolean;
}

export function findConflicts(rules: ScheduleRule[]): ScheduleConflict[] {
  const out: ScheduleConflict[] = [];
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (schedulesOverlap(a, b)) out.push({ aId: a.id, bId: b.id, aName: a.name, bName: b.name, samePriority: a.priority === b.priority });
    }
  return out;
}
