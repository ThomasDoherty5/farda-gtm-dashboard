import { describe, expect, it } from "vitest";
import { nativeAnalyticsFixture } from "./nativeFixtures.testkit";
import { addReservationFixture } from "./reservations.testkit";
import type { NativeCampaignFunnel } from "./views";
import type { NativeAnalyticsSnapshot } from "./contract";

function fixture(change?: (snapshot: Extract<NativeAnalyticsSnapshot, { viewKey: "campaignFunnel" }>) => void) {
  const f = nativeAnalyticsFixture();
  f.state.mutate = snapshot => { addReservationFixture(snapshot); if (snapshot.viewKey === "campaignFunnel") change?.(snapshot); };
  return { f, read: async () => (await f.reader.read(f.request("campaignFunnel"), f.principal)).data as NativeCampaignFunnel };
}
describe("cohort-linked reservation evidence", () => {
  it("returns owner homes, units, cost approval and aliased provenance without a write", async () => {
    const { read } = fixture(), d = await read();
    expect(d.reservations).toMatchObject({ coverage: "complete", total: 1, provisional: false, rows: [{ home: "H1", units: 2, state: "active", cost: { value: { minorUnits: 3000 } }, approval: { state: "approved" } }] });
    expect(d.reservations!.rows[0]!.reservationRef).toMatch(/^analytics-reservation-/);
    expect(JSON.stringify(d.reservations)).not.toContain("fictional-sample-approval");
    expect(d.reserved.value).toBe(2); expect(d.totals.shipped.value).toBe(10);
  });
  it.each(["cohort", "period", "duplicate", "units", "approval", "cost-owner", "future"])("rejects %s inconsistencies instead of inventing qualified detail", async kind => {
    const { read } = fixture(s => { const r = s.facts.reservations!, row = r.rows[0]!;
      if (kind === "cohort") r.cohortRef = "another-cohort";
      if (kind === "period") r.period = { ...r.period, timezone: "America/New_York" };
      if (kind === "duplicate") { r.rows.push(structuredClone(row)); r.total = 2; }
      if (kind === "units") row.units = 3;
      if (kind === "approval") row.approval.evidenceRef = null;
      if (kind === "cost-owner") row.cost.proofRef = "fictional-proof-economicCosts";
      if (kind === "future") row.observedAt = new Date(Date.parse(s.observedAt) + 1).toISOString();
    });
    await expect(read()).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_INVALID" });
  });
  it("holds approvals for partial reservation evidence and preserves missing costs", async () => {
    const { read } = fixture(s => { const r = s.facts.reservations!; r.coverage = "partial"; r.total = null;
      r.rows[0]!.cost = { value: null, reason: "COST_INCOMPLETE", proofRef: null, evidenceRefs: [] }; });
    expect((await read()).reservations).toMatchObject({ provisional: true, total: null, rows: [{ approval: { state: "unknown" }, cost: { value: null, state: "unknown" } }] });
  });
  it("keeps missing detail distinct from a complete counted zero", async () => {
    const { f } = fixture(); f.state.mutate = null;
    expect(((await f.reader.read(f.request("campaignFunnel"), f.principal)).data as NativeCampaignFunnel).reservations).toBeNull();
    const complete = fixture(s => { s.facts.reservations!.rows = []; s.facts.reservations!.total = 0; s.facts.channels[0]!.reserved.value = 0; });
    expect((await complete.read()).reservations).toEqual({ coverage: "complete", total: 0, provisional: false, rows: [] });
  });
});
