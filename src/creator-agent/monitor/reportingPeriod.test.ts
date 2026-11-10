// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { overviewOwnersFixture } from "../analytics/overviewOwners.testkit.ts";
import { nativeContentSchema } from "./contract.ts";
const open: Awaited<ReturnType<typeof overviewOwnersFixture>>[] = [];
async function fixture() { const f = await overviewOwnersFixture(); open.push(f); return f; }
afterEach(() => { for (const f of open.splice(0)) f.close(); });
async function read(f: Awaited<ReturnType<typeof fixture>>) {
  return nativeContentSchema.parse((await f.readers.monitor.read("contentMonitor", { reportingPeriod: f.period,
    campaign: f.readers.monitor.publicCampaignRef("fictional-qualified-cohort") }, { limit: 100, cursor: null, authorizationContext: "reader" }, f.caller)).data);
}
describe("exact reporting periods use source-owned measurement and attribution windows", () => {
  it("accepts a completed interval observed after its end and preserves known zero", async () => {
    const f = await fixture(), post = f.monitor.snapshot.posts[0]!;
    expect(Date.parse(post.measurements[0]!.at)).toBeGreaterThan(Date.parse(f.period.endAt));
    post.measurements[0]!.views = 0; post.measurements[0]!.likes = 0; post.measurements[0]!.comments = 0;
    expect(await read(f)).toMatchObject({ views: 0, rate: null, orders: 0, net: { minorUnits: 0, currency: "USD" }, liveCount: 1 });
  });
  it("does not relabel lifetime measurements or unbound post-attribution counts as period facts", async () => {
    const f = await fixture(), post = f.monitor.snapshot.posts[0]!;
    delete post.measurements[0]!.reportingPeriod; delete post.attribution!.reportingPeriod;
    post.measurements[0]!.at = new Date(Date.parse(f.period.endAt) - 1000).toISOString();
    expect(await read(f)).toMatchObject({ views: null, rate: null, orders: null, net: null, liveCount: 1 });
    const lifetime = nativeContentSchema.parse((await f.readers.monitor.read("contentMonitor", {}, { limit: 100, cursor: null }, f.caller)).data);
    expect(lifetime).toMatchObject({ views: 500, rate: 3, orders: 0, net: { minorUnits: 0, currency: "USD" } });
  });
  it.each(["startAt", "timezone"] as const)("withholds a mismatched source %s instead of borrowing its counts", async field => {
    const f = await fixture(), post = f.monitor.snapshot.posts[0]!, period = { ...f.period,
      [field]: field === "timezone" ? "America/Los_Angeles" : new Date(Date.parse(f.period.startAt) - 86_400_000).toISOString() };
    post.measurements[0]!.reportingPeriod = period; post.attribution!.reportingPeriod = period;
    expect(await read(f)).toMatchObject({ views: null, orders: null, net: null });
  });
  it("rejects a future end claimed by a currently observed source", async () => {
    const f = await fixture(); f.monitor.snapshot.posts[0]!.measurements[0]!.reportingPeriod = { ...f.period, endAt: new Date(f.now() + 1000).toISOString() };
    await expect(read(f)).rejects.toMatchObject({ code: "MONITOR_SOURCE_INVALID", status: 502 });
  });
  it("does not count another campaign or promote partial membership to a known zero", async () => {
    const f = await fixture(); f.monitor.snapshot.posts[0]!.campaign = "fictional-other-campaign";
    expect(await read(f)).toMatchObject({ total: 0, views: null, orders: null, liveCount: 0 });
    f.monitor.snapshot.coverage = "partial";
    expect(await read(f)).toMatchObject({ total: 0, views: null, orders: null, liveCount: null });
  });
});
