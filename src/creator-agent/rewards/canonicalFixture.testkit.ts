import { digest } from "../config.ts";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import type { ApprovalRead } from "../approvals/contract.ts";
import { CapabilityLedger } from "../connections/ledger.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "../connections/schema.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import { DispatchError, type ResourceAuthority, type ResourceGrant } from "../jobs/dispatchSchema.ts";
import type { CommercialPolicySource, RewardPolicySnapshot } from "../commercialPolicy/contract.ts";
import type { Entitlement, PrepareInput, Quote } from "./contract.ts";
import { RewardRedemptionRepository, type RewardAuthority } from "./repository.ts";
import { createRewardDomainBridge, type RewardRegistration } from "./approvalBridge.ts";
import { REWARD_ACTION, REWARD_HANDLER, type CanonicalPurchaseApplied, type RewardDomainSource, type RewardPurchaseIntent, type RewardSourceSnapshot } from "./canonicalContract.ts";

/** Actual scoped SQLite/J04/jobs with fictional native source boundaries only. No credential, purchase or deployment. */
export async function canonicalRewardFixture(path = ":memory:", physical = false) {
  const approval = approvalFixture(path), at = approval.at, until = approval.until;
  const state = { sourceVersion: "source-v1", denySource: false, denyRead: false, calls: 0, lostAck: false, failBefore: false,
    malformedLookup: false, terminalNotApplied: false, beforeRead: null as null | (() => void | Promise<void>),
    purchaseGate: null as null | Promise<void>, allocationWrong: false };
  const rewardScope = { workspaceId: scope.workspaceId, accountId: scope.accountId };
  const option = { optionId: "synthetic-reward", milestone: "tech" as const, kind: "item" as const, label: "Synthetic earned item",
    providerRef: "synthetic-provider", deliveryRoute: physical ? "farda-physical" as const : "provider-direct" as const };
  const entitlement: Entitlement = { scope: rewardScope, entitlementRef: "synthetic-entitlement", sourceRef: "synthetic-j11-award",
    creatorId: "synthetic-creator", programRef: "synthetic-programme", milestone: "tech", amountMinor: 30000, currency: "USD",
    rewardVersion: "synthetic-earned-v1", state: "mature", qualifiedAt: "2026-11-01T00:00:00Z", fulfilled: false, programPaused: false, reserveMinor: 30000 };
  const quote: Quote = { scope: rewardScope, quoteRef: "synthetic-quote", optionId: option.optionId, providerRef: option.providerRef,
    available: true, currency: "USD", itemMinor: 24900, taxMinor: 2000, shippingMinor: 0, bookingMinor: 0, adminMinor: 0,
    creatorFundedMinor: 0, validUntil: until() };
  const policy: RewardPolicySnapshot = { scope, programmeRef: entitlement.programRef, rewardVersion: entitlement.rewardVersion,
    sourceRef: "synthetic-reward-policy", sourceVersion: "reward-source-v1", observedAt: at(), validUntil: until(),
    terms: { state: "effective", adoptionRef: "synthetic-adoption", effectiveAt: "2026-10-01T00:00:00Z", fundingRef: "synthetic-funding-policy",
      economicsRef: "synthetic-economics", conditionsRef: "synthetic-conditions", currency: "USD", base: "matured-retained-eligible-merchandise",
      allInCaps: true, preservesEarnedObligations: true, milestones: [{ milestone: "tech", thresholdMinor: 500000, additionalCapMinor: 30000 }], options: [option] },
    pausedForNewAcquisition: false, execution: { state: "permitted", permissionRef: "synthetic-reward-permission", sourceVersion: "execution-v1", observedAt: at(), validUntil: until() } };
  const commercialPolicy: CommercialPolicySource = {
    readCurrent: () => null,
    readRewardPolicy: input => input.programmeRef === policy.programmeRef && input.rewardVersion === policy.rewardVersion ? structuredClone(policy) : null,
    assertCurrent: () => { throw new Error("Acquisition policy is not this fixture's authority."); },
    assertRewardCurrent: p => { if (!samePolicy(p)) throw new DispatchError("REWARD_POLICY_CHANGED"); },
  };
  function samePolicy(p: RewardPolicySnapshot) { return digest(p) === digest(policy); }
  const binding: ExpectedBinding = { ...scope, provider: "synthetic-provider", providerAccountId: "synthetic-provider-account", action: REWARD_ACTION,
    mode: "executeApproved", route: "api", routeRef: "route:synthetic-reward", authorizationScopeVersion: "scope-v1", toolVersion: "tool-v1",
    requiredScopes: ["synthetic-purchase"], connectionRef: null, secretRef: null };
  const reconcileBinding: ExpectedBinding = { ...binding, mode: "reconcile", requiredScopes: ["synthetic-readback"] };
  const provider = { scope: rewardScope, providerRef: option.providerRef, deliveryRoute: option.deliveryRoute, action: "purchase-reward" as const,
    bindingRef: "synthetic-provider-binding", fundingRef: "synthetic-funding", validUntil: until(), state: "Ready" as const, fundingVerified: true, ownerRef: "synthetic-owner" };
  const native = new Map<string, CanonicalPurchaseApplied>(), intents = new Map<string, RewardPurchaseIntent>();
  const source: RewardDomainSource = {
    idempotency: "source-enforced",
    readBasis: async input => {
      await state.beforeRead?.();
      if (state.denySource) throw new DispatchError("REWARD_SOURCE_AUTHORITY_REQUIRED", 403);
      return { ...input, sourceRef: "synthetic-j11-provider-basis", sourceVersion: state.sourceVersion, observedAt: at(), validUntil: until(),
        entitlement: structuredClone(entitlement), quote: structuredClone(quote), provider: structuredClone(provider), providerBinding: binding,
        stock: physical ? { state: "required", sourceRef: "synthetic-j15-reward-authority", sourceVersion: "stock-v1", purpose: "creator-reward",
          resourceRef: "synthetic-reward-stock", skuRef: "synthetic-kit", locationRef: "synthetic-home", quantity: 1, productVersion: "product-v1", validUntil: until() }
          : { state: "notApplicable", policyVersion: approval.policy.version, reason: "The fictional provider supplies its own item." } } satisfies RewardSourceSnapshot;
    },
    assertCurrent: snapshot => {
      if (state.denySource) throw new DispatchError("REWARD_SOURCE_AUTHORITY_REQUIRED", 403);
      if (snapshot.sourceVersion !== state.sourceVersion || digest(snapshot.entitlement) !== digest(entitlement) || digest(snapshot.quote) !== digest(quote) ||
          digest(snapshot.provider) !== digest(provider)) throw new DispatchError("REWARD_SOURCE_CHANGED");
    },
    purchase: async input => {
      if (state.denySource || input.expectedSourceVersion !== state.sourceVersion || input.expectedPolicyVersion !== policy.rewardVersion ||
          input.expectedExecutionVersion !== policy.execution.sourceVersion || policy.execution.state !== "permitted") throw new Error("Synthetic conditional source refused.");
      state.calls++; intents.set(input.dispatchKey, structuredClone(input));
      if (state.failBefore) throw new Error("Synthetic unconfirmed connection failure.");
      const previous = native.get(input.dispatchKey);
      const result: CanonicalPurchaseApplied = previous ?? { state: "applied", scope, redemptionId: input.redemptionId, revision: input.revision,
        requestHash: input.requestHash, dispatchKey: input.dispatchKey, payloadHash: input.payloadHash, providerBindingHash: input.providerBindingHash,
        attemptRef: input.attemptRef, attemptNumber: input.attemptNumber, receiptRef: "synthetic-receipt:" + digest(input.dispatchKey), observedAt: at(),
        receipt: { purchaseKey: input.dispatchKey, providerRef: provider.providerRef, providerBindingRef: provider.bindingRef,
          providerOrderRef: "synthetic-order:" + digest(input.dispatchKey), transactionRef: "synthetic-transaction:" + digest(input.dispatchKey),
          chargedMinor: quote.itemMinor - quote.creatorFundedMinor + quote.taxMinor + quote.shippingMinor + quote.bookingMinor + quote.adminMinor,
          currency: "USD", purchasedAt: at() } };
      native.set(input.dispatchKey, result);
      await state.purchaseGate;
      if (state.lostAck) throw new Error("Synthetic lost purchase acknowledgment.");
      return structuredClone(result);
    },
    readPurchase: async input => {
      if (state.denyRead) throw new DispatchError("REWARD_READ_PERMISSION_REQUIRED", 403);
      if (state.malformedLookup) return null;
      const found = native.get(input.dispatchKey); if (found) return structuredClone(found);
      if (!state.terminalNotApplied) return { state: "unknown", reasonCode: "SYNTHETIC_OUTCOME_UNKNOWN" };
      const identity = { scope: input.scope, redemptionId: input.redemptionId, revision: input.revision, requestHash: input.requestHash,
        dispatchKey: input.dispatchKey, payloadHash: input.payloadHash, providerBindingHash: input.providerBindingHash,
        attemptRef: input.attemptRef, attemptNumber: input.attemptNumber };
      return { ...identity, state: "notApplied", receiptRef: `synthetic-closed:${input.attemptRef}`, observedAt: at(), validUntil: until(), complete: true, originalAttemptClosed: true };
    },
    assertReadCurrent: () => { if (state.denyRead) throw new DispatchError("REWARD_READ_PERMISSION_REQUIRED", 403); },
  };
  const outcomes = new Map<string, unknown>(), cash = new Map<string, unknown>();
  const authority: RewardAuthority = { commercialPolicy, entitlement: ref => ref === entitlement.entitlementRef ? structuredClone(entitlement) : null,
    quote: ref => ref === quote.quoteRef ? structuredClone(quote) : null, provider: () => structuredClone(provider),
    outcome: ref => outcomes.get(ref), cashMovement: ref => cash.get(ref) };
  const repository = new RewardRedemptionRepository(approval.db, rewardScope, authority, () => new Date(approval.state.now));
  const registration: RewardRegistration = { policyVersion: approval.policy.version, configVersion: "synthetic-reward-config-v1", linearIssueRef: "synthetic-reward-issue",
    binding, reconcileBinding, providerRef: provider.providerRef, providerBindingRef: provider.bindingRef, budgetResourceRef: "synthetic-reward-budget", quotaResourceRef: "synthetic-provider-quota",
    budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 3, maxRunMs: 60000, leaseMs: 10000, maxConcurrency: 1, retryBaseMs: 0 } };
  const bridge = createRewardDomainBridge({ scope, repository, source, commercialPolicy, registration, now: () => approval.state.now });
  const receipts = new Map<string, VerificationReceipt>();
  const ledger = new CapabilityLedger(approval.db, scope, { now: () => approval.state.now, resolveReceipt: ref => receipts.get(ref) ?? null });
  for (const b of [binding, reconcileBinding]) {
    const row = ledger.register({ binding: b, ownerRef: "owner:synthetic", costBasis: { state: "unknown", reasonCode: "SYNTHETIC_NO_COST_BASIS" } }, 0);
    const ref = "receipt:" + b.mode;
    receipts.set(ref, { receiptRef: ref, binding: b, outcome: "Ready", checkedAt: at(), expiresAt: until(), verifiedScopes: b.requiredScopes,
      connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: ["SYNTHETIC_VERIFIED"] });
    await ledger.verify(row.capabilityId, ref, 1);
  }
  const grants = new Map<string, ResourceGrant>();
  const resources: ResourceAuthority = {
    resolveGrants: async request => Object.entries(request.requirements).flatMap(([dimension, need]) => {
      if (need.state !== "required") return [];
      const id = `${request.dispatchKey}:${dimension}`;
      if (!grants.has(id)) grants.set(id, { grantRef: "synthetic-grant:" + digest(id), issuerRef: "synthetic-resource-owner", allocationVersion: "allocation-v1",
        scope, dispatchKey: request.dispatchKey, dimension: dimension as ResourceGrant["dimension"], resourceRef: need.resourceRef,
        quantity: need.quantity, unit: need.unit, currency: need.currency, observedAt: at(), validUntil: until(), exclusive: true,
        ...(dimension === "quota" ? { quotaBasis: { publishedLimit: 100, operatingLimit: 80, allocatedTotal: 1, windowRef: "synthetic-window", windowStart: at(), windowEnd: until(), sharedAcrossRoutes: true as const } } : {}) });
      return [structuredClone(grants.get(id)!)];
    }),
    assertCurrent: current => { for (const grant of current) if (state.allocationWrong || ![...grants.values()].some(g => digest(g) === digest(grant))) throw new DispatchError("SYNTHETIC_RESOURCE_WITHDRAWN"); },
  };
  const jobs = new JobRepository(approval.db, { scope, now: () => approval.state.now, resolveCapability: b => ledger.requireReady(b) });
  const approvals: ApprovalRepository = new ApprovalRepository(approval.db, { ...approval.options, registry: bridge.registry, verifyOutcome: out => dispatch.verifyOutcome(out) });
  const dispatch: DispatchGuard = new DispatchGuard({ db: approval.db, scope, approvals, jobs, ledger, resourceAuthority: resources, handlers: bridge.handlers, now: () => approval.state.now });
  const request: PrepareInput = { entitlementRef: entitlement.entitlementRef, optionId: option.optionId, quoteRef: quote.quoteRef,
    recipientRef: "synthetic-recipient", detailsCompleteAt: "2026-11-02T00:00:00Z", expiresAt: until() };
  const prepared = repository.prepare(request, "synthetic-prepare");
  async function preview() { return approvals.preparePreview({ actionKind: REWARD_ACTION, entityRef: prepared.redemptionId, entityVersion: String(prepared.revision),
    selectionRefs: [prepared.redemptionId], expectedVersion: 0 }, { principalRef: "synthetic:requester" }, "synthetic-preview"); }
  async function approve(actor = "synthetic:founder") {
    const p = await preview(), requested = await approvals.requestDecision({ approvalRef: p.manifest.approvalRef, expectedVersion: p.manifest.manifestVersion },
      { principalRef: "synthetic:requester" }, "synthetic-request");
    const event = approval.event(requested, "approved", actor);
    return approvals.observeDecision(event.locator, { ingressRef: "synthetic:verified-relay" });
  }
  async function handoff(read: ApprovalRead) {
    return dispatch.handoff({ approval: approvalDispatchBinding(read.manifest, read.manifest.items[0]!.itemRef), handlerRef: REWARD_HANDLER,
      payloadRef: read.manifest.draft.payloadRef }, { principalRef: "synthetic:requester", idempotencyKey: "synthetic-handoff" });
  }
  return { approval, scope, state, policy, entitlement, quote, provider, option, source, authority, commercialPolicy, registration,
    repository, bridge, approvals, ledger, resources, grants, jobs, dispatch, request, prepared, preview, approve, handoff, native, intents, outcomes, cash, capabilityReceipts: receipts };
}
