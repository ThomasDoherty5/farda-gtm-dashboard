import { describe, expect, it } from "vitest";
import { trafficReportingRoute } from "./reportingPeriod";
import { siteTrafficFilters } from "./NativeSiteTrafficPage";

describe("source-owned reporting drilldown windows", () => {
  it("uses the traffic owner calendar-day filter names, including DST boundaries", () => {
    const route = trafficReportingRoute({ startAt: "2026-11-01T07:00:00Z", endAt: "2026-11-02T08:00:00Z", timezone: "America/Los_Angeles", basis: "eventTime" });
    expect(route).toBe("/analytics/customer-journey?startDay=2026-11-01&endDayExclusive=2026-11-02&timezone=America%2FLos_Angeles");
    const parsed = siteTrafficFilters(new URLSearchParams(route!.split("?")[1]));
    expect(parsed).toMatchObject({ period: { startDay: "2026-11-01", endDayExclusive: "2026-11-02", timezone: "America/Los_Angeles" }, segment: { kind: "all" } });
  });
  it("holds partial-day or reversed windows instead of sending incompatible filters", () => {
    expect(trafficReportingRoute({ startAt: "2026-11-01T07:00:01Z", endAt: "2026-11-02T08:00:00Z", timezone: "America/Los_Angeles", basis: "eventTime" })).toBeNull();
    expect(trafficReportingRoute({ startAt: "2026-11-02T08:00:00Z", endAt: "2026-11-01T07:00:00Z", timezone: "America/Los_Angeles", basis: "eventTime" })).toBeNull();
  });
});
