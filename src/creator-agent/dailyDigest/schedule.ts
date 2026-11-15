import { nextRun } from "../scheduleCadence.ts";
import { digestTimezone, digestWindowSchema, type DigestCohort, type DigestWindow } from "./contract.ts";

const day = 86_400_000;
const daily = { cadence: "daily", timezone: digestTimezone, activeCohortOverride: false };

function wallTime(localDate: number, time: string): string {
  const occurrence = nextRun({ ...daily, localTime: time }, new Date(localDate));
  if (!occurrence) throw new Error("DIGEST_SCHEDULE_UNRESOLVABLE");
  return occurrence.at.toISOString();
}

/** The trigger date is Pacific. Yesterday is a local calendar day, including 23/25-hour days. */
export function dailyDigestWindow(reportDate: string, cohort: DigestCohort | null): DigestWindow | null {
  const utcDate = Date.parse(reportDate + "T00:00:00.000Z");
  if (!Number.isFinite(utcDate) || new Date(utcDate).toISOString().slice(0, 10) !== reportDate) {
    throw new Error("DIGEST_DATE_INVALID");
  }
  const scheduledAt = wallTime(utcDate, "08:30");
  const slot = Date.parse(scheduledAt);
  const activeCohort = cohort && Date.parse(cohort.startsAt) <= slot && slot < Date.parse(cohort.endsAt) ? cohort : null;
  const weekday = new Date(utcDate).getUTCDay();
  if ((weekday === 0 || weekday === 6) && !activeCohort) return null;
  return digestWindowSchema.parse({
    reportDate, scheduledAt, start: wallTime(utcDate - day, "00:00"), end: wallTime(utcDate, "00:00"),
    nextDayStart: wallTime(utcDate + day, "00:00"), timezone: digestTimezone, cohort: activeCohort,
  });
}
