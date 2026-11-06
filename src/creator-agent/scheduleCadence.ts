import { z } from "zod";

export const scheduleCadences = ["weekdays", "daily", "weekly-monday"] as const;
export const scheduleTimezones = ["America/Los_Angeles", "America/New_York", "UTC"] as const;
export const scheduleDraftSchema = z.object({ cadence: z.enum(scheduleCadences), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.enum(scheduleTimezones), activeCohortOverride: z.boolean() }).strict();
export type NativeScheduleDraft = z.infer<typeof scheduleDraftSchema>;
type EditableDraft = { cadence: string; localTime: string; timezone: string; activeCohortOverride: boolean };

export function validateSchedule(draft: EditableDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!scheduleCadences.some(value => value === draft.cadence)) errors.cadence = "Choose one of the allowed cadences.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.localTime)) errors.localTime = "Enter a time as HH:MM, from 00:00 to 23:59.";
  if (!scheduleTimezones.some(value => value === draft.timezone)) errors.timezone = "Choose a listed time zone.";
  return errors;
}
export const DST_POLICY = "Daylight saving: a skipped time runs at the next valid minute after the clock change. A repeated time runs once, at its first occurrence.";
const dayMs = 86400000;
const minuteMs = 60000;
const dateParts = (format: Intl.DateTimeFormat, at: number) => Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));

/** For the supported US zones and UTC, resolve the first occurrence, with spring gaps advancing to the first valid wall minute. */
export function nextRun(draft: EditableDraft, from: Date): { at: Date; label: string } | null {
  if (!scheduleDraftSchema.safeParse(draft).success || !Number.isFinite(from.getTime())) return null;
  const format = new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const today = dateParts(format, from.getTime());
  const localToday = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day));
  const [hour, minute] = draft.localTime.split(":").map(Number) as [number, number];
  const localStamp = (at: number) => { const p = dateParts(format, at); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!); };
  for (let days = 0; days < 9; days++) {
    const day = localToday + days * dayMs, weekday = new Date(day).getUTCDay();
    if (draft.cadence === "weekdays" && (weekday === 0 || weekday === 6) || draft.cadence === "weekly-monday" && weekday !== 1) continue;
    const wanted = day + (hour * 60 + minute) * minuteMs;
    const offsets = [...new Set([-dayMs, dayMs].map(delta => { const t = wanted + delta; return localStamp(t) - t; }))];
    const candidates = offsets.map(offset => wanted - offset).sort((a,b) => a-b);
    let at = candidates.find(t => localStamp(t) === wanted);
    if (at === undefined) {
      // The UTC instants bracket the missing local minute across the spring transition. Find the earliest real wall time after it.
      for (let t = candidates[0]!; t <= candidates[candidates.length - 1]!; t += minuteMs) if (localStamp(t) >= wanted) { at = t; break; }
    }
    if (at !== undefined && at > from.getTime()) {
      const label = new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
      return { at: new Date(at), label };
    }
  }
  return null;
}
const instant = z.string().datetime();
export const nativeScheduleDetailSchema = z.object({
  kind: z.literal("saved-schedule-draft"), source: z.literal("saved-operations"), jobId: z.string().min(1).max(1400), jobVersion: z.number().int().positive(),
  draftVersion: z.string().regex(/^j[1-9]\d*-d\d+$/), draft: scheduleDraftSchema.nullable(), savedForJobVersion: z.number().int().positive().nullable(),
  updatedAt: instant.nullable(), observedAt: instant, scheduleState: z.literal("disabled"),
  preview: z.object({ at: instant, label: z.string(), basis: z.literal("proposed-local-time"), asOf: instant }).strict().nullable(),
}).strict();
export type NativeScheduleDetail = z.infer<typeof nativeScheduleDetailSchema>;
