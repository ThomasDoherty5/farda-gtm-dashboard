// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalMediaFixture } from "./media/canonicalFixture.testkit.ts";
import { prepareSchema } from "./media/contract.ts";
import { canonicalMediaReadbackSchema } from "./media/canonicalContract.ts";
import { DispatchError, grantSchema } from "./jobs/dispatchSchema.ts";

describe("independent canonical media native ownership review", () => {
  it("renews an unchanged allocation after a pre-claim denial, preserving fresh gate holds and one reservation", async () => {
    const f = await canonicalMediaFixture();
    try {
      await f.releaseStage();
      const campaign = await f.draft();
      const run = await f.handoff(await f.approve("media.publish", campaign.campaignId));
      let fences = 0;
      await expect(f.dispatch.execute(run.runRef, { workerRef: "synthetic:review-worker", assertCurrent() {
        if (++fences > 1) throw new DispatchError("SYNTHETIC_WORKER_WITHDRAWN", 403);
      } })).rejects.toMatchObject({ code: "SYNTHETIC_WORKER_WITHDRAWN", executionCertainty: "notApplied" });
      const reservationBody = () => String(f.approval.db.prepare("SELECT body FROM media_control_reservations WHERE campaign_id=?").get(campaign.campaignId)?.body);
      const originalBody = reservationBody();
      const originalGrant = grantSchema.parse((JSON.parse(originalBody) as { canonicalGrant: unknown }).canonicalGrant);
      expect(f.jobs.getRun(run.runRef).items[0]?.attempts).toBe(0);
      f.advance("2026-11-06T20:06:00Z");
      await f.refreshCapabilities();
      f.quota.clear(); // The configured fictional quota owner issues a current grant on the next preflight.
      f.state.failedGate = true;
      await expect(f.dispatch.execute(run.runRef)).rejects.toThrow();
      expect(reservationBody()).toBe(originalBody);
      expect(f.state.calls).toBe(1);
      f.state.failedGate = false;
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("applied");
      const renewed = grantSchema.parse((JSON.parse(reservationBody()) as { canonicalGrant: unknown }).canonicalGrant);
      expect({ ...renewed, observedAt: originalGrant.observedAt, validUntil: originalGrant.validUntil }).toEqual(originalGrant);
      expect(Date.parse(renewed.validUntil)).toBeGreaterThan(Date.parse(originalGrant.validUntil));
      expect(f.approval.db.prepare("SELECT COUNT(*) AS n FROM media_control_reservations WHERE campaign_id=?").get(campaign.campaignId)?.n).toBe(1);
      expect(f.kernel.control.read(f.stage.stageRef)?.reservations[0]?.plannedMaxMinor).toBe(66000);
      expect(f.jobs.getRun(run.runRef).items[0]?.attempts).toBe(1);
      expect(f.state.calls).toBe(2);
    } finally { f.approval.db.close(); }
  });

  it("holds a second campaign claiming an existing native ID, then recovers only its original correct receipt", async () => {
    const f = await canonicalMediaFixture();
    try {
      const first = await f.draft();
      const second = f.kernel.prepare();
      const perform = f.source.perform;
      f.source.perform = async input => {
        const result = canonicalMediaReadbackSchema.parse(await perform(input));
        if (result.state !== "applied") throw new Error("Synthetic native effect expected.");
        return { ...result, native: { ...result.native, settings: { ...result.native.settings, nativeCampaignId: first.native.nativeCampaignId! } } };
      };
      const run = await f.handoff(await f.approve("media.createDraft", second.campaignId));
      expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");
      expect(f.kernel.media.read(first.campaignId)?.native.nativeCampaignId).toBe(first.native.nativeCampaignId);
      expect(f.kernel.media.read(second.campaignId)).toMatchObject({ state: "uncertain", native: { nativeCampaignId: null } });
      expect(f.approval.db.prepare("SELECT COUNT(*) AS n FROM media_native").get()?.n).toBe(1);
      expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
      expect(f.kernel.media.read(second.campaignId)?.native.nativeCampaignId).not.toBe(first.native.nativeCampaignId);
      expect(f.approval.db.prepare("SELECT COUNT(*) AS n FROM media_native").get()?.n).toBe(2);
      expect(f.state.calls).toBe(2);
      expect(f.jobs.getRun(run.runRef).items[0]?.attempts).toBe(1);
    } finally { f.approval.db.close(); }
  });

  it("retains a native draft's same-campaign ownership through an explicitly approved revision", async () => {
    const f = await canonicalMediaFixture();
    try {
      const first = await f.draft();
      const saved = f.approval.db.prepare("SELECT body FROM media_campaigns WHERE campaign_id=?").get(first.campaignId);
      const input = prepareSchema.parse((JSON.parse(String(saved?.body)) as { input: unknown }).input);
      const revised = f.kernel.media.prepare({ ...input, caps: { ...input.caps, dailyBudgetMinor: 1900 } }, "synthetic-revised-draft");
      expect(revised.revision).toBe(first.revision + 1);
      expect((await f.run("media.createDraft", revised.campaignId)).executionCertainty).toBe("applied");
      expect(f.kernel.media.read(first.campaignId)?.native.nativeCampaignId).toBe(first.native.nativeCampaignId);
      expect(f.kernel.media.read(first.campaignId)?.native.status).toBe("PAUSED");
      expect(f.approval.db.prepare("SELECT COUNT(*) AS n FROM media_native").get()?.n).toBe(1);
      expect(f.state.calls).toBe(2);
    } finally { f.approval.db.close(); }
  });

  it("does not confuse equal local native IDs in distinct provider/account namespaces", async () => {
    const f = await canonicalMediaFixture();
    try {
      const first = await f.draft("meta");
      const second = f.kernel.prepare("tiktok");
      const perform = f.source.perform;
      f.source.perform = async input => {
        const result = canonicalMediaReadbackSchema.parse(await perform(input));
        if (result.state !== "applied") throw new Error("Synthetic native effect expected.");
        return { ...result, native: { ...result.native, settings: { ...result.native.settings, nativeCampaignId: first.native.nativeCampaignId! } } };
      };
      expect((await f.run("media.createDraft", second.campaignId)).executionCertainty).toBe("applied");
      expect(f.kernel.media.read(second.campaignId)?.native.nativeCampaignId).toBe(first.native.nativeCampaignId);
      const claims = f.approval.db.prepare("SELECT provider,native_id,campaign_id FROM media_native ORDER BY provider").all();
      expect(claims).toHaveLength(2);
      expect(claims.map(row => JSON.parse(String(row.provider)))).toEqual([
        ["meta", first.manifest!.account.providerAccountRef, "sandbox"],
        ["tiktok", second.manifest!.account.providerAccountRef, "sandbox"],
      ]);
      expect(new Set(claims.map(row => row.campaign_id)).size).toBe(2);
      expect(new Set(claims.map(row => row.native_id)).size).toBe(1);
    } finally { f.approval.db.close(); }
  });
});
