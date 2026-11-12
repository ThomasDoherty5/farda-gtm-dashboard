// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { externalPayableFixture } from "./fakes.testkit.ts";
import { computeOutstanding } from "./ledger.ts";

const open: { close(): void }[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });
async function fixture() { const f = await externalPayableFixture(); open.push(f.approval.db); return f; }

describe("J12-01 historical eligibility needs evidence and an actual unpaid external balance", () => {
  it("queues a fixture accepted before the commission-only policy with contract, invoice, deliverable and balance evidence", async () => {
    const f = await fixture(), { liability } = f.publish(f.liability());
    expect(liability).toMatchObject({ eligible: true, reasons: [] });
    expect(f.repository.queue().map(l => l.liabilityRef)).toEqual(["synthetic-liability-1"]);
    expect(f.repository.proposeIntent("synthetic-liability-1", "propose").amount).toEqual({ minorUnits: 60_000, currency: "USD" });
  });
  it.each([
    ["contract", "CONTRACT_EVIDENCE_REQUIRED"], ["invoice", "INVOICE_EVIDENCE_REQUIRED"], ["deliverable", "DELIVERABLE_EVIDENCE_REQUIRED"], ["balance", "BALANCE_UNKNOWN"],
  ] as const)("holds when %s evidence is unknown, keeping its reason", async (key, reason) => {
    const f = await fixture(), l = f.liability();
    Object.assign(l.evidence[key], { value: null, unknownReason: "Synthetic source did not return it" });
    expect(f.publish(l).liability.reasons).toContain(reason);
    expect(f.repository.queue()).toEqual([]);
    expect(() => f.repository.proposeIntent(l.liabilityRef, "propose")).toThrow(reason);
  });
  it("never treats an unknown balance as zero, and refuses a source balance that disagrees with the ledger", async () => {
    const f = await fixture(), l = f.liability();
    l.evidence.balance.value = { minorUnits: 59_999, currency: "USD" };
    expect(f.publish(l).liability.reasons).toEqual(["BALANCE_MISMATCH"]);
  });
  it("refuses a liability accepted on or after the commission-only effective time, and holds while that policy is unknown", async () => {
    const f = await fixture(), late = f.liability("synthetic-late");
    late.acceptedObligation.acceptedAt = late.evidence.contract.value!.acceptedAt = "2026-09-01T00:00:00Z";
    expect(f.publish(late).liability.reasons).toContain("ACCEPTED_AFTER_COMMISSION_ONLY");
    f.policyState.policy = { state: "unknown", reason: "Synthetic policy source unavailable" };
    expect(f.publish(f.liability()).liability.reasons).toContain("COMMISSION_POLICY_UNKNOWN");
  });
  it("does not treat UI-entered or manual evidence as source evidence", async () => {
    const f = await fixture(), l = f.liability();
    l.origin = "uiImport"; l.evidence.invoice.method = "uiImport";
    expect(f.publish(l).liability.reasons).toEqual(["EVIDENCE_UNVERIFIED"]);
  });
});

describe("J12-02 new acquisition fees are refused server-side whatever the label or origin", () => {
  it.each(["minimumGuarantee", "paidHybrid"] as const)("refuses a %s labeled historical", async kind => {
    const f = await fixture(), l = f.liability();
    l.componentKind = kind; l.label = "historical accepted fee";
    expect(f.publish(l).liability.reasons).toContain("NEW_ACQUISITION_FEE_PROHIBITED");
  });
  it("refuses a newly increased fee imported through the UI", async () => {
    const f = await fixture(), l = f.liability();
    l.origin = "uiImport"; l.amount.minorUnits = 75_000; l.evidence.invoice.value!.amount.minorUnits = 75_000; l.evidence.balance.value!.minorUnits = 75_000;
    expect(f.publish(l).liability.reasons).toEqual(["FEE_INCREASED"]);
  });
  it("refuses a new fee accepted after the policy even when labeled historical", async () => {
    const f = await fixture(), l = f.liability();
    l.label = "historical"; l.acceptedObligation.acceptedAt = l.evidence.contract.value!.acceptedAt = "2026-10-01T00:00:00Z";
    expect(f.publish(l).liability.reasons).toEqual(["ACCEPTED_AFTER_COMMISSION_ONLY"]);
    expect(f.repository.queue()).toEqual([]);
  });
});

describe("J12-03 native, duplicate and already-settled components never enter the queue", () => {
  it.each([["commission", "external_manual"], ["fixedContentFee", "provider_native"], ["fixedContentFee", "provider_funded"]] as const)(
    "J12-10 native-settled exclusion: %s owned by %s", async (kind, owner) => {
      const f = await fixture(), l = f.liability();
      l.componentKind = kind; l.payoutOwner = owner;
      expect(f.publish(l).liability.reasons).toContain("NATIVE_SETTLEMENT_EXCLUDED");
      expect(f.repository.queue()).toEqual([]);
    });
  it("refuses a duplicate invoice and a duplicate component key under another liability", async () => {
    const f = await fixture();
    f.publish(f.liability("synthetic-liability-1"));
    const copy = f.liability("synthetic-liability-2");
    copy.invoiceRef = copy.evidence.invoice.ref = copy.evidence.balance.ref = f.liability("synthetic-liability-1").invoiceRef;
    copy.acceptedObligation = f.liability("synthetic-liability-1").acceptedObligation;
    copy.evidence.contract.ref = copy.acceptedObligation.contractRef;
    expect(f.publish(copy).liability.reasons).toEqual(["DUPLICATE_COMPONENT", "DUPLICATE_INVOICE"]);
    expect(f.repository.queue().map(l => l.liabilityRef)).toEqual(["synthetic-liability-1"]);
  });
  it("refuses a component the source shows as already paid", async () => {
    const f = await fixture(), l = f.liability();
    l.priorPayments = [{ ref: { ...l.invoiceRef, sourceId: "synthetic-prior-payment" }, amount: { minorUnits: 60_000, currency: "USD" } }];
    l.evidence.balance.value!.minorUnits = 0;
    expect(f.publish(l).liability.reasons).toEqual(["COMPONENT_ALREADY_SETTLED"]);
    const paid = f.liability("synthetic-paid-invoice"); paid.evidence.invoice.value!.state = "paid";
    expect(f.publish(paid).liability.reasons).toContain("COMPONENT_ALREADY_SETTLED");
  });
  it("never mixes currencies", async () => {
    const f = await fixture(), l = f.liability();
    l.evidence.balance.value!.currency = "EUR";
    expect(f.publish(l).liability.reasons).toContain("CURRENCY_MISMATCH");
    expect(computeOutstanding({ ...l, priorPayments: [{ ref: l.invoiceRef, amount: { minorUnits: 1, currency: "EUR" } }] }, [], [])).toBeNull();
  });
});

describe("payload validation", () => {
  it("refuses malformed and cross-account payloads before storing anything", async () => {
    const f = await fixture(), l = f.liability();
    expect(() => f.repository.registerLiability({ ...l, amount: { minorUnits: 1.5, currency: "USD" } })).toThrow("MALFORMED_PAYLOAD");
    expect(() => f.repository.registerLiability({ ...l, payee: { ...l.payee, ref: { ...l.payee.ref, accountId: "synthetic-foreign" } } })).toThrow("CROSS_ACCOUNT_PAYLOAD");
    expect(() => f.repository.registerLiability({ ...l, evidence: { ...l.evidence, contract: { ...l.evidence.contract, unknownReason: "both" } } })).toThrow("MALFORMED_PAYLOAD");
    expect(f.repository.liabilities()).toEqual([]);
  });
  it("is content-idempotent on re-reading the same source facts", async () => {
    const f = await fixture(), first = f.publish(f.liability()).liability;
    f.approval.state.now += 1_000;
    const again = f.publish(f.liability()).liability;
    expect(again.version).toBe(first.version);
  });
});

describe("reservations are live", () => {
  it("a payee change while reserved withdraws the payment and opens a blocking conflict; replaying the reserve key is refused", async () => {
    const f = await fixture(); f.publish(f.liability());
    const intent = f.repository.proposeIntent("synthetic-liability-1", "propose");
    const command = f.repository.reserveApproval(intent.intentRef, "reserve-1");
    expect(f.repository.reserveApproval(intent.intentRef, "reserve-1")).toEqual(command);
    expect(() => f.repository.reserveApproval(intent.intentRef, "reserve-2")).toThrow("INTENT_ALREADY_RESERVED");
    const changed = f.liability(); changed.payee.version = "payee-v2";
    expect(f.publish(changed).withdrawn).toEqual([intent.intentRef]);
    expect(f.repository.intent(intent.intentRef)).toMatchObject({ state: "withdrawn", reasonCode: "BASIS_CHANGED" });
    expect(() => f.repository.reserveApproval(intent.intentRef, "reserve-1")).toThrow("INTENT_NOT_RESERVED");
    const [conflict] = f.repository.conflicts("synthetic-liability-1");
    expect(conflict).toMatchObject({ kind: "basisChanged", blocking: true, state: "open" });
    expect(() => f.repository.proposeIntent("synthetic-liability-1", "propose-2")).toThrow("PAYABLE_CONFLICT_OPEN");
    f.repository.resolveConflict(conflict!.conflictRef, "synthetic:finance-owner", "resolve-1");
    expect(f.repository.proposeIntent("synthetic-liability-1", "propose-2").payee.version).toBe("payee-v2");
  });
  it("one live payment per liability; idempotency keys replay or refuse", async () => {
    const f = await fixture(); f.publish(f.liability());
    const intent = f.repository.proposeIntent("synthetic-liability-1", "propose");
    expect(f.repository.proposeIntent("synthetic-liability-1", "propose")).toEqual(intent);
    expect(() => f.repository.proposeIntent("synthetic-liability-1", "propose-other")).toThrow("PAYMENT_ALREADY_LIVE");
    expect(() => f.repository.proposeIntent("synthetic-other", "propose")).toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("reads the clock only inside the write lock", async () => {
    const f = await fixture(); let outside = 0;
    const repo = new (f.repository.constructor as typeof import("./repository.ts").ExternalPayableRepository)(f.approval.db, {
      scope: f.scope, commissionPolicy: () => f.policyState.policy, allowedAccounts: (await import("./fakes.testkit.ts")).syntheticAccounts, accountingOwnerRef: null,
      now: () => { if (!f.approval.db.isTransaction) outside++; return f.clock(); } });
    repo.registerLiability(f.liability());
    repo.proposeIntent("synthetic-liability-1", "propose");
    repo.reserveApproval(repo.intents("synthetic-liability-1")[0]!.intentRef, "reserve");
    expect(outside).toBe(0);
  });
});
