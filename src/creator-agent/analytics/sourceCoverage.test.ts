import { describe, expect, it } from "vitest";
import { nativeAnalyticsFixture } from "./nativeFixtures.testkit";
import type { NativeOverviewSummary } from "./views";
import type { AnalyticsOwnerProof } from "./contract";

function withSync(state: NonNullable<AnalyticsOwnerProof["sync"]>["state"]) {
  const f = nativeAnalyticsFixture();
  f.state.mutate = snapshot => {
    const owner = snapshot.owners.find(row => row.owner === "creatorActivity")!;
    owner.sync = { state, attemptedAt: owner.observedAt, successfulCoverageAt: owner.sourceAsOf, expectedCount: 1, observedCount: 1 };
    if (state === "neverSynced") { owner.sourceAsOf = null; owner.coverage = "missing"; owner.sync.successfulCoverageAt = null; owner.sync.observedCount = null; }
    if (state === "partial") { owner.coverage = "partial"; owner.sync.expectedCount = 2; }
  };
  return f;
}
describe("source-wide coverage outcomes in analytics", () => {
  it.each(["changed", "unchanged"] as const)("preserves successful %s checks without implying no activity", async state => {
    const f = withSync(state), result = await f.reader.read(f.request("overviewSummary"), f.principal), d = result.data as NativeOverviewSummary;
    expect(d.sources.find(row => row.owner === "creatorActivity")?.sync).toMatchObject({ state, expectedCount: 1, observedCount: 1 });
    expect(d.measures.find(row => row.metricId === "creatorViews")?.result).toMatchObject({ state: "known", value: 500, provisional: false });
  });
  it.each(["partial", "error", "neverSynced", "unknown"] as const)("keeps a %s owner from contributing an all-clear", async state => {
    const f = withSync(state), d = (await f.reader.read(f.request("overviewSummary"), f.principal)).data as NativeOverviewSummary;
    expect(d.coverage.state).not.toBe("complete");
    expect(d.measures.find(row => row.metricId === "creatorViews")?.result.state).toBe("unknown");
    expect(d.measures.find(row => row.metricId === "creatorEngagementRate")?.result.state).not.toBe("known");
  });
  it("rejects a new row watermark promoted past the last successful full check", async () => {
    const f = withSync("error"), mutate = f.state.mutate!;
    f.state.mutate = snapshot => { mutate(snapshot); const owner = snapshot.owners.find(row => row.owner === "creatorActivity")!; owner.sourceAsOf = new Date(f.state.now - 1).toISOString(); };
    await expect(f.reader.read(f.request("overviewSummary"), f.principal)).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_INVALID" });
  });
  it("rejects a no-change check without a complete population count", async () => {
    const f = withSync("unchanged"), mutate = f.state.mutate!;
    f.state.mutate = snapshot => { mutate(snapshot); snapshot.owners.find(row => row.owner === "creatorActivity")!.sync!.expectedCount = 2; };
    await expect(f.reader.read(f.request("overviewSummary"), f.principal)).rejects.toMatchObject({ code: "ANALYTICS_SOURCE_INVALID" });
  });
  it("compares successful coverage instants rather than ISO spelling", async () => {
    const f = withSync("unchanged"), mutate = f.state.mutate!;
    f.state.mutate = snapshot => { mutate(snapshot); const owner = snapshot.owners.find(row => row.owner === "creatorActivity")!;
      owner.sync!.successfulCoverageAt = owner.sourceAsOf!.replace("Z", "+00:00"); };
    const data = (await f.reader.read(f.request("overviewSummary"), f.principal)).data as NativeOverviewSummary;
    expect(data.measures.find(row => row.metricId === "creatorViews")?.result).toMatchObject({ state: "known", value: 500 });
  });
});
