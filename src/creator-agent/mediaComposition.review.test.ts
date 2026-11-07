// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createMediaHttpFixture } from "./mediaHttpFixture.testkit.ts";
import { MEDIA_STAGE_ACTION } from "./media/canonicalContract.ts";

const workerToken = "synthetic-media-worker-token-not-for-deployment";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

describe("independent actual media composition boundaries", () => {
  it("rechecks the machine lease after the last awaited outcome-link read without losing the native receipt", async () => {
    const f = await createMediaHttpFixture(); cleanups.push(f.close);
    await f.run(MEDIA_STAGE_ACTION, "stage:initial");
    const campaign = f.prepare("meta"), approved = await f.approve("media.createDraft", campaign.campaignId);
    let withdrew = false;
    f.a.state.readHook = async intent => {
      if (intent.kind === "outcome" && !withdrew) { withdrew = true; f.a.state.now += 300001; }
    };
    const response = await f.http("/v1/worker/dispatch", { runRef: approved.queued.runRef }, workerToken);
    expect(withdrew).toBe(true);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "DISPATCH_WORKER_AUTHORITY_INVALID", executionCertainty: "applied" });
    const recorded = f.app.actionFoundation.dispatch.read(approved.queued.runRef!);
    expect(recorded.receipt?.sourceEffect).toBe("providerApplied");
    expect(f.world.state.calls).toBe(1);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM job_dispatch_attempts").get()?.n).toBe(2);
  });
  it("retains a rejected native acknowledgment as applied history without reporting campaign success or retrying", async () => {
    const f = await createMediaHttpFixture(); cleanups.push(f.close);
    await f.run(MEDIA_STAGE_ACTION, "stage:initial"); const campaign = f.prepare("meta"); f.world.state.rejected = true;
    const result = await f.run("media.createDraft", campaign.campaignId);
    expect(result.executed.body).toMatchObject({ executionCertainty: "applied", receiptCount: 1, providerRejectedCount: 1 });
    const replay = await f.action(result.command);
    expect(replay).toMatchObject({ state: "failed", executionCertainty: "applied" }); expect(replay.reasonCodes).toContain("PROVIDER_REJECTED");
    const view = await f.app.actionFoundation.service.readRun(result.queued.runRef!, { principalRef: "agent-reviewer" });
    expect(view.providerRejectedCount).toBe(1); expect(view.items[0]?.providerOutcome).toEqual({ state: "rejected", reasonCode: "PROVIDER_REJECTED" });
    expect(JSON.stringify(view)).not.toContain("synthetic-rejection");
    await f.http("/v1/worker/dispatch", { runRef: result.queued.runRef }, workerToken);
    expect(f.world.state.calls).toBe(1); expect(f.app.mediaDomain!.repository.read(campaign.campaignId)?.native.status).toBe("REJECTED");
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM job_dispatch_readbacks").get()?.n).toBe(0);
  });

});
