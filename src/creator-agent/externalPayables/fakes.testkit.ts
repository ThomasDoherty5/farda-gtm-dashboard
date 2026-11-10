import { digest } from "../config.ts";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import type { ApprovalRead } from "../approvals/contract.ts";
import { CapabilityLedger } from "../connections/ledger.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "../connections/schema.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import type { ResourceAuthority, ResourceGrant } from "../jobs/dispatchSchema.ts";
import { EXTERNAL_PAYABLE_ACTION, EXTERNAL_PAYABLE_HANDLER, type CommissionPolicyObservation, type ExecutorChannel, type LiabilitySource, type LookupResult,
  type Money, type PaymentProvider, type Ref, type SubmitRequest } from "./contract.ts";
import { ExternalPayableRepository } from "./repository.ts";
import { createExternalPayableBridge, type ExternalPayableRegistration } from "./approvalBridge.ts";

/** Fictional accounts and identities only. No provider, bank, payee or ledger here is real. */
export const syntheticAccounts = [
  { provider: "synthetic-contracts", accountId: "synthetic-docs" }, { provider: "synthetic-bills", accountId: "synthetic-ap" },
  { provider: "synthetic-content", accountId: "synthetic-deliverables" }, { provider: "synthetic-payees", accountId: "synthetic-directory" },
  { provider: "synthetic-payout", accountId: "synthetic-operating" }, { provider: "synthetic-books", accountId: "synthetic-ledger" },
] as const;
const ref = (account: number, sourceId: string): Ref => ({ provider: syntheticAccounts[account]!.provider, accountId: syntheticAccounts[account]!.accountId, sourceId, url: null });
const usd = (minorUnits: number): Money => ({ minorUnits, currency: "USD" });

type Instruction = { providerKey: string; submissionRef: string; request: SubmitRequest; status: "pending" | "settled" | "partial" | "failed";
  settlements: { receiptRef: string; amount: Money; settledAt: string }[]; reasonCode: string | null; channels: ExecutorChannel[] };
/**
 * Deterministic fake payment provider. Idempotent on the provider key across channels: a repeat submit returns the existing instruction.
 * `mode` simulates a lost acknowledgement (applied, then throws), a timeout that never applied, a rejection, or a late landing.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly maxSubmitMs = 2_000;
  submitCalls = 0; lookupCalls = 0;
  mode: "accept" | "reject" | "lostAck" | "timeoutNotApplied" = "accept";
  lookupUnavailable = false;
  gate: Promise<void> | null = null;
  readonly instructions = new Map<string, Instruction>();
  private readonly clock: () => number;
  constructor(clock: () => number) { this.clock = clock; }
  async submit(request: SubmitRequest): Promise<unknown> {
    this.submitCalls++;
    if (Date.parse(request.deadline) <= this.clock()) throw new Error("Synthetic deadline passed; not applied.");
    if (this.mode === "timeoutNotApplied") throw new Error("Synthetic timeout before the provider applied anything.");
    if (this.mode === "reject") return { state: "rejected", providerKey: request.providerKey, reasonCode: "SYNTHETIC_PAYEE_REJECTED" };
    let found = this.instructions.get(request.providerKey);
    if (!found) {
      found = { providerKey: request.providerKey, submissionRef: `synthetic-submission:${digest(request.providerKey).slice(0, 24)}`, request: structuredClone(request),
        status: "pending", settlements: [], reasonCode: null, channels: [] };
      this.instructions.set(request.providerKey, found);
    }
    found.channels.push(request.channel);
    await this.gate;
    if (this.mode === "lostAck") throw new Error("Synthetic lost acknowledgement after the provider applied it.");
    return { state: "accepted", providerKey: request.providerKey, submissionRef: found.submissionRef, acceptedAt: new Date(this.clock()).toISOString() };
  }
  async lookup(providerKey: string): Promise<unknown> {
    this.lookupCalls++;
    if (this.lookupUnavailable) return { state: "unknown", reasonCode: "SYNTHETIC_LOOKUP_UNAVAILABLE" } satisfies LookupResult;
    const found = this.instructions.get(providerKey), observedAt = new Date(this.clock()).toISOString();
    if (!found) return { state: "notFound", providerKey, complete: true, observedAt } satisfies LookupResult;
    return { state: "found", providerKey, submissionRef: found.submissionRef, status: found.status, settlements: structuredClone(found.settlements), reasonCode: found.reasonCode, observedAt } satisfies LookupResult;
  }
  /** Source-side settlement event for a fictional instruction. */
  settle(providerKey: string, minor: number, status: Instruction["status"] = "settled", receiptRef = `synthetic-receipt:${digest([providerKey, minor, this.instructions.get(providerKey)?.settlements.length]).slice(0, 24)}`) {
    const found = this.instructions.get(providerKey)!;
    if (minor > 0) found.settlements.push({ receiptRef, amount: usd(minor), settledAt: new Date(this.clock()).toISOString() });
    found.status = status; found.reasonCode = status === "partial" || status === "failed" ? "SYNTHETIC_PARTIAL_RETURN" : null;
    return receiptRef;
  }
  /** Simulates a submission that lands at the provider without our call returning, e.g. from an earlier timed-out attempt. */
  landLate(request: SubmitRequest) { this.instructions.set(request.providerKey, { providerKey: request.providerKey, submissionRef: `synthetic-submission:${digest(request.providerKey).slice(0, 24)}`,
    request, status: "pending", settlements: [], reasonCode: null, channels: [request.channel] }); }
}

export const COMMISSION_ONLY_EFFECTIVE = "2026-09-01T00:00:00Z";
/** Builds a fictional historical liability with complete source evidence and a matching unpaid balance. */
export function syntheticLiability(at: string, until: string, id = "synthetic-liability-1", amount = 60_000): LiabilitySource {
  const evidence = <T>(r: Ref, value: T) => ({ ref: r, observedAt: at, sourceUpdatedAt: at, method: "api" as const, value, unknownReason: null });
  const contract = ref(0, `${id}-contract`), invoice = ref(1, `${id}-invoice`), deliverable = ref(2, `${id}-deliverable`);
  return { liabilityRef: id, origin: "source", label: "historical", payee: { ref: ref(3, `${id}-payee`), version: "payee-v1" },
    payoutOwner: "external_manual", componentKind: "fixedContentFee",
    acceptedObligation: { contractRef: contract, acceptedAt: "2026-06-15T00:00:00Z", termsVersion: "terms-v1", componentKey: `${id}-component` },
    acceptedAmount: usd(amount), invoiceRef: invoice, amount: usd(amount), deliverableRef: deliverable,
    route: { routeRef: "payment-route:synthetic-ach", version: "route-v1", account: ref(4, "synthetic-paying-account") },
    evidence: { contract: evidence(contract, { state: "accepted" as const, acceptedAt: "2026-06-15T00:00:00Z" }),
      invoice: evidence(invoice, { state: "open" as const, amount: usd(amount) }), deliverable: evidence(deliverable, { state: "accepted" as const }),
      balance: evidence(invoice, usd(amount)) },
    priorPayments: [], observedAt: at, validUntil: until };
}

/** Actual scoped SQLite, J04 approvals, capability ledger, jobs and dispatch guard, with fictional source, payment and resource owners. */
export async function externalPayableFixture(options: { accountingOwnerRef?: string | null; channel?: ExecutorChannel } = {}) {
  const approval = approvalFixture(), at = approval.at, until = approval.until, clock = () => approval.state.now;
  const policyState: { policy: CommissionPolicyObservation } = { policy: { state: "effective", policyVersion: "synthetic-commission-only-v1", effectiveAt: COMMISSION_ONLY_EFFECTIVE } };
  const sources = new Map<string, LiabilitySource>(), sourceState = { unavailable: false, reads: 0 };
  const source = { read: async (liabilityRef: string) => { sourceState.reads++; if (sourceState.unavailable) throw new Error("Synthetic source outage"); return structuredClone(sources.get(liabilityRef) ?? null); } };
  const repository = new ExternalPayableRepository(approval.db, { scope, now: clock, commissionPolicy: () => structuredClone(policyState.policy), allowedAccounts: syntheticAccounts,
    accountingOwnerRef: options.accountingOwnerRef === undefined ? "synthetic:finance-owner" : options.accountingOwnerRef, settleMarginMs: 1_000 });
  const provider = new FakePaymentProvider(clock);
  const binding: ExpectedBinding = { ...scope, provider: "synthetic-payout", providerAccountId: "synthetic-payout-account", action: EXTERNAL_PAYABLE_ACTION, mode: "executeApproved",
    route: "api", routeRef: "route:synthetic-payout", authorizationScopeVersion: "scope-v1", toolVersion: "tool-v1", requiredScopes: ["synthetic-pay"], connectionRef: null, secretRef: null };
  const reconcileBinding: ExpectedBinding = { ...binding, mode: "reconcile", requiredScopes: ["synthetic-read-payment"] };
  const registration: ExternalPayableRegistration = { policyVersion: approval.policy.version, configVersion: "synthetic-config-v1", linearIssueRef: "synthetic:payable-issue",
    binding, reconcileBinding, paymentRouteRef: "payment-route:synthetic-ach", budgetResourceRef: "synthetic-fee-budget", quotaResourceRef: "synthetic-payout-quota",
    budgets: { maxItems: 1, maxSteps: 20, maxAttempts: 4, maxRunMs: 120_000, leaseMs: 10_000, maxConcurrency: 1, retryBaseMs: 0 }, approvalTtlMs: 120_000, channel: options.channel ?? "api" };
  const bridge = createExternalPayableBridge({ scope, repository, source, provider, registration, now: clock });
  const receipts = new Map<string, VerificationReceipt>();
  const ledger = new CapabilityLedger(approval.db, scope, { now: clock, resolveReceipt: r => receipts.get(r) ?? null });
  for (const b of [binding, reconcileBinding]) {
    const row = ledger.register({ binding: b, ownerRef: "owner:synthetic", costBasis: { state: "unknown", reasonCode: "SYNTHETIC_NO_COST_BASIS" } }, 0);
    const receiptRef = "receipt:" + b.mode;
    receipts.set(receiptRef, { receiptRef, binding: b, outcome: "Ready", checkedAt: at(), expiresAt: until(), verifiedScopes: b.requiredScopes,
      connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: ["SYNTHETIC_VERIFIED"] });
    await ledger.verify(row.capabilityId, receiptRef, 1);
  }
  const grants = new Map<string, ResourceGrant>();
  const resources: ResourceAuthority = {
    resolveGrants: async request => Object.entries(request.requirements).flatMap(([dimension, need]) => {
      if (need.state !== "required") return [];
      const id = `${request.dispatchKey}:${dimension}`;
      if (!grants.has(id)) grants.set(id, { grantRef: "synthetic-grant:" + digest(id), issuerRef: "synthetic-budget-owner", allocationVersion: "allocation-v1", scope,
        dispatchKey: request.dispatchKey, dimension: dimension as ResourceGrant["dimension"], resourceRef: need.resourceRef, quantity: need.quantity, unit: need.unit,
        currency: need.currency, observedAt: at(), validUntil: until(), exclusive: true,
        ...(dimension === "quota" ? { quotaBasis: { publishedLimit: 100, operatingLimit: 80, allocatedTotal: 1, windowRef: "synthetic-window", windowStart: at(), windowEnd: until(), sharedAcrossRoutes: true as const } } : {}) });
      return [structuredClone(grants.get(id)!)];
    }),
    assertCurrent: current => { for (const g of current) if (![...grants.values()].some(x => digest(x) === digest(g))) throw new Error("Synthetic grant withdrawn"); },
  };
  const jobs = new JobRepository(approval.db, { scope, now: clock, resolveCapability: b => ledger.requireReady(b) });
  const approvals: ApprovalRepository = new ApprovalRepository(approval.db, { ...approval.options, registry: bridge.registry, verifyOutcome: out => dispatch.verifyOutcome(out) });
  const dispatch: DispatchGuard = new DispatchGuard({ db: approval.db, scope, approvals, jobs, ledger, resourceAuthority: resources, handlers: bridge.handlers, now: clock });

  function publish(liability: LiabilitySource) { sources.set(liability.liabilityRef, structuredClone(liability)); return repository.registerLiability(liability); }
  async function approve(intentRef: string, approver = "synthetic:founder", key = "one") {
    const command = repository.reserveApproval(intentRef, `reserve-${key}`);
    const preview = await approvals.preparePreview(command, { principalRef: "synthetic:requester" }, `preview-${key}`);
    const requested = await approvals.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: preview.manifest.manifestVersion }, { principalRef: "synthetic:requester" }, `request-${key}`);
    const event = approval.event(requested, "approved", approver, `synthetic:event-${key}`);
    return approvals.observeDecision(event.locator, { ingressRef: "synthetic:verified-relay" });
  }
  function handoff(read: ApprovalRead, key = "handoff-one", handlerRef = EXTERNAL_PAYABLE_HANDLER) {
    return dispatch.handoff({ approval: approvalDispatchBinding(read.manifest, read.manifest.items[0]!.itemRef), handlerRef, payloadRef: read.manifest.draft.payloadRef },
      { principalRef: "synthetic:requester", idempotencyKey: key });
  }
  return { approval, scope, clock, at, until, policyState, sources, sourceState, source, repository, provider, registration, bridge, ledger, resources, grants, jobs, approvals, dispatch,
    publish, approve, handoff, liability: (id?: string, amount?: number) => syntheticLiability(at(), until(), id, amount) };
}
