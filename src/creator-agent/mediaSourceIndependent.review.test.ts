// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { canonicalMediaFixture } from "./media/canonicalFixture.testkit.ts";
import type { CanonicalMediaReadback, CanonicalMediaAction } from "./media/canonicalContract.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
describe("independent exact media effect readback, beyond matching identity and receipt fields", () => {
  it.each(["draft-cap", "pause-state", "budget-value"] as const)("retains uncertainty on %s mismatch until correct original native readback", async kind => {
    const f = await canonicalMediaFixture(); cleanups.push(() => f.approval.db.close());
    await f.releaseStage();
    const campaign = f.kernel.prepare(); let entityRef = campaign.campaignId;
    let action: CanonicalMediaAction = "media.createDraft";
    if (kind !== "draft-cap") {
      expect((await f.run("media.createDraft", campaign.campaignId)).executionCertainty).toBe("applied");
      expect((await f.run("media.publish", campaign.campaignId)).executionCertainty).toBe("applied");
      const mutation = f.kernel.media.proposeMutation(campaign.campaignId,
        { kind: kind === "pause-state" ? "pause" : "edit-budget", dailyBudgetMinor: kind === "pause-state" ? null : 1000 }, "synthetic-readback-mismatch-intent");
      entityRef = mutation.mutationId; action = kind === "pause-state" ? "media.pause" : "media.changeBudget";
    }
    const run = await f.handoff(await f.approve(action, entityRef)), original = f.source.perform;
    f.source.perform = async input => {
      const response = structuredClone(await original(input)) as CanonicalMediaReadback;
      if (response.state !== "applied") throw new Error("Expected synthetic native effect.");
      if (kind === "draft-cap") response.native.settings.lifetimeBudgetMinor = (response.native.settings.lifetimeBudgetMinor ?? 0) + 1;
      if (kind === "pause-state") response.native.settings.status = "ACTIVE";
      if (kind === "budget-value") response.native.settings.dailyBudgetMinor = 2000;
      return response;
    };
    const result = await f.dispatch.execute(run.runRef);
    expect(result.executionCertainty).toBe("uncertain"); expect(result.items[0]!.receipt).toBeNull();
    const calls = f.state.calls;
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied"); expect(f.state.calls).toBe(calls);
    expect(f.kernel.media.read(campaign.campaignId)?.heldReasons).not.toContain("MEDIA_APPLIED_STATE_MISMATCH");
  });
});
