import { nextRun, validateSchedule } from "./schedule";

const weekdays = { cadence: "weekdays", localTime: "08:30", timezone: "America/Los_Angeles", activeCohortOverride: false } as const;

describe("schedule validation", () => {
  it("accepts the Figma example", () => expect(validateSchedule(weekdays)).toEqual({}));
  it("rejects values outside the allowed lists and ranges", () => {
    expect(validateSchedule({ ...weekdays, localTime: "24:00" }).localTime).toMatch(/HH:MM/);
    expect(validateSchedule({ ...weekdays, localTime: "8:30" }).localTime).toBeDefined();
    expect(validateSchedule({ ...weekdays, timezone: "Mars/Olympus" }).timezone).toBeDefined();
    expect(validateSchedule({ ...weekdays, cadence: "hourly" as never }).cadence).toBeDefined();
  });
});

describe("next run", () => {
  it("skips the weekend for a weekday cadence", () => {
    // Friday 3 Jul 2026, 10:00 PT. The next 08:30 weekday run is Monday.
    const run = nextRun(weekdays, new Date("2026-07-03T17:00:00Z"));
    expect(run?.at.toISOString()).toBe("2026-07-06T15:30:00.000Z");
    expect(run?.label).toMatch(/Mon, Jul 6.*8:30 AM PDT/);
  });

  it("uses the same wall-clock time across the autumn clock change", () => {
    // 1 Nov 2026 is the day clocks go back. 08:30 is PDT on 30 Oct and PST on 2 Nov.
    expect(nextRun({ ...weekdays, cadence: "daily" }, new Date("2026-10-31T17:00:00Z"))?.at.toISOString()).toBe("2026-11-01T16:30:00.000Z");
    expect(nextRun({ ...weekdays, cadence: "daily" }, new Date("2026-11-01T17:00:00Z"))?.at.toISOString()).toBe("2026-11-02T16:30:00.000Z");
  });

  it("runs a time that doesn't exist at the next valid minute (spring forward)", () => {
    // 8 Mar 2026: 02:30 does not exist in Los Angeles. It runs at 03:30 PDT = 10:30Z.
    const run = nextRun({ ...weekdays, cadence: "daily", localTime: "02:30" }, new Date("2026-03-08T00:00:00Z"));
    expect(run?.at.toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });

  it("runs a repeated time once, at its first occurrence (fall back)", () => {
    // 1 Nov 2026: 01:30 happens twice in Los Angeles. The first is 01:30 PDT = 08:30Z.
    const run = nextRun({ ...weekdays, cadence: "daily", localTime: "01:30" }, new Date("2026-11-01T00:00:00Z"));
    expect(run?.at.toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("gives no next run for an invalid draft", () => expect(nextRun({ ...weekdays, localTime: "nope" }, new Date())).toBeNull());
});
