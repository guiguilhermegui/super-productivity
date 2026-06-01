import { getDbDateStr } from './get-db-date-str';

// An interval longer than this is almost certainly malformed input; cap the loop
// so bad data can never spin forever (one iteration per day covered).
const MAX_DAYS = 1100;

/**
 * Splits the interval `[endTimeStamp - durationMs, endTimeStamp]` across the
 * "logical days" it spans, returning a `{ dateStr: ms }` map.
 *
 * The logical-day boundary is shifted by `startOfNextDayDiff` (the configurable
 * start-of-next-day offset), matching how the time tracker attributes ticks to
 * days (see `DateService.todayStr`).
 *
 * Used when a single time interval is logged retroactively (e.g. assigning idle
 * time to a task) so that an interval crossing midnight is attributed to each
 * day it actually covers instead of dumping it all onto "today" (issue #3888).
 */
export const splitTimeSpentByDay = (
  endTimeStamp: number,
  durationMs: number,
  startOfNextDayDiff: number = 0,
): { [dateStr: string]: number } => {
  const result: { [dateStr: string]: number } = {};
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return result;
  }

  let remaining = durationMs;
  let cursorEnd = endTimeStamp;
  let guard = 0;

  while (remaining > 0 && guard < MAX_DAYS) {
    guard++;
    // The day this chunk belongs to is the one containing its last ms. Probing
    // `cursorEnd - 1` keeps an interval that ends exactly on a boundary on the
    // previous day (where it was actually worked).
    const shifted = new Date(cursorEnd - 1 - startOfNextDayDiff);
    const dateStr = getDbDateStr(shifted);

    // Real-time start of that logical day = local midnight of `shifted` + offset.
    const localMidnight = new Date(shifted);
    localMidnight.setHours(0, 0, 0, 0);
    const startOfLogicalDayMs = localMidnight.getTime() + startOfNextDayDiff;

    const availableInDay = cursorEnd - startOfLogicalDayMs;
    const take = Math.min(remaining, availableInDay);
    result[dateStr] = (result[dateStr] || 0) + take;

    remaining -= take;
    cursorEnd = startOfLogicalDayMs;
  }

  return result;
};
