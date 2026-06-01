/* eslint-disable @typescript-eslint/naming-convention */
import { splitTimeSpentByDay } from './split-time-spent-by-day';

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const hm = (h: number, m: number): number => h * H + m * M; // eslint-disable-line no-mixed-operators

// Helper: local-time timestamp for a given Y-M-D hh:mm (so tests are TZ-agnostic).
const ts = (y: number, mo: number, d: number, h = 0, min = 0): number =>
  new Date(y, mo - 1, d, h, min, 0, 0).getTime();

describe('splitTimeSpentByDay', () => {
  it('keeps a same-day interval on a single day', () => {
    const end = ts(2026, 6, 1, 16, 0); // 16:00
    const result = splitTimeSpentByDay(end, 2 * H);
    expect(result).toEqual({ '2026-06-01': 2 * H });
  });

  it('splits an interval that crosses midnight across both days', () => {
    // Worked from 22:00 (May 31) until 02:00 (Jun 1) => 4h total.
    const end = ts(2026, 6, 1, 2, 0); // 02:00 Jun 1
    const result = splitTimeSpentByDay(end, 4 * H);
    expect(result).toEqual({
      '2026-05-31': 2 * H, // 22:00 -> 24:00
      '2026-06-01': 2 * H, // 00:00 -> 02:00
    });
  });

  it('matches the issue #3888 scenario (away overnight, assigned next morning)', () => {
    // Walked away 18:30 (May 31), returned and logged at 08:00 (Jun 1): 13.5h.
    const end = ts(2026, 6, 1, 8, 0);
    const result = splitTimeSpentByDay(end, hm(13, 30));
    expect(result['2026-05-31']).toBe(hm(5, 30)); // 18:30 -> 24:00
    expect(result['2026-06-01']).toBe(8 * H); // 00:00 -> 08:00
  });

  it('spreads across three days for a long interval', () => {
    const end = ts(2026, 6, 3, 6, 0); // 06:00 Jun 3
    const result = splitTimeSpentByDay(end, 48 * H); // 06:00 Jun 1 -> 06:00 Jun 3
    expect(result['2026-06-01']).toBe(18 * H); // 06:00 -> 24:00
    expect(result['2026-06-02']).toBe(24 * H); // full day
    expect(result['2026-06-03']).toBe(6 * H); // 00:00 -> 06:00
  });

  it('respects the start-of-next-day offset (logical day boundary)', () => {
    // With a 4h offset the logical day starts at 04:00. An interval from
    // 02:00 to 06:00 on Jun 1 straddles the logical boundary: 02:00-04:00
    // belongs to the previous logical day (May 31), 04:00-06:00 to Jun 1.
    const end = ts(2026, 6, 1, 6, 0);
    const result = splitTimeSpentByDay(end, 4 * H, 4 * H);
    expect(result['2026-05-31']).toBe(2 * H);
    expect(result['2026-06-01']).toBe(2 * H);
  });

  it('attributes the whole interval to today when it does not cross a boundary (offset)', () => {
    const end = ts(2026, 6, 1, 10, 0);
    const result = splitTimeSpentByDay(end, 2 * H, 4 * H); // 08:00 -> 10:00, both after 04:00
    expect(result).toEqual({ '2026-06-01': 2 * H });
  });

  it('returns an empty map for zero or negative duration', () => {
    const end = ts(2026, 6, 1, 12, 0);
    expect(splitTimeSpentByDay(end, 0)).toEqual({});
    expect(splitTimeSpentByDay(end, -5 * H)).toEqual({});
  });

  it('ignores non-finite durations', () => {
    const end = ts(2026, 6, 1, 12, 0);
    expect(splitTimeSpentByDay(end, NaN)).toEqual({});
    expect(splitTimeSpentByDay(end, Infinity)).toEqual({});
  });

  it('attributes an interval ending exactly at midnight to the previous day', () => {
    const end = ts(2026, 6, 1, 0, 0); // exactly 00:00 Jun 1
    const result = splitTimeSpentByDay(end, 2 * H);
    expect(result).toEqual({ '2026-05-31': 2 * H }); // 22:00 -> 24:00 May 31
  });

  it('sums to the original duration', () => {
    const end = ts(2026, 6, 2, 3, 17);
    const duration = hm(11, 42);
    const result: { [dateStr: string]: number } = splitTimeSpentByDay(end, duration);
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    expect(total).toBe(duration);
  });
});
