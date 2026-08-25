/**
 * US equity market calendar.
 *
 * Deliberately self-contained and conservative: regular session only
 * (09:30–16:00 America/New_York, weekdays, minus a static holiday list). The
 * strategy does not trade extended hours in v1, so "open" here means "regular
 * session", and anything the calendar is unsure about is treated as closed.
 */
import type { Clock } from '../../core/index.js';
import type { MarketCalendarStatus } from '../../domain/types.js';

/** NYSE full-day closures. Extend as years are added. */
export const MARKET_HOLIDAYS: string[] = [
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
];

/** Early closes (13:00 ET). */
export const HALF_DAYS: string[] = ['2026-11-27', '2026-12-24', '2027-11-26'];

interface NyParts {
  date: string;
  weekday: number;
  minutesOfDay: number;
}

/**
 * Decompose an instant into New York local parts without pulling in a tz
 * library — Intl already ships the IANA database.
 */
export function newYorkParts(at: Date): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts['hour'] === '24' ? '0' : parts['hour']);
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    weekday: weekdayMap[parts['weekday'] ?? 'Mon'] ?? 1,
    minutesOfDay: hour * 60 + Number(parts['minute']),
  };
}

const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;
const HALF_DAY_CLOSE_MINUTES = 13 * 60;

export function isTradingDay(dateIso: string, weekday: number): boolean {
  if (weekday === 0 || weekday === 6) return false;
  return !MARKET_HOLIDAYS.includes(dateIso);
}

export function marketStatusAt(at: Date): MarketCalendarStatus {
  const { date, weekday, minutesOfDay } = newYorkParts(at);
  const tradingDay = isTradingDay(date, weekday);
  const close = HALF_DAYS.includes(date) ? HALF_DAY_CLOSE_MINUTES : CLOSE_MINUTES;
  const isOpen = tradingDay && minutesOfDay >= OPEN_MINUTES && minutesOfDay < close;

  let reason: string;
  if (!tradingDay) reason = weekday === 0 || weekday === 6 ? 'Weekend' : `Market holiday (${date})`;
  else if (minutesOfDay < OPEN_MINUTES) reason = 'Pre-market';
  else if (minutesOfDay >= close) reason = 'After hours';
  else reason = 'Regular session';

  return {
    isOpen,
    asOf: at.toISOString(),
    nextOpen: isOpen ? null : nextOpenIso(at),
    nextClose: isOpen ? sameDayIso(at, close) : null,
    reason,
  };
}

export function marketStatus(clock: Clock): MarketCalendarStatus {
  return marketStatusAt(clock.now());
}

function sameDayIso(at: Date, minutesOfDay: number): string {
  const { minutesOfDay: current } = newYorkParts(at);
  return new Date(at.getTime() + (minutesOfDay - current) * 60_000).toISOString();
}

function nextOpenIso(at: Date): string {
  let cursor = at;
  for (let i = 0; i < 14; i += 1) {
    const parts = newYorkParts(cursor);
    if (isTradingDay(parts.date, parts.weekday) && parts.minutesOfDay < OPEN_MINUTES) {
      return sameDayIso(cursor, OPEN_MINUTES);
    }
    // Advance to ~00:05 New York on the following day.
    const p = newYorkParts(cursor);
    cursor = new Date(cursor.getTime() + (24 * 60 - p.minutesOfDay + 5) * 60_000);
  }
  return cursor.toISOString();
}

/** Whole trading days between two instants; used for forward-return horizons. */
export function tradingDaysBetween(from: Date, to: Date): number {
  let count = 0;
  let cursor = new Date(from.getTime());
  while (cursor.getTime() < to.getTime() && count < 400) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const p = newYorkParts(cursor);
    if (isTradingDay(p.date, p.weekday)) count += 1;
  }
  return count;
}
