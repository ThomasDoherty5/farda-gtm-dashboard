// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRepository } from "../approvals/repository.ts";
import { CapabilityLedger } from "../connections/ledger.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import { createRewardDomainBridge } from "./approvalBridge.ts";
import { RewardRedemptionRepository } from "./repository.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { canonicalRewardFixture } from "./canonicalFixture.testkit.ts";
import { handleRewardRoute } from "./routes.ts";

const fixtures: Awaited<ReturnType<typeof canonicalRewardFixture>>[] = [];
const directories: string[] = [];
async function fixture(physical = false, path = ":memory:") { const f = await canonicalRewardFixture(path, physical); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.approval.db.close(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
function reopen(f: Awaited<ReturnType<typeof canonicalRewardFixture>>, path: string) {
  f.approval.db.close();
  const db = new DatabaseSync(path); f.approval.db = db;
  const now = () => f.approval.state.now;
  const repository = new RewardRedemptionRepository(db, { workspaceId: f.scope.workspaceId, accountId: f.scope.accountId }, f.authority, () => new Date(now()));
  const bridge = createRewardDomainBridge({ scope: f.scope, repository, commercialPolicy: f.commercialPolicy, source: f.source, registration: f.registration, now });
  const ledger = new CapabilityLedger(db, f.scope, { now, resolveReceipt: ref => f.capabilityReceipts.get(ref) ?? null });
  const jobs = new JobRepository(db, { scope: f.scope, now, resolveCapability: binding => ledger.requireReady(binding) });
  const approvals = new ApprovalRepository(db, { ...f.approval.options, registry: bridge.registry, verifyOutcome: out => dispatch.verifyOutcome(out) });
  const dispatch: DispatchGuard = new DispatchGuard({ db, scope: f.scope, jobs, approvals, ledger, resourceAuthority: f.resources, handlers: bridge.handlers, now });
  return { repository, dispatch, approvals };
}
function databasePath() { const dir = mkdtempSync(join(tmpdir(), "farda-reward-restart-")); directories.push(dir); return join(dir, "sandbox.sqlite"); }
describe("canonical earned reward through actual J04 and native job storage", () => {
  it("records a founder-approved sub-$500 redemption once and links its native outcome to Linear", async () => {
    const f = await fixture(), approved = await f.approve(), run = await f.handoff(approved);
    const done = await f.dispatch.execute(run.runRef);
    expect(done.executionCertainty).toBe("applied"); expect(f.state.calls).toBe(1);
    const view = f.repository.read(f.prepared.redemptionId)!;
    expect(view).toMatchObject({ state: "purchased", money: { earnedLiabilityMinor: 30000, chargedMinor: 26900 } });
    expect(view.receipts.decisionRef).toBe(approved.decisionReceipt!.receiptRef);
    const linked = await f.approvals.syncOutcomeLink({ approvalRef: approved.manifest.approvalRef, manifestVersion: approved.manifest.manifestVersion,
      manifestHash: approved.manifest.manifestHash, itemRef: approved.manifest.items[0]!.itemRef, runRef: run.runRef, outcomeRef: done.receipt!.receiptRef });
    expect(linked.outcomeRefs).toContain(done.receipt!.receiptRef);
    expect(linked.outbox.filter(o => o.kind === "outcome")).toEqual([expect.objectContaining({ state: "recorded" })]);
    expect((await f.dispatch.execute(run.runRef)).receipt).toEqual(done.receipt); expect(f.state.calls).toBe(1);
  });
  it("holds a nonfounder decision for a $300 reward", async () => {
    const f = await fixture(); await expect(f.approve("synthetic:reviewer")).rejects.toThrow("FOUNDER_REQUIRED");
    expect(f.approval.db.prepare("SELECT COUNT(*) AS n FROM approval_decisions").get()?.n).toBe(0); expect(f.state.calls).toBe(0);
  });
  it("does not make a raw reward DTO or purchase route an alternate authority", async () => {
    const f = await fixture();
    for (const action of ["decisions", "purchase"]) {
      const result = await handleRewardRoute({ method: "POST", path: `/v1/rewards/redemptions/${f.prepared.redemptionId}/${action}`,
        role: "reviewer", body: action === "decisions" ? { decisionRef: "forged-linear-shaped-ref" } : {}, idempotencyKey: "synthetic-raw-" + action }, f.repository);
      expect(result).toMatchObject({ status: 409, body: { code: "CANONICAL_REWARD_ACTION_REQUIRED", executionCertainty: "notApplied" } });
    }
    expect(f.state.calls).toBe(0);
  });
  it("uses the already-issued reward-purpose stock grant without a second allocation", async () => {
    const f = await fixture(true), approved = await f.approve(), run = await f.handoff(approved);
    expect(approved.manifest.draft.gates.rewardStockAuthority?.state).toBe("satisfied");
    expect(approved.manifest.draft.gates.sampleAuthority.state).toBe("notApplicable");
    await f.dispatch.execute(run.runRef);
    const stock = [...f.grants.values()].filter(g => g.dimension === "stock");
    expect(stock).toHaveLength(1);
    expect([...f.intents.values()][0]?.physicalAllocationRef).toBe(stock[0]!.grantRef);
    expect(f.grants.size).toBe(3);
  });
  it("preserves actual purchase after lost ACK and recovers the same key without another dispatch", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); f.state.lostAck = true;
    expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");
    f.state.lostAck = false;
    const done = await f.dispatch.reconcile(run.runRef);
    expect(done.executionCertainty).toBe("applied"); expect(f.state.calls).toBe(1);
    expect(f.repository.read(f.prepared.redemptionId)!.state).toBe("purchased");
  });
  it("keeps malformed lookup uncertain and never releases a second purchase", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); f.state.failBefore = true;
    await f.dispatch.execute(run.runRef); f.state.malformedLookup = true;
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
    await f.dispatch.execute(run.runRef); expect(f.state.calls).toBe(1);
  });
  it("allows only original-attempt terminal closure before a second same-key attempt", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); f.state.failBefore = true;
    await f.dispatch.execute(run.runRef); f.state.terminalNotApplied = true; f.state.failBefore = false;
    const retry = await f.dispatch.reconcile(run.runRef); expect(retry.executionCertainty).toBe("notApplied");
    expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("applied");
    expect(f.state.calls).toBe(2); expect(f.intents.size).toBe(1);
  });
  it("holds changed quote and revoked current permission before any provider call", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); f.quote.taxMinor++;
    await expect(f.dispatch.execute(run.runRef)).rejects.toThrow(); expect(f.state.calls).toBe(0);
  });
  it("does not forfeit an earned reward when new-acquisition programme is paused", async () => {
    const f = await fixture(); f.policy.pausedForNewAcquisition = true; f.entitlement.programPaused = true;
    const run = await f.handoff(await f.approve());
    expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("applied");
    expect(f.repository.read(f.prepared.redemptionId)!.money.outstandingLiabilityMinor).toBe(30000);
  });
  it("executes an approved queued physical reward after SQLite restart with the same frozen resource requirements", async () => {
    const path = databasePath(), f = await fixture(true, path), run = await f.handoff(await f.approve());
    const restarted = reopen(f, path);
    expect((await restarted.dispatch.execute(run.runRef)).executionCertainty).toBe("applied");
    expect(f.state.calls).toBe(1); expect(f.grants.size).toBe(3);
    expect(restarted.repository.read(f.prepared.redemptionId)!.receipts.physicalAllocationRef).toBe([...f.grants.values()].find(g => g.dimension === "stock")!.grantRef);
  });
  it("recovers a lost native acknowledgment after SQLite restart without current purchase authority or a second purchase", async () => {
    const path = databasePath(), f = await fixture(false, path), run = await f.handoff(await f.approve()); f.state.lostAck = true;
    await f.dispatch.execute(run.runRef);
    const original = [...f.intents.values()][0]!, restarted = reopen(f, path);
    f.policy.execution.state = "denied"; f.state.denySource = true;
    const result = await restarted.dispatch.reconcile(run.runRef);
    expect(result.executionCertainty).toBe("applied"); expect(f.state.calls).toBe(1);
    expect(restarted.repository.canonicalCheckpoint(original.redemptionId, {
      scope: original.scope, redemptionId: original.redemptionId, revision: original.revision, requestHash: original.requestHash,
      dispatchKey: original.dispatchKey, payloadHash: original.payloadHash, providerBindingHash: original.providerBindingHash,
      attemptRef: original.attemptRef, attemptNumber: original.attemptNumber,
    }).receipt?.receiptRef).toBe(result.receipt!.receiptRef);
  });

  it("fences a source withdrawal during the final heartbeat and leaves the original attempt reconcilable", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve());
    const readBasis = f.source.readBasis;
    f.source.readBasis = async input => {
      const result = await readBasis(input);
      if (f.repository.read(f.prepared.redemptionId)!.sourceEffects === "purchase-attempted") f.state.denySource = true;
      return result;
    };
    const first = await f.dispatch.execute(run.runRef);
    expect(first.executionCertainty).toBe("uncertain"); expect(f.state.calls).toBe(0);
    const stored = JSON.parse(String(f.approval.db.prepare("SELECT body FROM reward_redemptions WHERE redemption_id=?").get(f.prepared.redemptionId)!.body));
    expect(stored.canonical.attempts).toHaveLength(1);
    expect(stored.canonical.attempts[0].identity.dispatchKey).toBe(run.dispatchKey);
    f.state.denySource = false; f.source.readBasis = readBasis;
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
    await f.dispatch.execute(run.runRef); expect(f.state.calls).toBe(0);
  });
  it("does not consume current denied policy execution permission as an earned-liability waiver", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve());
    f.policy.execution.state = "denied";
    await expect(f.dispatch.execute(run.runRef)).rejects.toThrow(); expect(f.state.calls).toBe(0);
    expect(f.repository.read(f.prepared.redemptionId)!.money.outstandingLiabilityMinor).toBe(30000);
  });
  it("rejects a terminal negative receipt for another attempt without releasing the original operation", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); f.state.failBefore = true;
    await f.dispatch.execute(run.runRef); f.state.terminalNotApplied = true;
    const originalRead = f.source.readPurchase;
    f.source.readPurchase = async input => ({ ...await originalRead(input) as object, attemptRef: "synthetic-other-attempt", attemptNumber: input.attemptNumber + 1 });
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
    expect(f.repository.read(f.prepared.redemptionId)!.heldReasons).toContain("REWARD_READBACK_IDENTITY_MISMATCH");
    await f.dispatch.execute(run.runRef); expect(f.state.calls).toBe(1);
  });
  it("retains the actual native receipt when read permission disappears after purchase and recovers without another effect", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()), purchase = f.source.purchase;
    f.source.purchase = async input => { const receipt = await purchase(input); f.state.denyRead = true; return receipt; };
    await expect(f.dispatch.execute(run.runRef)).rejects.toMatchObject({ status: 403, executionCertainty: "uncertain" });
    expect(f.repository.read(f.prepared.redemptionId)!.state).toBe("purchased"); expect(f.state.calls).toBe(1);
    await expect(f.dispatch.reconcile(run.runRef)).rejects.toMatchObject({ status: 403, executionCertainty: "uncertain" });
    f.state.denyRead = false;
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied"); expect(f.state.calls).toBe(1);
  });
  it("keeps a provider receipt immutable even if later exact-key readback claims a different charge", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); await f.dispatch.execute(run.runRef);
    const original = [...f.native.values()][0]!;
    const identity = { scope: original.scope, redemptionId: original.redemptionId, revision: original.revision, requestHash: original.requestHash,
      dispatchKey: original.dispatchKey, payloadHash: original.payloadHash, providerBindingHash: original.providerBindingHash,
      attemptRef: original.attemptRef, attemptNumber: original.attemptNumber };
    const changed = { ...original, receipt: { ...original.receipt, chargedMinor: 1 } };
    expect(f.repository.recordCanonicalReadback(original.redemptionId, identity, changed)).toEqual(original);
    expect(f.repository.read(f.prepared.redemptionId)!.money.chargedMinor).toBe(26900);
  });

  it("keeps a newer applied outcome current when a closed earlier attempt is replayed", async () => {
    const f = await fixture(), run = await f.handoff(await f.approve()); f.state.failBefore = true;
    await f.dispatch.execute(run.runRef); f.state.terminalNotApplied = true;
    await f.dispatch.reconcile(run.runRef);
    const stored = JSON.parse(String(f.approval.db.prepare("SELECT body FROM reward_redemptions WHERE redemption_id=?").get(f.prepared.redemptionId)!.body));
    const closed = stored.canonical.attempts[0];
    f.state.failBefore = false; await f.dispatch.execute(run.runRef);
    const current = f.repository.read(f.prepared.redemptionId)!;
    expect(current.state).toBe("purchased");
    expect(f.repository.recordCanonicalReadback(f.prepared.redemptionId, closed.identity, closed.closed)).toEqual(closed.closed);
    expect(f.repository.read(f.prepared.redemptionId)).toEqual(current);
    expect(f.repository.recordCanonicalReadback(f.prepared.redemptionId, closed.identity, { state: "unknown", reasonCode: "SYNTHETIC_OLD_UNKNOWN" })).toMatchObject({ state: "unknown" });
    expect(f.repository.read(f.prepared.redemptionId)).toEqual(current);
    expect(f.repository.recordCanonicalReadback(f.prepared.redemptionId, closed.identity, null)).toMatchObject({ state: "unknown" });
    expect(f.repository.read(f.prepared.redemptionId)).toEqual(current);
    expect(f.repository.canonicalCheckpoint(f.prepared.redemptionId, closed.identity).closed).toEqual(closed.closed);
    expect(f.state.calls).toBe(2);
  });

});
