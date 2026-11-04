import { CADENCES, TIMEZONES, type Cadence, type ScheduleDraft } from "@/fixtures/settings";

/** Field errors for a schedule draft. The page and the demo server share it, so their checks agree. */
export function validateSchedule(draft: ScheduleDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!CADENCES.some((c) => c.value === draft.cadence)) errors.cadence = "Choose one of the allowed cadences.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.localTime)) errors.localTime = "Enter a time as HH:MM, from 00:00 to 23:59.";
  if (!(TIMEZONES as readonly string[]).includes(draft.timezone)) errors.timezone = "Choose a listed time zone.";
  return errors;
}

const parts = (instant: number, timeZone: string) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), weekday: p.weekday as string };
};

/** The UTC instant at which a wall-clock time occurs in a zone, found by correcting for the zone's offset at that instant. */
function wallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, timeZone);
    guess += asUtc - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

/**
 * The next run of a draft schedule after `from`, with the daylight-saving policy applied:
 * a local time that doesn't exist (spring forward) runs at the next valid minute, and a repeated one (fall back) runs once, at its first occurrence.
 * Returns null when the draft is invalid. A derived value only: it proves nothing about whether the job will execute.
 */
export function nextRun(draft: ScheduleDraft, from: Date): { at: Date; label: string } | null {
  if (Object.keys(validateSchedule(draft)).length) return null;
  const [h, mi] = draft.localTime.split(":").map(Number) as [number, number];
  const today = parts(from.getTime(), draft.timezone);
  for (let offset = 0; offset < 9; offset++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + offset));
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(day);
    if (!runsOn(draft.cadence, weekday)) continue;
    let at = wallClockToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, draft.timezone);
    // A local time that doesn't exist (clocks go forward) resolves to an earlier instant; move it on by the missing time.
    const landed = parts(at, draft.timezone);
    if (landed.h !== h || landed.mi !== mi) at += (h * 60 + mi - (landed.h * 60 + landed.mi)) * 60_000;
    // Ambiguous local time (clocks go back): take the first of the two occurrences.
    const earlier = at - 3_600_000;
    const e = parts(earlier, draft.timezone);
    if (e.h === h && e.mi === mi && e.d === day.getUTCDate()) at = earlier;
    if (at > from.getTime()) {
      const label = new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(at));
      return { at: new Date(at), label };
    }
  }
  return null;
}

const runsOn = (cadence: Cadence, weekday: string) => (cadence === "daily" ? true : cadence === "weekdays" ? !["Sat", "Sun"].includes(weekday) : weekday === "Mon");

export const DST_POLICY = "Daylight saving: a time that doesn't exist when clocks go forward runs at the next valid minute. A time that repeats when clocks go back runs once, at its first occurrence.";
