// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import { createActionDomainServices } from "./domainServices.ts";
import { readinessRequestRecoverySchema } from "./views.ts";
import { actionDomainFixture, actionTestScope as scope, actionTestSecret as secret, founderFixture as actor } from "./fixtures.testkit.ts";

const stores: AgentStore[] = [];
function setup(path = ":memory:", fixture = actionDomainFixture()) {
  const store = new AgentStore(path, scope); stores.push(store);
  return { ...fixture, store, service: createActionDomainServices({ db: store.database, scope, secret, ...fixture }) };
}
async function original(w: ReturnType<typeof setup>) {
  const view = await w.service.readReadiness(w.source.targetRef, actor);
  return { view, payload: { verdict: "go" as const, launchDate: view.launchDate, rationale: "Protected original fixture rationale", evidenceRefs: [view.evidenceRefs[1]!, view.evidenceRefs[0]!] } };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

describe("source-authorized original readiness request recovery", () => {
  it("returns only observational absence for missing or other-actor keys, never the other founder's rationale", async () => {
    const w = setup(), { view, payload } = await original(w);
    await w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "original-key");
    for (const [key, who] of [["missing", actor], ["original-key", { principalRef: "other-founder" }]] as const) {
      const result = await w.service.recoverReadinessRequest(key, who);
      expect(result).toEqual({ requestKey: key, state: "notFound", intent: null, receipt: null, terminalProof: null, reasonCodes: ["REQUEST_NOT_OBSERVED_ORIGINAL_KEY_ONLY"] });
    }
    expect(w.state.writes).toBe(1);
  });
  it("recovers exact original public body and opaque receipt despite a later current source version", async () => {
    const w = setup(), { view, payload } = await original(w);
    const ack = await w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "applied-key");
    expect((await w.service.readReadiness(w.source.targetRef, actor)).version).not.toBe(view.version);
    const result = await w.service.recoverReadinessRequest("applied-key", actor);
    expect(result.state).toBe("recorded");
    expect(result.intent).toEqual({ operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", requestKey: "applied-key", actorRef: view.actorRef,
      targetRef: view.targetRef, expectedVersion: view.version, entityRefs: [{ source: "launch-readiness", accountId: scope.accountId, sourceId: null, canonicalId: view.targetRef, url: null, identityState: "resolved", provenanceRef: view.version }], payload, payloadDigest: ack.payloadDigest });
    const { payload: omitted, ...publicAck } = ack; void omitted; expect(result.receipt).toEqual(publicAck);
    expect(readinessRequestRecoverySchema.safeParse({ ...result, receipt: null }).success).toBe(false);
    expect(readinessRequestRecoverySchema.safeParse({ ...result, receipt: { ...result.receipt, requestKey: "another-key" } }).success).toBe(false);
    expect(readinessRequestRecoverySchema.safeParse({ ...result, state: "notApplied", receipt: null }).success).toBe(false);
    const json = JSON.stringify(result);
    for (const privateRef of ["fixture-launch", "product-evidence", "fulfillment-evidence", "native-notion", "readiness-v1", "readiness-v2", actor.principalRef]) expect(json).not.toContain(privateRef);
    expect(w.state.writes).toBe(1); expect(result.receipt?.confersRelease).toBe(false);
  });
  it("can recover pending original intent and reconcile lost ACK without another source write", async () => {
    const w = setup(), { view, payload } = await original(w); w.state.loseWriteAck = true;
    await expect(w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "lost-key")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    w.state.lookupUnknown = true;
    const pending = await w.service.recoverReadinessRequest("lost-key", actor);
    expect(pending).toMatchObject({ state: "pending", intent: { payload, expectedVersion: view.version }, receipt: null, terminalProof: null });
    expect(w.state.writes).toBe(1);
    w.state.lookupUnknown = false;
    const recorded = await w.service.recoverReadinessRequest("lost-key", actor);
    expect(recorded).toMatchObject({ state: "recorded", intent: pending.intent, receipt: { requestKey: "lost-key", confersRelease: false } });
    expect(w.state.writes).toBe(1);
  });
  it("persists exact positive terminal nonapplication across readback and a later source observation", async () => {
    const w = setup(), { view, payload } = await original(w); w.state.writeMalformed = true; w.state.terminalNotApplied = true;
    await expect(w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "terminal-key")).rejects.toMatchObject({ code: "READINESS_NOT_APPLIED" });
    w.state.terminalNotApplied = false; w.state.lookupUnknown = true;
    const result = await w.service.recoverReadinessRequest("terminal-key", actor);
    expect(result).toMatchObject({ state: "notApplied", intent: { payload, expectedVersion: view.version }, receipt: null, terminalProof: { receiptRef: expect.stringMatching(/^notion-terminal-/) } });
    expect(w.state.writes).toBe(1);
    await expect(w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "terminal-key")).rejects.toMatchObject({ executionCertainty: "notApplied", code: "READINESS_NOT_APPLIED" });
  });
  it("preserves malformed/absent lookup uncertainty and cannot fabricate original public mappings for legacy records", async () => {
    const w = setup(), { view, payload } = await original(w); w.state.writeMalformed = true;
    await expect(w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "malformed-key")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    w.readiness.lookup = async () => ({ success: true });
    expect(await w.service.recoverReadinessRequest("malformed-key", actor)).toMatchObject({ state: "pending", intent: { payload }, terminalProof: null });
    w.store.database.prepare("DELETE FROM action_readiness_view_refs").run();
    expect(await w.service.recoverReadinessRequest("malformed-key", actor)).toMatchObject({ state: "unverified", intent: null, receipt: null });
    expect(w.state.writes).toBe(1);
  });
  it.each(["actor", "source"] as const)("clears protected recovery when %s permission is lost during source lookup, preserving applied receipt", async loss => {
    const w = setup(), { view, payload } = await original(w); w.state.loseWriteAck = true;
    await expect(w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "withdrawal-key")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    const lookup = w.readiness.lookup;
    w.readiness.lookup = async intent => { const result = await lookup(intent); if (loss === "actor") w.state.denyActor = true; else w.state.denySource = true; return result; };
    await expect(w.service.recoverReadinessRequest("withdrawal-key", actor)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    expect(w.store.database.prepare("SELECT state FROM action_domain_requests").get()?.state).toBe("applied"); expect(w.state.writes).toBe(1);
  });
  it("requires current source authorization and lease even for an already recorded original intent", async () => {
    const w = setup(), { view, payload } = await original(w);
    await w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "current-key");
    w.state.denySource = true;
    await expect(w.service.recoverReadinessRequest("current-key", actor)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    w.state.denySource = false; w.tick(3_600_001);
    await expect(w.service.recoverReadinessRequest("current-key", actor)).rejects.toMatchObject({ code: "SOURCE_STALE", executionCertainty: "applied" });
    expect(w.state.writes).toBe(1);
  });
  it("recovers original public mapping after actual SQLite restart with no browser rationale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-recovery-")), path = join(dir, "state.sqlite"), fixture = actionDomainFixture();
    try {
      const w = setup(path, fixture), { view, payload } = await original(w); w.state.loseWriteAck = true;
      await expect(w.service.recordReadinessFromView(view.targetRef, payload, view.version, actor, "restart-key")).rejects.toMatchObject({ executionCertainty: "uncertain" });
      stores.splice(stores.indexOf(w.store), 1); w.store.close();
      const reopened = setup(path, fixture);
      expect(await reopened.service.recoverReadinessRequest("restart-key", actor)).toMatchObject({ state: "recorded", intent: { payload, expectedVersion: view.version } });
      expect(fixture.state.writes).toBe(1); stores.splice(stores.indexOf(reopened.store), 1); reopened.store.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
