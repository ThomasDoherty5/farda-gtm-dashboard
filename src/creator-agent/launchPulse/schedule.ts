import { z } from "zod";
import { analyticsRefSchema } from "../analytics/contract.ts";
import { instantSchema } from "../analytics/sources.ts";
import { nextRun } from "../scheduleCadence.ts";

export const launchPulseTimezone = "America/Los_Angeles";
export const launchPulsePrefix = "launch-pulse:";
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const interpretation = z.enum(["elapsed72Hours", "throughLPlus3"]);
const hourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: launchPulseTimezone, hour: "2-digit", hourCycle: "h23",
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: launchPulseTimezone, year: "numeric", month: "2-digit", day: "2-digit",
});
const iso = (time: number) => new Date(time).toISOString();

export function launchPacificDay(time: number) {
  const parts = dateFormatter.formatToParts(new Date(time));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

function midnight(day: string, days = 0) {
  const anchor = Date.parse(day + "T00:00:00Z") + days * dayMs;
  return nextRun({ cadence: "daily", localTime: "00:00", timezone: launchPulseTimezone,
    activeCohortOverride: false }, new Date(anchor))?.at.getTime() ?? NaN;
}

export const approvedLaunchWindowSchema = z.object({
  version: analyticsRefSchema.max(160), approvalRef: analyticsRefSchema, ownerRef: analyticsRefSchema,
  approvedAt: instantSchema, startsAt: instantSchema, endsAt: instantSchema,
  timezone: z.literal(launchPulseTimezone),
  interpretation,
  enabled: z.boolean(),
}).strict().refine(value => {
  const start = Date.parse(value.startsAt), end = Date.parse(value.endsAt);
  const boundary = value.interpretation === "elapsed72Hours" ? start + 72 * hourMs : midnight(launchPacificDay(start), 4);
  return Date.parse(value.approvedAt) < end && end === boundary && end > start;
}, "The approved launch window needs one exact end boundary.");
export type ApprovedLaunchWindow = z.infer<typeof approvedLaunchWindowSchema>;

export const pulseSlotSchema = z.object({
  scheduledAt: instantSchema, timezone: z.literal(launchPulseTimezone), hourStart: instantSchema,
  todayStart: instantSchema, launchStart: instantSchema, launchEnd: instantSchema,
  interpretation,
}).strict();
export type PulseSlot = z.infer<typeof pulseSlotSchema>;

export function duringLaunchReportingHours(at: number) {
  if (!Number.isFinite(at)) return false;
  const hour = Number(hourFormatter.format(new Date(at)));
  return hour >= 7 && hour <= 23;
}

/** The source supplies an approved window. A missed tick can reuse the original eligible hourly bucket while the window is open. */
export function launchPulseSlot(window: ApprovedLaunchWindow, at: number): PulseSlot | null {
  const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
  if (!Number.isSafeInteger(at) || at % hourMs !== 0 || at < Math.max(start, Date.parse(window.approvedAt)) || at >= end ||
      !duringLaunchReportingHours(at)) return null;
  return {
    scheduledAt: iso(at), timezone: launchPulseTimezone, hourStart: iso(Math.max(start, at - hourMs)),
    todayStart: iso(midnight(launchPacificDay(at))), launchStart: iso(start), launchEnd: iso(end),
    interpretation: window.interpretation,
  };
}

export function pulseTimeFromRef(eventRef: string) {
  if (!/^launch-pulse:[a-f0-9]{64}:\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(eventRef)) return NaN;
  return Date.parse(eventRef.slice(launchPulsePrefix.length + 65));
}
