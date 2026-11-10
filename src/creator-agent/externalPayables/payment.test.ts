// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import { createExternalPayableBridge } from "./approvalBridge.ts";
import { externalPayableFixture } from "./fakes.testkit.ts";

const open: { close(): void }[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });
async function setup(amount = 60_000, options?: Parameters<typeof externalPayableFixture>[0]) {
  const f = await externalPayableFixture(options); open.push(f.approval.db);
  f.publish(f.liability("synthetic-liability-1", amount));
  const intent = f.repository.proposeIntent("synthetic-liability-1", "propose-one");
  return { ...f, intent };
}
async function submitted(amount = 60_000) {
  const f = await setup(amount), run = await f.handoff(await f.approve(f.intent.intentRef));
  await f.dispatch.execute(run.runRef);
  return { ...f, run };
}
const LIABILITY = "synthetic-liability-1";

it("J12-10 allowed historical liability: founder-approved payment is submitted once, then settled only by a source receipt", async () => {
  const f = await setup();
  const approved = await f.approve(f.intent.intentRef);
  expect(approved.current.state).toBe("approved");
  expect(f.repository.status(LIABILITY, "approved").paymentState).toBe("approved");
  const done = await f.dispatch.execute((await f.handoff(approved)).runRef);
  expect(done.executionCertainty).toBe("applied");
  expect(f.provider.submitCalls).toBe(1);
  expect(f.provider.instructions.get(f.intent.providerKey)!.request).toMatchObject({ amount: { minorUnits: 60_000, currency: "USD" }, payeeVersion: "payee-v1", routeRef: "payment-route:synthetic-ach" });
  f.provider.settle(f.intent.providerKey, 60_000);
  await f.bridge.syncSettlement(f.intent.intentRef);
  expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "settled", outstandingBalance: { minorUnits: 0, currency: "USD" } });
  expect(f.provider.submitCalls).toBe(1);
});

describe("J12-04 founder approval binds the exact payment", () => {
  it.each([30_000, 60_000])("a second person who is not the founder cannot approve %i minor units (J04 requires the founder for every settlement)", async amount => {
    const f = await setup(amount);
    await expect(f.approve(f.intent.intentRef, "synthetic:reviewer")).rejects.toThrow("FOUNDER_REQUIRED");
  });
  it("the proposer cannot approve their own payment", async () => {
    const f = await setup();
    await expect(f.approve(f.intent.intentRef, "synthetic:requester")).rejects.toThrow("SECOND_PERSON_REQUIRED");
  });
  it("binds payee, currency, amount, component, route and versions in the approved draft", async () => {
    const f = await setup(), approved = await f.approve(f.intent.intentRef), draft = approved.manifest.draft;
    expect(draft).toMatchObject({ phase: "settlement", effects: { spendsMoney: true }, acquisitionTerms: null, exposure: { state: "known", minor: 60_000 },
      termsVersion: { state: "required", version: "terms-v1" }, providerAccountVersion: "route-v1", historicalLiability: { sourceRef: LIABILITY, acceptedMinor: 60_000 } });
    expect(draft.items).toEqual([expect.objectContaining({ itemRef: f.intent.intentRef, spendMinor: 60_000, targetVersion: "payee-v1", sourceRef: LIABILITY })]);
  });
  it("J12-10 payee tampering after approval withdraws the payment before any submission", async () => {
    const f = await setup(), run = await f.handoff(await f.approve(f.intent.intentRef));
    const tampered = f.liability(); tampered.payee.ref.sourceId = "synthetic-other-payee"; f.sources.set(LIABILITY, tampered);
    await expect(f.dispatch.execute(run.runRef)).rejects.toThrow("INTENT_WITHDRAWN");
    expect(f.provider.submitCalls).toBe(0);
    expect(f.repository.intent(f.intent.intentRef)!.state).toBe("withdrawn");
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "blocked", exceptionReason: "CONFLICT_BASISCHANGED" });
  });
  it("a changed amount after approval withdraws the payment", async () => {
    const f = await setup(), run = await f.handoff(await f.approve(f.intent.intentRef));
    const changed = f.liability(); changed.route.version = "route-v2"; f.sources.set(LIABILITY, changed);
    await expect(f.dispatch.execute(run.runRef)).rejects.toThrow("INTENT_WITHDRAWN");
    expect(f.provider.submitCalls).toBe(0);
  });
  it("a stale approval cannot submit", async () => {
    const f = await setup(), run = await f.handoff(await f.approve(f.intent.intentRef));
    f.approval.state.now += 121_000;
    await expect(f.dispatch.execute(run.runRef)).rejects.toThrow("APPROVAL_EXPIRED");
    expect(f.provider.submitCalls).toBe(0);
  });
  it("a payment route outside the registration is refused at preview", async () => {
    const f = await externalPayableFixture(); open.push(f.approval.db);
    const l = f.liability(); l.route.routeRef = "payment-route:synthetic-wire"; f.publish(l);
    const intent = f.repository.proposeIntent(LIABILITY, "propose");
    await expect(f.approve(intent.intentRef)).rejects.toThrow("PAYMENT_ROUTE_UNAUTHORIZED");
  });
});

describe("J12-05 one durable key, one payment instruction", () => {
  it("J12-10 duplicate submit: concurrent clicks and replayed handoffs share one run and one provider call", async () => {
    const f = await setup(), approved = await f.approve(f.intent.intentRef);
    const [a, b] = await Promise.all([f.handoff(approved, "click-1"), f.handoff(approved, "click-1")]);
    expect(b.runRef).toBe(a.runRef);
    expect((await f.handoff(approved, "zap-retry-2")).runRef).toBe(a.runRef);
    let release!: () => void; f.provider.gate = new Promise(resolve => { release = resolve; });
    const first = f.dispatch.execute(a.runRef);
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await f.dispatch.execute(a.runRef);
    expect(second.executionCertainty).toBe("uncertain");
    release(); await first;
    expect(f.provider.submitCalls).toBe(1);
    expect(f.provider.instructions.size).toBe(1);
  });
  it("an authorized-browser fallback uses the same provider key and cannot create a second instruction", async () => {
    const f = await setup(); f.provider.mode = "lostAck";
    const run = await f.handoff(await f.approve(f.intent.intentRef));
    await f.dispatch.execute(run.runRef);
    const browser = createExternalPayableBridge({ scope: f.scope, repository: f.repository, source: f.source, provider: f.provider,
      registration: { ...f.registration, channel: "authorizedBrowser" }, now: f.clock });
    const fallback = new DispatchGuard({ db: f.approval.db, scope: f.scope, approvals: f.approvals, jobs: f.jobs, ledger: f.ledger, resourceAuthority: f.resources, handlers: browser.handlers, now: f.clock });
    expect((await fallback.execute(run.runRef)).executionCertainty).toBe("uncertain");
    expect(() => f.repository.beginSubmission(f.intent.intentRef, { attemptRef: "synthetic-browser-attempt", attemptNumber: 9, channel: "authorizedBrowser" }, 2_000, () => undefined))
      .toThrow("PAYMENT_ALREADY_SUBMITTED");
    expect((await fallback.reconcile(run.runRef)).executionCertainty).toBe("applied");
    expect(f.provider.submitCalls).toBe(1);
    expect(f.provider.instructions.size).toBe(1);
  });
});

describe("J12-06 submitted and settled are separate", () => {
  it("submission does not reduce the payable; only a source settlement receipt does", async () => {
    const f = await submitted();
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "submitted", settlementReceipt: null, accountingMatch: null, outstandingBalance: { minorUnits: 60_000 } });
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.receipts()).toEqual([]);
    const receiptRef = f.provider.settle(f.intent.providerKey, 60_000);
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "settled", settlementReceipt: receiptRef, outstandingBalance: { minorUnits: 0 } });
  });
  it("a provider rejection is failed, keeps the balance, and is never retried under the same approval", async () => {
    const f = await setup(); f.provider.mode = "reject";
    const run = await f.handoff(await f.approve(f.intent.intentRef));
    await f.dispatch.execute(run.runRef);
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "failed", exceptionReason: "SYNTHETIC_PAYEE_REJECTED", outstandingBalance: { minorUnits: 60_000 } });
    await f.dispatch.reconcile(run.runRef);
    f.provider.mode = "accept";
    await expect(f.dispatch.execute(run.runRef)).rejects.toThrow("INTENT_NOT_SUBMITTABLE");
    expect(f.provider.submitCalls).toBe(1);
  });
});

describe("J12-07 uncertain submissions are bounded by their deadline and never paid twice", () => {
  it("J12-10 unknown result: a lost acknowledgement stays uncertain with no blind retry; the found instruction resolves the original action", async () => {
    const f = await setup(); f.provider.mode = "lostAck";
    const run = await f.handoff(await f.approve(f.intent.intentRef));
    expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("uncertain");
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "uncertain", exceptionReason: "PAYMENT_OUTCOME_UNCERTAIN" });
    f.provider.mode = "accept";
    await f.dispatch.execute(run.runRef);
    expect(f.provider.submitCalls).toBe(1);
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
    expect(f.repository.intent(f.intent.intentRef)).toMatchObject({ state: "submitted", submissionRef: f.provider.instructions.get(f.intent.providerKey)!.submissionRef });
  });
  it("an empty lookup proves nothing until the deadline plus margin; then a renewed preflight retries under the same key", async () => {
    const f = await setup(); f.provider.mode = "timeoutNotApplied";
    const run = await f.handoff(await f.approve(f.intent.intentRef));
    await f.dispatch.execute(run.runRef);
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
    expect(f.repository.intent(f.intent.intentRef)!.state).toBe("uncertain");
    f.approval.state.now += 2_000 + 1_000;
    const closed = await f.dispatch.reconcile(run.runRef);
    expect(closed.executionCertainty).toBe("notApplied");
    expect(f.repository.intent(f.intent.intentRef)).toMatchObject({ state: "reserved", reasonCode: "PAYMENT_NOT_APPLIED" });
    f.provider.mode = "accept"; const reads = f.sourceState.reads;
    expect((await f.dispatch.execute(run.runRef)).executionCertainty).toBe("applied");
    expect(f.sourceState.reads).toBeGreaterThan(reads);
    expect(f.provider.submitCalls).toBe(2);
    expect(f.provider.instructions.size).toBe(1);
    expect(f.repository.attempts(f.intent.intentRef).map(a => a.outcome)).toEqual(["notApplied", "accepted"]);
  });
  it("a timed-out submission that lands before its deadline is found, not paid again", async () => {
    const f = await setup(); f.provider.mode = "timeoutNotApplied";
    const run = await f.handoff(await f.approve(f.intent.intentRef));
    await f.dispatch.execute(run.runRef);
    f.provider.landLate({ providerKey: f.intent.providerKey, payee: f.intent.payee.ref, payeeVersion: "payee-v1", amount: f.intent.amount, routeRef: f.intent.route.routeRef,
      routeVersion: "route-v1", deadline: f.at(), channel: "api" });
    f.approval.state.now += 5_000;
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("applied");
    expect(f.provider.submitCalls).toBe(1);
  });
  it("an unavailable lookup keeps the payment uncertain even after the deadline", async () => {
    const f = await setup(); f.provider.mode = "timeoutNotApplied"; f.provider.lookupUnavailable = true;
    const run = await f.handoff(await f.approve(f.intent.intentRef));
    await f.dispatch.execute(run.runRef);
    f.approval.state.now += 60_000;
    expect((await f.dispatch.reconcile(run.runRef)).executionCertainty).toBe("uncertain");
    expect(() => f.repository.proposeIntent(LIABILITY, "propose-two")).toThrow("PAYMENT_ALREADY_LIVE");
  });
  it("a late outcome for a payment withdrawn while uncertain becomes a blocking conflict and keeps the receipt", async () => {
    const f = await setup(); f.provider.mode = "lostAck";
    await f.dispatch.execute((await f.handoff(await f.approve(f.intent.intentRef))).runRef);
    const changed = f.liability(); changed.payee.version = "payee-v2"; f.publish(changed);
    expect(f.repository.intent(f.intent.intentRef)!.state).toBe("withdrawn");
    const receiptRef = f.provider.settle(f.intent.providerKey, 60_000);
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.intent(f.intent.intentRef)!.state).toBe("withdrawn");
    expect(f.repository.receipts().map(r => r.receiptRef)).toEqual([receiptRef]);
    expect(new Set(f.repository.conflicts(LIABILITY).filter(c => c.state === "open" && c.blocking).map(c => c.kind))).toEqual(new Set(["basisChanged", "lateOutcome"]));
  });
  it("reads the clock only inside the write lock and holds no transaction during provider calls", async () => {
    const f = await setup(); let open = 0;
    const submit = f.provider.submit.bind(f.provider), lookup = f.provider.lookup.bind(f.provider);
    f.provider.submit = async request => { if (f.approval.db.isTransaction) open++; return submit(request); };
    f.provider.lookup = async key => { if (f.approval.db.isTransaction) open++; return lookup(key); };
    await f.dispatch.execute((await f.handoff(await f.approve(f.intent.intentRef))).runRef);
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(open).toBe(0);
  });
});

describe("J12-08 partial and failed payments keep settled portions and the true balance", () => {
  it("J12-10 partial settlement leaves the remainder payable under a new approval; reversals link to the original receipt", async () => {
    const f = await submitted();
    const first = f.provider.settle(f.intent.providerKey, 36_000, "partial");
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "partial", settlementReceipt: first, outstandingBalance: { minorUnits: 24_000 } });
    const reversal = { adjustmentRef: "synthetic-reversal-1", receiptRef: first, amount: { minorUnits: 10_000, currency: "USD" }, kind: "reversal" as const,
      effectiveAt: f.at(), evidence: { provider: "synthetic-payout", accountId: "synthetic-operating", sourceId: "synthetic-reversal-evidence", url: null } };
    f.repository.recordAdjustment(reversal, "adjust-1");
    expect(f.repository.recordAdjustment(reversal, "adjust-1")).toEqual(reversal);
    expect(() => f.repository.recordAdjustment({ ...reversal, adjustmentRef: "synthetic-reversal-2", amount: { minorUnits: 26_001, currency: "USD" } }, "adjust-2")).toThrow("ADJUSTMENT_EXCEEDS_RECEIPT");
    expect(() => f.repository.recordAdjustment({ ...reversal, adjustmentRef: "synthetic-reversal-3", receiptRef: "synthetic-unknown-receipt" }, "adjust-3")).toThrow("RECEIPT_NOT_FOUND");
    expect(f.repository.outstanding(LIABILITY)).toEqual({ minorUnits: 34_000, currency: "USD" });
    expect(f.repository.receipts().map(r => [r.receiptRef, r.amount.minorUnits])).toEqual([[first, 36_000]]);
    // The source now shows our receipt as paid and the reversal as owed again. A remainder payment needs its own approval.
    const later = f.liability(); later.priorPayments = [{ ref: { ...later.invoiceRef, sourceId: first }, amount: { minorUnits: 36_000, currency: "USD" } }];
    later.evidence.balance.value!.minorUnits = 34_000; f.publish(later);
    const remainder = f.repository.proposeIntent(LIABILITY, "propose-remainder");
    expect(remainder.amount).toEqual({ minorUnits: 34_000, currency: "USD" });
    expect(remainder.providerKey).not.toBe(f.intent.providerKey);
    await f.dispatch.execute((await f.handoff(await f.approve(remainder.intentRef, "synthetic:founder", "two"), "handoff-two")).runRef);
    expect(f.provider.instructions.get(remainder.providerKey)!.request.amount.minorUnits).toBe(34_000);
  });
  it("a payment that fails after submission keeps the whole balance outstanding", async () => {
    const f = await submitted();
    f.provider.settle(f.intent.providerKey, 0, "failed");
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "failed", outstandingBalance: { minorUnits: 60_000 } });
    expect(f.repository.receipts()).toEqual([]);
  });
  it("a pending submission with some receipts stays live, so no second payment can start", async () => {
    const f = await submitted();
    f.provider.settle(f.intent.providerKey, 20_000, "pending");
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "submitted", outstandingBalance: { minorUnits: 40_000 } });
    expect(() => f.repository.proposeIntent(LIABILITY, "propose-two")).toThrow("PAYMENT_ALREADY_LIVE");
  });
  it("settlement above the approved amount opens a blocking conflict", async () => {
    const f = await submitted();
    f.provider.settle(f.intent.providerKey, 60_000); f.provider.settle(f.intent.providerKey, 1_000);
    await f.bridge.syncSettlement(f.intent.intentRef);
    expect(f.repository.status(LIABILITY)).toMatchObject({ paymentState: "blocked", exceptionReason: "CONFLICT_OVERSETTLEMENT" });
  });
});
