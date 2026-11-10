// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalFixture } from "./fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "./repository.ts";
import { approvalDraftSchema, approvalInstantSchema } from "./contract.ts";

type Fixture = ReturnType<typeof approvalFixture>;
const fixtures: Fixture[] = [];
const make = (path?: string) => { const f = approvalFixture(path); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) { try { f.db.close(); } catch { /* A restart test may already close its first handle. */ } } });
const binding = (read: Awaited<ReturnType<Fixture["approved"]>>) => approvalDispatchBinding(read.manifest, read.manifest.items[0]!.itemRef);

describe("J04 exact source authority and immutable decision readback", () => {
  it("completes preview, Linear request, verified second-person Slack decision, Linear readback and dispatch proof without a provider action", async () => {
    const f = make(), read = await f.approved();
    expect(read.current.state).toBe("approved"); expect(read.decisionReceipt?.decision).toBe("approved"); expect(read.sourceEffect).toBe("none"); expect(f.state.writes).toBe(2);
    const result = await f.repo.resolveCurrentProof(binding(read)); expect(result.state).toBe("verified");
    if (result.state === "verified") { expect(result.proof.item.spendMinor).toBe(0); expect(() => f.repo.assertCurrentProof(result.proof, f.state.now)).not.toThrow(); }
  });
  it("does not turn a local preview, missing directory, missing writer or unknown readback into authority", async () => {
    const f = make(); f.sources.writeLinearRecord = undefined;
    const requested = await f.requested(); expect(requested.current.state).toBe("held"); expect(requested.request.state).toBe("local"); expect(f.state.writes).toBe(0);
    f.humans.clear(); await expect(f.repo.preparePreview(f.command, { principalRef: "synthetic:requester" }, "another")).rejects.toThrow("AUTHORITY_REQUIRED");
  });
  it("deduplicates proposal keys and rejects changed bodies without changing the immutable manifest", async () => {
    const f = make(), first = await f.repo.preparePreview(f.command, { principalRef: "synthetic:requester" }, "same");
    expect((await f.repo.preparePreview(f.command, { principalRef: "synthetic:requester" }, "same")).manifest).toEqual(first.manifest);
    await expect(f.repo.preparePreview({ ...f.command, entityVersion: "changed" }, { principalRef: "synthetic:requester" }, "same")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("allows only one Linear decision write across concurrent duplicate source events and preserves its receipt", async () => {
    const f = make(), requested = await f.requested(), event = f.event(requested, "approved", "synthetic:founder");
    const results = await Promise.allSettled([f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" }), f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true); expect(f.state.writes).toBe(2);
    const read = f.repo.readApproval(requested.manifest.approvalRef)!; expect(read.decisionHistory).toHaveLength(1);
    const repeated = await f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" }); expect(repeated.decisionReceipt).toEqual(read.decisionReceipt); expect(f.state.writes).toBe(2);
  });
  it("holds an unknown write across restart and never treats a later absent read as terminal non-application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synthetic-j04-"));
    try {
      const f = make(join(directory, "db.sqlite")); f.state.writerUnknown = true; const requested = await f.requested(); expect(requested.request.state).toBe("uncertain"); expect(f.state.writes).toBe(1);
      const restarted = new ApprovalRepository(f.db, f.options);
      await restarted.reconcileDecision({ approvalRef: requested.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "reconcile");
      expect(restarted.readApproval(requested.manifest.approvalRef)?.request.state).toBe("uncertain"); expect(f.state.writes).toBe(1);
      await restarted.requestDecision({ approvalRef: requested.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "new-key"); expect(f.state.writes).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("recovers an applied but lost Linear response by exact readback without another write", async () => {
    const f = make(), writer = f.sources.writeLinearRecord!; f.sources.writeLinearRecord = async intent => { await writer(intent); throw new Error("Synthetic lost response"); };
    const read = await f.approved(); expect(read.current.state).toBe("approved"); expect(f.state.writes).toBe(2);
  });
  it("rejects a same-person decision despite a distinct principal and rejects forged source identity", async () => {
    const f = make(), requested = await f.requested(); f.humans.get("synthetic:reviewer")!.personRef = "synthetic:requester";
    const event = f.event(requested); await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("SECOND_PERSON_REQUIRED");
    expect(f.state.writes).toBe(1);
    event.personRef = "synthetic:forged-founder"; await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("SLACK_ACTOR_MISMATCH");
  });
  it.each([49_999, 50_000, 50_001])("applies the strictly-over-$500 founder threshold at %i cents", async amount => {
    const f = make(); f.draft.phase = "other"; f.draft.acquisitionTerms = null; f.draft.effects.sendsCreator = false; f.draft.effects.spendsMoney = true; f.draft.items[0]!.spendMinor = amount; f.draft.bounds.maxSpendMinor = amount; f.draft.exposure = { state: "known", minor: amount, currency: "USD" };
    const requested = await f.requested(), event = f.event(requested);
    if (amount > 50_000) await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("FOUNDER_REQUIRED");
    else expect((await f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).current.state).toBe("approved");
  });
  it("founder over threshold still needs another person", async () => {
    const f = make(); f.humans.get("synthetic:requester")!.roles = ["founder"]; f.draft.effects.spendsMoney = true; f.draft.bounds.maxSpendMinor = 50_001; f.draft.exposure = { state: "known", minor: 50_001, currency: "USD" };
    const request = await f.requested(), event = f.event(request, "approved", "synthetic:requester");
    await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("SECOND_PERSON_REQUIRED");
  });
  it("preserves historical receipt but invalidates old proofs after policy change or revocation", async () => {
    const f = make(), read = await f.approved(), proof = await f.repo.resolveCurrentProof(binding(read)); expect(proof.state).toBe("verified");
    f.events.get("synthetic:event-1")!.state = "revoked";
    const current = await f.repo.resolveCurrentProof(binding(read)); expect(current.state).toBe("held"); expect(f.repo.readApproval(read.manifest.approvalRef)?.current.state).toBe("held");
    expect(f.repo.readApproval(read.manifest.approvalRef)?.decisionReceipt).toEqual(read.decisionReceipt);
    if (proof.state === "verified") expect(() => f.repo.assertCurrentProof(proof.proof, f.state.now)).toThrow();
  });
  it("holds a revoked source on the final awaited Slack read, and edited/deleted/ambiguous events never approve", async () => {
    const f = make(), requested = await f.requested(), event = f.event(requested, "approved", "synthetic:founder");
    f.state.readHook = async intent => { if (intent.kind === "decision") event.state = "revoked"; };
    const read = await f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" }); expect(read.decisionReceipt).toBeNull(); expect(read.current.state).toBe("held");
    for (const state of ["edited", "deleted", "ambiguous"] as const) { event.state = state; await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("SLACK_DECISION_UNVERIFIED"); }
  });
  it("does not authorize forged proofs, foreign scope or changed per-item payload/bounds", async () => {
    const f = make(), read = await f.approved(), result = await f.repo.resolveCurrentProof(binding(read));
    expect((await f.repo.resolveCurrentProof({ ...binding(read), payloadHash: "f".repeat(64) })).state).toBe("held");
    if (result.state === "verified") {
      expect(() => f.repo.assertCurrentProof({ ...result.proof, verificationRef: "synthetic:forged" }, f.state.now)).toThrow("APPROVAL_PROOF_UNVERIFIED");
      expect(() => f.repo.assertCurrentProof({ ...result.proof, item: { ...result.proof.item, units: 1 } }, f.state.now)).toThrow("APPROVAL_PROOF_UNVERIFIED");
    }
  });
  it("a new manifest, cancellation or expiry fences dispatch while preserving original decisions and outcomes", async () => {
    const f = make(), read = await f.approved(), result = await f.repo.resolveCurrentProof(binding(read));
    const outcome = { approvalRef: read.manifest.approvalRef, manifestVersion: 1, manifestHash: read.manifest.manifestHash, itemRef: "synthetic:item-1", runRef: "synthetic:run", outcomeRef: "synthetic:provider-receipt" };
    expect(() => f.repo.recordOutcomeLink(outcome)).toThrow("OUTCOME_SOURCE_UNVERIFIED"); f.outcomes.set(outcome.outcomeRef, outcome); f.repo.recordOutcomeLink(outcome);
    const cancel = f.event(read, "canceled", "synthetic:founder", "synthetic:event-cancel");
    const canceled = await f.repo.observeDecision(cancel.locator, { ingressRef: "synthetic:ingress" }); expect(canceled.decisionHistory).toHaveLength(2); expect(canceled.outcomeRefs).toEqual(["synthetic:provider-receipt"]);
    if (result.state === "verified") expect(() => f.repo.assertCurrentProof(result.proof, f.state.now)).toThrow();
  });
  it("expires historical approvals without returning historical readiness on replay", async () => {
    const f = make(), read = await f.approved(); f.state.now += 121_000;
    const replay = await f.repo.requestDecision({ approvalRef: read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose");
    expect(replay.decisionReceipt).toEqual(read.decisionReceipt); expect(replay.current.state).toBe("held"); expect(replay.current.reasonCodes).toContain("APPROVAL_EXPIRED");
  });
  it("rejects finite-date, malformed economic and duplicate-target inputs", () => {
    const f = make(); expect(approvalInstantSchema.safeParse("2026-11-06T20:00:00+99:99").success).toBe(false);
    expect(approvalDraftSchema.safeParse({ ...f.draft, bounds: { ...f.draft.bounds, maxSpendMinor: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    expect(approvalDraftSchema.safeParse({ ...f.draft, acquisitionTerms: { ...f.draft.acquisitionTerms!, commissionPct: Infinity } }).success).toBe(false);
    expect(approvalDraftSchema.safeParse({ ...f.draft, items: [...f.draft.items, { ...f.draft.items[0]!, itemRef: "synthetic:item-2" }], bounds: { ...f.draft.bounds, maxItems: 2 } }).success).toBe(false);
  });
});
