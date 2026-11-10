import type { CheckSchedule } from "./contract.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timezone, f);
  }
  return f;
}

function wallClock(timezone: string, at: number) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour),
    minute: Number(parts.minute), second: Number(parts.second) };
}

/** Local minus UTC, in milliseconds, at an instant. */
function offset(timezone: string, at: number) {
  const w = wallClock(timezone, at);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000;
}

/** The instant a local wall time occurs in a timezone. Two passes settle the offset across a DST change. */
export function localInstant(timezone: string, date: string, minutes = 0): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const first = naive - offset(timezone, naive);
  return naive - offset(timezone, first);
}

export function localDateAt(timezone: string, at: number): string {
  const w = wallClock(timezone, at);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The period window for one local day, and the cutoff after which it may be checked. */
export function periodWindow(schedule: Pick<CheckSchedule, "timezone" | "cutoffLagMinutes">, date: string) {
  const startAt = localInstant(schedule.timezone, date), endAt = localInstant(schedule.timezone, shiftDate(date, 1));
  return { startAt, endAt, cutoff: endAt + schedule.cutoffLagMinutes * MINUTE };
}

/** The periods a run at `at` should check: up to `coverage.lookbackDays` past local days whose cutoff has passed, oldest first. */
export function duePeriods(schedule: CheckSchedule, at: number): string[] {
  const today = localDateAt(schedule.timezone, at), due: string[] = [];
  // A long cutoff lag can push the newest due day back by up to a week.
  for (let back = 1; due.length < schedule.coverage.lookbackDays && back <= schedule.coverage.lookbackDays + 8; back++) {
    const date = shiftDate(today, -back);
    if (periodWindow(schedule, date).cutoff <= at) due.push(date);
  }
  return due.reverse();
}

/** The next scheduled check strictly after `at`, at the schedule's local `runAt`. */
export function nextRunAt(schedule: CheckSchedule, at: number): number {
  const [h, m] = schedule.runAt.split(":").map(Number) as [number, number];
  const today = localDateAt(schedule.timezone, at);
  for (let ahead = 0; ahead < 3; ahead++) {
    const candidate = localInstant(schedule.timezone, shiftDate(today, ahead), h * 60 + m);
    if (candidate > at) return candidate;
  }
  throw new Error("No next run within three days.");
}
