// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createMediaHttpFixture } from "./mediaHttpFixture.testkit.ts";
import { MEDIA_STAGE_ACTION } from "./media/canonicalContract.ts";
import { nativeApprovalViewSchema, nativeRunViewSchema } from "./actions/views.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
const relayToken = "synthetic-media-relay-token-not-for-deployment", workerToken = "synthetic-media-worker-token-not-for-deployment";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(configured = true, capMinor = 150000) { const value = await createMediaHttpFixture(configured,capMinor); cleanups.push(value.close); return value; }

describe("actual HTTP media consumers on the application's one J04, SQLite and runner", () => {
  it("records the full $1500 authorization and performs four exact native effects across both accounts once", async () => {
    const f = await fixture(), stage = await f.run(MEDIA_STAGE_ACTION, "stage:initial"); expect(f.world.state.calls).toBe(0);
    const projection = nativeApprovalViewSchema.parse(await f.app.actionFoundation.service.readApproval(stage.requested.approvalRef!, { principalRef: "agent-reviewer" }));
    expect(projection.authorization).toMatchObject({ capMinor: 150000, immediateProviderSpendMinor: 0 }); expect(projection.exposure).toEqual({ state: "known", minor: 150000, currency: "USD" });
    for (const provider of ["meta", "tiktok"] as const) { const c = f.prepare(provider); await f.run("media.createDraft", c.campaignId); const published = await f.run("media.publish", c.campaignId);
      expect(published.executed.body).toMatchObject({ state: "completed", executionCertainty: "applied", receiptCount: 1, outcomeLinksVerified: true });
      await f.action(published.command); await f.http("/v1/worker/dispatch", { runRef: published.queued.runRef }, workerToken);
      expect(f.app.mediaDomain!.repository.read(c.campaignId)?.native.status).toBe("ACTIVE"); }
    expect(f.world.state.calls).toBe(4); expect(f.app.mediaDomain!.controller.read("stage:initial")?.reservations.map(r => r.plannedMaxMinor)).toEqual([66000, 66000]);
    expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM approval_decisions").get()?.n).toBe(5); expect(f.app.store.database.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(5);
    expect(f.a.db.prepare("SELECT COUNT(*) n FROM approval_decisions").get()?.n).toBe(0); expect(f.a.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);
  });
  it("refuses generic reviewer/reader dispatch and direct legacy media routes", async () => {
    const f = await fixture(), stage = await f.approve(MEDIA_STAGE_ACTION, "stage:initial");
    for (const token of [reader, reviewer, relayToken]) expect((await f.http("/v1/worker/dispatch", { runRef: stage.queued.runRef }, token)).status).toBe(401);
    for (const path of ["/v1/media/campaigns", "/v1/media/campaigns/synthetic/publish", "/v1/media-control/stages/synthetic/release", "/v1/media-control/stages/synthetic/safety"])
      expect((await f.http(path, {})).status).toBe(404);
    expect(f.world.state.calls).toBe(0);
  });
  it("requires a distinct genuine founder even for the local cap record below $500", async () => {
    const f = await fixture(true,30000), { requested } = await f.request(MEDIA_STAGE_ACTION, "stage:initial");
    const event = f.a.event(f.app.actionFoundation.approvals.readApproval(requested.approvalRef!)!, "approved", "synthetic:reviewer");
    expect((await f.http("/v1/approvals/observe", event.locator, relayToken)).status).toBe(403); expect(f.world.state.calls).toBe(0);
    expect(f.app.mediaDomain!.controller.read("stage:initial")?.state).toBe("awaiting-approval");
  });
  it("keeps an unconfigured media action unavailable instead of using an invented default binding", async () => {
    const f = await fixture(false), response = await f.http("/v1/action", { ...f.base(), operation: "previewAction", actionKind: "media.createDraft",
      payload: { entityRef: "synthetic-missing-campaign", entityVersion: "1", selectionRefs: ["synthetic-missing-campaign"] } });
    expect(response.status).not.toBe(200); expect(f.app.mediaDomain).toBeUndefined(); expect(f.world.state.calls).toBe(0);
  });
  it("reports a terminal provider rejection distinctly without erasing its native receipt or resending",async()=>{
    const f=await fixture();await f.run(MEDIA_STAGE_ACTION,"stage:initial");const c=f.prepare();await f.run("media.createDraft",c.campaignId);
    f.world.state.rejected=true;const result=await f.run("media.publish",c.campaignId);
    expect(result.executed.body).toMatchObject({executionCertainty:"applied",receiptCount:1,providerRejectedCount:1});
    expect(f.app.mediaDomain!.repository.read(c.campaignId)).toMatchObject({state:"provider-rejected",providerReview:{state:"rejected"}});
    const replay=await f.action(result.command);expect(replay).toMatchObject({state:"failed",executionCertainty:"applied",reasonCodes:expect.arrayContaining(["PROVIDER_REJECTED"])});
    const view=nativeRunViewSchema.parse(await f.app.actionFoundation.service.readRun(result.queued.runRef!,{principalRef:"agent-reviewer"}));
    expect(view).toMatchObject({providerRejectedCount:1,items:[{sourceEffect:"providerApplied",providerOutcome:{state:"rejected",reasonCode:"PROVIDER_REJECTED"}}]});
    await f.http("/v1/worker/dispatch",{runRef:result.queued.runRef},workerToken);expect(f.world.state.calls).toBe(2);expect(replay.receiptRefs).toHaveLength(1);
  });
});
