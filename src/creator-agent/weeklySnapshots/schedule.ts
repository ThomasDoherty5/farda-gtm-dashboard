import { nextRun } from "../scheduleCadence.ts";

export const weeklyTimezone = "America/Los_Angeles";
const week = 7 * 86_400_000;
const pacificDate = new Intl.DateTimeFormat("en-US", {
  timeZone: weeklyTimezone, year: "numeric", month: "2-digit", day: "2-digit",
});

function wallTime(date: number, localTime: string) {
  const occurrence = nextRun({ cadence: "weekly-monday", timezone: weeklyTimezone, localTime, activeCohortOverride: false }, new Date(date));
  if (!occurrence) throw new Error("WEEKLY_SNAPSHOT_SCHEDULE_UNRESOLVABLE");
  return occurrence.at.toISOString();
}

/** Completed Monday-to-Monday Pacific week, including weeks with a DST change. */
export function weeklySnapshotWindow(reportDate: string) {
  const monday = new Date(reportDate + "T00:00:00.000Z");
  if (!Number.isFinite(+monday) || monday.toISOString().slice(0, 10) !== reportDate || monday.getUTCDay() !== 1) return null;
  return {
    reportDate, timezone: weeklyTimezone,
    start: wallTime(+monday - week, "00:00"), end: wallTime(+monday, "00:00"),
    scheduledAt: wallTime(+monday, "08:30"),
  };
}

export type WeeklyWindow = NonNullable<ReturnType<typeof weeklySnapshotWindow>>;

export function previousWeeklyDate(reportDate: string) {
  return new Date(Date.parse(reportDate + "T00:00:00.000Z") - week).toISOString().slice(0, 10);
}

/** A launch on Monday qualifies the following Monday, even before 08:30. */
export function weeklySnapshotAfterLaunch(window: WeeklyWindow, approvedLaunchAt: string | null) {
  if (!approvedLaunchAt || !Number.isFinite(Date.parse(approvedLaunchAt))) return false;
  const parts = pacificDate.formatToParts(new Date(approvedLaunchAt));
  const localLaunchDate = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  return window.reportDate > localLaunchDate;
}
