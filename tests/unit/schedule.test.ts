import { describe, expect, it } from 'vitest';
import { findConflicts, isScheduleActive, localParts, pickActiveSchedule, schedulesOverlap, type ScheduleRule } from '../../src/shared/schedule-logic.js';

const base: ScheduleRule = {
  id: 'a',
  name: 'Institucional',
  deviceId: 'd1',
  playlistId: 'p1',
  startDate: null,
  endDate: null,
  daysOfWeek: [1, 2, 3, 4, 5],
  startTime: '08:00',
  endTime: '18:00',
  priority: 10,
  enabled: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

// 2026-11-18 é quarta-feira. São Paulo = UTC-3 (sem horário de verão).
const at = (iso: string) => new Date(iso);

describe('localParts', () => {
  it('converte para America/Sao_Paulo', () => {
    expect(localParts(at('2026-11-18T13:30:00Z'))).toEqual({ date: '2026-11-18', dow: 3, minutes: 10 * 60 + 30 });
    // 02:00 UTC de quinta = 23:00 de quarta em SP
    expect(localParts(at('2026-11-19T02:00:00Z'))).toEqual({ date: '2026-11-18', dow: 3, minutes: 23 * 60 });
  });
});

describe('isScheduleActive', () => {
  it('respeita dias úteis e horário de expediente', () => {
    expect(isScheduleActive(base, at('2026-11-18T13:00:00Z'))).toBe(true); // qua 10:00
    expect(isScheduleActive(base, at('2026-11-18T22:00:00Z'))).toBe(false); // qua 19:00
    expect(isScheduleActive(base, at('2026-11-21T13:00:00Z'))).toBe(false); // sáb
    expect(isScheduleActive(base, at('2026-11-18T11:00:00Z'))).toBe(true); // 08:00 exato (início inclusivo)
    expect(isScheduleActive(base, at('2026-11-18T21:00:00Z'))).toBe(false); // 18:00 exato (fim exclusivo)
  });

  it('respeita o período (datas)', () => {
    const campanha = { ...base, startDate: '2026-11-20', endDate: '2026-11-30', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
    expect(isScheduleActive(campanha, at('2026-11-18T13:00:00Z'))).toBe(false);
    expect(isScheduleActive(campanha, at('2026-11-25T13:00:00Z'))).toBe(true);
    expect(isScheduleActive(campanha, at('2026-12-01T13:00:00Z'))).toBe(false);
  });

  it('suporta janela atravessando a meia-noite', () => {
    const noite = { ...base, daysOfWeek: [3], startTime: '22:00', endTime: '02:00' };
    expect(isScheduleActive(noite, at('2026-11-19T01:30:00Z'))).toBe(true); // qua 22:30
    expect(isScheduleActive(noite, at('2026-11-19T04:30:00Z'))).toBe(true); // qui 01:30 (começou na quarta)
    expect(isScheduleActive(noite, at('2026-11-19T05:30:00Z'))).toBe(false); // qui 02:30
    expect(isScheduleActive(noite, at('2026-11-20T04:30:00Z'))).toBe(false); // sex 01:30 (quinta não está nos dias)
  });

  it('start == end significa o dia inteiro', () => {
    const dia = { ...base, startTime: '00:00', endTime: '00:00' };
    expect(isScheduleActive(dia, at('2026-11-18T03:05:00Z'))).toBe(true); // qua 00:05
    expect(isScheduleActive(dia, at('2026-11-19T02:59:00Z'))).toBe(true); // qua 23:59
  });

  it('agendamento desativado nunca fica ativo', () => {
    expect(isScheduleActive({ ...base, enabled: false }, at('2026-11-18T13:00:00Z'))).toBe(false);
  });
});

describe('pickActiveSchedule', () => {
  it('maior prioridade vence; empate fica com o mais recente', () => {
    const evento = { ...base, id: 'b', name: 'Evento', priority: 50, daysOfWeek: [3], startTime: '09:00', endTime: '12:00' };
    const outro = { ...base, id: 'c', name: 'Outro', createdAt: new Date('2026-06-01T00:00:00Z') };
    expect(pickActiveSchedule([base, evento, outro], at('2026-11-18T13:00:00Z'))?.id).toBe('b');
    expect(pickActiveSchedule([base, outro], at('2026-11-18T13:00:00Z'))?.id).toBe('c');
    expect(pickActiveSchedule([base], at('2026-11-21T13:00:00Z'))).toBeNull();
  });
});

describe('conflitos', () => {
  it('detecta sobreposição no mesmo telão', () => {
    const b = { ...base, id: 'b', name: 'B', daysOfWeek: [3], startTime: '17:00', endTime: '19:00' };
    expect(schedulesOverlap(base, b)).toBe(true);
    expect(schedulesOverlap(base, { ...b, startTime: '18:00', endTime: '19:00' })).toBe(false);
    expect(schedulesOverlap(base, { ...b, deviceId: 'd2' })).toBe(false);
    expect(schedulesOverlap(base, { ...b, startDate: '2027-01-01', endDate: '2027-01-31', daysOfWeek: [3] })).toBe(true);
    const past = { ...base, startDate: '2026-01-01', endDate: '2026-01-31' };
    expect(schedulesOverlap(past, { ...b, startDate: '2026-03-01', endDate: '2026-03-31' })).toBe(false);
    const c = findConflicts([base, b]);
    expect(c).toHaveLength(1);
    expect(c[0]!.samePriority).toBe(true);
  });

  it('detecta conflito com janela noturna de sábado para domingo', () => {
    const sab = { ...base, id: 's', daysOfWeek: [6], startTime: '23:00', endTime: '03:00' };
    const dom = { ...base, id: 'd', daysOfWeek: [0], startTime: '01:00', endTime: '02:00' };
    expect(schedulesOverlap(sab, dom)).toBe(true);
  });
});
