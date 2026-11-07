// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { canonicalMediaFixture } from "./media/canonicalFixture.testkit.ts";
import { createMediaResources } from "./mediaResources.ts";
import type { ResourceAuthority } from "./jobs/dispatchSchema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture(transform?: (base: ResourceAuthority, f: Awaited<ReturnType<typeof canonicalMediaFixture>>) => ResourceAuthority) {
  const f = await canonicalMediaFixture(); cleanups.push(() => f.approval.db.close());
  const base: ResourceAuthority = { resolveGrants: f.resources.resolveGrants, assertCurrent: f.resources.assertCurrent };
  Object.assign(f.resources, createMediaResources(transform ? transform(base, f) : base, f.bridge));
  await f.releaseStage(); const campaign = await f.draft();
  return { f, campaign };
}
describe("one existing budget owner with independent source quota ownership", () => {
  it("issues the existing stage's one exclusive grant while retaining actual source quota proof", async () => {
    const { f, campaign } = await fixture(); await f.launch(campaign.campaignId);
    const rows = f.kernel.control.read(f.stage.stageRef)!.reservations;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state: "committed", plannedMaxMinor: 66000 });
    const publication = [...f.intents.values()].find(intent => intent.action === "media.publish")!;
    expect(publication.resourceGrants.map(grant => grant.dimension).sort()).toEqual(["budget", "quota"]);
    expect(publication.resourceGrants.find(grant => grant.dimension === "budget")).toMatchObject({ issuerRef: "media-control-reservations", quantity: 66000, exclusive: true });
    expect(f.state.calls).toBe(2); expect(f.kernel.treasury.mediaChargedMinor).toBe(0);
  });
  it("rechecks the actual source after the awaited quota allocation before reserving or publishing", async () => {
    const { f, campaign } = await fixture((base, current) => ({ ...base, resolveGrants: async request => {
      const grants = await base.resolveGrants(request);
      if (request.intent.approval.actionKind === "media.publish") current.state.failedGate = true;
      return grants;
    } }));
    await expect(f.launch(campaign.campaignId)).rejects.toThrow();
    expect(f.kernel.control.read(f.stage.stageRef)!.reservations).toHaveLength(0); expect(f.state.calls).toBe(1);
  });
  it("refuses a competing budget grant instead of charging both ledgers", async () => {
    const { f, campaign } = await fixture(base => ({ ...base, resolveGrants: async request => {
      const grants = await base.resolveGrants(request);
      return request.intent.approval.actionKind === "media.publish" ? [...grants, { ...grants[0]!, dimension: "budget", resourceRef: "synthetic-competing-budget", currency: "USD", unit: "minor", quantity: 66000 }] : grants;
    } }));
    await expect(f.launch(campaign.campaignId)).rejects.toThrow("MEDIA_DUPLICATE_BUDGET_OWNER");
    expect(f.kernel.control.read(f.stage.stageRef)!.reservations).toHaveLength(0); expect(f.state.calls).toBe(1);
  });
});
