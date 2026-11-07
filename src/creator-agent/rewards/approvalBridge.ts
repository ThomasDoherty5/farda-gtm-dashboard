import { digest } from "../config.ts";
import { approvalDraftSchema, type ApprovalDraft, type ApprovalManifest, type ApprovalRegistry, type ApprovalScope } from "../approvals/contract.ts";
import { stableApprovalDraft } from "../approvals/repository.ts";
import { rewardPolicySnapshotSchema, type CommercialPolicySource, type RewardPolicySnapshot } from "../commercialPolicy/contract.ts";
import type { ExpectedBinding } from "../connections/schema.ts";
import type { RegisteredAction } from "../actions/service.ts";
import { DispatchError, type DispatchContext, type DispatchHandler, type DispatchIntent, type DispatchReadback, type DispatchReconcileContext, type ResourceRequirements } from "../jobs/dispatchSchema.ts";
import { RewardRedemptionRepository } from "./repository.ts";
import { REWARD_ACTION, REWARD_HANDLER, rewardSourceSnapshotSchema, type CanonicalRewardRequest, type CanonicalPurchaseIdentity,
  type CanonicalPurchaseReadback, type RewardDomainSource, type RewardSourceSnapshot, type RewardPurchaseLookup } from "./canonicalContract.ts";

export type RewardRegistration = {
  policyVersion: string; configVersion: string; linearIssueRef: string;
  binding: ExpectedBinding; reconcileBinding: ExpectedBinding;
  providerRef: string; providerBindingRef: string; budgetResourceRef: string; quotaResourceRef: string;
  budgets: DispatchHandler["budgets"];
};
type Evidence = { request: CanonicalRewardRequest; source: RewardSourceSnapshot; policy: RewardPolicySnapshot; draft: ApprovalDraft };
function fail(code: string, status = 409): never { throw new DispatchError(code, status); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const immutableEntitlement = (e: CanonicalRewardRequest["entitlement"]) => ({ scope: e.scope, entitlementRef: e.entitlementRef,
  sourceRef: e.sourceRef, creatorId: e.creatorId, programRef: e.programRef, milestone: e.milestone, amountMinor: e.amountMinor,
  currency: e.currency, rewardVersion: e.rewardVersion, qualifiedAt: e.qualifiedAt });
const requestRef = (id: string, revision: number) => `reward-payload:${id}:${revision}`;
const itemRef = (id: string) => id;
const requestMaterial = (r: CanonicalRewardRequest) => ({ redemptionId: r.redemptionId, revision: r.revision, requestHash: r.requestHash,
  revisedAt: r.revisedAt, entitlement: immutableEntitlement(r.entitlement), input: r.input, option: r.option, quote: r.quote });
const sourceMaterial = (s: RewardSourceSnapshot) => ({ scope: s.scope, redemptionId: s.redemptionId, revision: s.revision,
  requestHash: s.requestHash, sourceRef: s.sourceRef, sourceVersion: s.sourceVersion, entitlement: immutableEntitlement(s.entitlement),
  quote: s.quote, provider: { ...s.provider, validUntil: undefined }, providerBinding: s.providerBinding,
  stock: s.stock.state === "required" ? { ...s.stock, validUntil: undefined } : s.stock });
const policyMaterial = (p: RewardPolicySnapshot) => ({ scope: p.scope, programmeRef: p.programmeRef, rewardVersion: p.rewardVersion,
  sourceRef: p.sourceRef, sourceVersion: p.sourceVersion, terms: p.terms,
  execution: { state: p.execution.state, permissionRef: p.execution.permissionRef, sourceVersion: p.execution.sourceVersion } });

/** Actual J04 registry + existing-runner handler. This module owns no approval, job or entitlement ledger. */
export function createRewardDomainBridge(options: {
  scope: ApprovalScope; repository: RewardRedemptionRepository; commercialPolicy: CommercialPolicySource;
  source: RewardDomainSource; registration: RewardRegistration; now?: () => number;
}) {
  const { scope, repository, commercialPolicy, source, registration } = options;
  const now = () => { const t = (options.now ?? Date.now)(); if (!Number.isSafeInteger(t)) fail("INVALID_CLOCK", 500); return t; };
  if (source.idempotency !== "source-enforced" || registration.binding.action !== REWARD_ACTION || registration.binding.mode !== "executeApproved" ||
      registration.reconcileBinding.action !== REWARD_ACTION || registration.reconcileBinding.mode !== "reconcile" ||
      registration.binding.providerAccountId !== registration.reconcileBinding.providerAccountId ||
      registration.binding.provider !== registration.reconcileBinding.provider) fail("REWARD_REGISTRATION_INVALID");
  for (const b of [registration.binding, registration.reconcileBinding])
    if (b.workspaceId !== scope.workspaceId || b.accountId !== scope.accountId || b.environment !== scope.environment) fail("REWARD_SCOPE_DENIED", 403);
  const cache = new Map<string, Evidence>();
  const fresh = (from: string, until: string, t: number) => Number.isFinite(Date.parse(from)) && Date.parse(from) <= t && Date.parse(until) > t && Date.parse(until) > Date.parse(from);
  const na = (reason: string) => ({ state: "notApplicable" as const, policyVersion: registration.policyVersion, reason });
  function assertEvidence(e: Evidence, t: number) {
    const { request: r, source: s, policy: p } = e;
    if (!fresh(s.observedAt, s.validUntil, t) || !fresh(p.observedAt, p.validUntil, t) ||
        !fresh(p.execution.observedAt, p.execution.validUntil, t) || Date.parse(r.input.expiresAt) <= t || Date.parse(s.quote.validUntil) <= t ||
        Date.parse(s.provider.validUntil) <= t || (s.stock.state === "required" && Date.parse(s.stock.validUntil) <= t)) fail("REWARD_SOURCE_EXPIRED");
    if (p.execution.state !== "permitted" || !p.execution.permissionRef) fail("REWARD_EXECUTION_PERMISSION_REQUIRED", p.execution.state === "denied" ? 403 : 409);
    if (!same(requestMaterial(repository.canonicalRequest(r.redemptionId)), requestMaterial(r))) fail("REWARD_REQUEST_CHANGED");
    try { commercialPolicy.assertRewardCurrent(p, t); source.assertCurrent(s, t); }
    catch (cause) { if (cause instanceof DispatchError) throw cause; fail("REWARD_SOURCE_AUTHORITY_REQUIRED", 403); }
  }
  function requirements(e: Evidence): ResourceRequirements { return {
    budget: { state: "required", resourceRef: registration.budgetResourceRef, quantity: e.request.entitlement.amountMinor, unit: "minor", currency: "USD" },
    stock: e.source.stock.state === "required" ? { state: "required", resourceRef: e.source.stock.resourceRef, quantity: e.source.stock.quantity, unit: "units", currency: null } : na("No Farda inventory in provider-direct reward."),
    quota: { state: "required", resourceRef: registration.quotaResourceRef, quantity: 1, unit: "request", currency: null },
  }; }
  function cached(intent: Pick<DispatchIntent, "payloadRef" | "approval">) {
    const e = cache.get(intent.payloadRef);
    if (!e || e.draft.payloadHash !== intent.approval.payloadHash || intent.approval.actionKind !== REWARD_ACTION ||
        intent.approval.phase !== "rewardRedemption" || intent.approval.itemRef !== itemRef(e.request.redemptionId) ||
        intent.approval.itemVersion !== String(e.request.revision)) fail("REWARD_EXACT_BASIS_REQUIRED");
    return e;
  }
  async function evidence(id: string): Promise<Evidence> {
    const r = repository.canonicalRequest(id), t = now();
    if (r.legacyAttempt) fail("LEGACY_REWARD_ATTEMPT_UNVERIFIED");
    if (!r.option || !r.quote || !r.input.detailsCompleteAt || Date.parse(r.input.detailsCompleteAt) > t) fail("REWARD_DETAILS_REQUIRED");
    const parsed = rewardSourceSnapshotSchema.safeParse(await source.readBasis({ scope, redemptionId: id, revision: r.revision, requestHash: r.requestHash }));
    if (!parsed.success) fail("REWARD_SOURCE_UNVERIFIED");
    const s = parsed.data;
    const policy = rewardPolicySnapshotSchema.safeParse(commercialPolicy.readRewardPolicy({ scope, programmeRef: r.entitlement.programRef, rewardVersion: r.entitlement.rewardVersion }));
    if (!policy.success) fail("REWARD_POLICY_UNVERIFIED");
    const p = policy.data, option = p.terms.options.find(o => o.optionId === r.input.optionId && o.milestone === r.entitlement.milestone);
    if (!same(s.scope, scope) || !same(p.scope, scope) || s.redemptionId !== id || s.revision !== r.revision || s.requestHash !== r.requestHash ||
        !same(s.entitlement.scope, { workspaceId: scope.workspaceId, accountId: scope.accountId }) ||
        !same(immutableEntitlement(s.entitlement), immutableEntitlement(r.entitlement)) || s.entitlement.state !== "mature" || s.entitlement.fulfilled ||
        Date.parse(s.entitlement.qualifiedAt) > t) fail("REWARD_ENTITLEMENT_CHANGED");
    if (p.programmeRef !== r.entitlement.programRef || p.rewardVersion !== r.entitlement.rewardVersion || p.terms.state !== "effective" ||
        !p.terms.adoptionRef || !p.terms.effectiveAt || Date.parse(p.terms.effectiveAt) > Date.parse(s.entitlement.qualifiedAt) ||
        !p.terms.fundingRef || !p.terms.economicsRef || !same(option, r.option)) fail("REWARD_TERMS_NOT_EFFECTIVE");
    const milestone = p.terms.milestones.find(row => row.milestone === r.entitlement.milestone);
    if (!milestone || r.entitlement.amountMinor > milestone.additionalCapMinor) fail("REWARD_ENTITLEMENT_POLICY_CONFLICT");
    if (!same(s.quote, r.quote) || s.quote.quoteRef !== r.input.quoteRef || s.quote.optionId !== option!.optionId ||
        s.quote.providerRef !== registration.providerRef || !s.quote.available || s.quote.creatorFundedMinor > s.quote.itemMinor) fail("REWARD_QUOTE_CHANGED");
    const total = BigInt(s.quote.itemMinor) - BigInt(s.quote.creatorFundedMinor) + BigInt(s.quote.taxMinor) + BigInt(s.quote.shippingMinor) + BigInt(s.quote.bookingMinor) + BigInt(s.quote.adminMinor);
    if (total > BigInt(r.entitlement.amountMinor)) fail("ALL_IN_CAP_EXCEEDED");
    if (!same(s.provider.scope, s.entitlement.scope) || s.provider.providerRef !== registration.providerRef ||
        s.provider.bindingRef !== registration.providerBindingRef || s.provider.deliveryRoute !== option!.deliveryRoute ||
        s.provider.state !== "Ready" || !s.provider.fundingVerified || !s.provider.fundingRef || !same(s.providerBinding, registration.binding)) fail("REWARD_PROVIDER_UNVERIFIED");
    const physical = option!.deliveryRoute === "farda-physical";
    if (physical !== (s.stock.state === "required") || (s.stock.state === "notApplicable" && s.stock.policyVersion !== registration.policyVersion)) fail("REWARD_STOCK_PURPOSE_REQUIRED");
    const versionHash = digest({ source: sourceMaterial(s), policy: policyMaterial(p) });
    const payloadHash = digest({ request: { redemptionId: id, revision: r.revision, requestHash: r.requestHash, input: r.input }, basis: versionHash });
    const lease = new Date(Math.min(...[s.validUntil, p.validUntil, p.execution.validUntil, s.quote.validUntil, s.provider.validUntil,
      r.input.expiresAt, ...(s.stock.state === "required" ? [s.stock.validUntil] : [])].map(Date.parse))).toISOString();
    const gate = { state: "satisfied" as const, sourceRef: s.sourceRef, sourceVersion: versionHash, validUntil: lease };
    const draft = approvalDraftSchema.parse({ actionKind: REWARD_ACTION, phase: "rewardRedemption", providerAccountRef: registration.binding.providerAccountId,
      providerAccountVersion: s.provider.bindingRef, payloadHash, payloadRef: requestRef(id, r.revision),
      productVersion: s.stock.state === "required" ? { state: "required", version: s.stock.productVersion } : na("No Farda inventory product in this provider route."),
      termsVersion: { state: "required", version: p.rewardVersion }, rightsVersion: na("Reward redemption grants no creator content rights."),
      configVersion: registration.configVersion, policyVersion: registration.policyVersion,
      effects: { spendsMoney: true, sendsCreator: false, changesPolicy: false },
      items: [{ itemRef: itemRef(id), itemVersion: String(r.revision), targetRef: r.input.recipientRef, targetVersion: r.requestHash,
        payloadHash, sourceRef: r.entitlement.sourceRef, units: s.stock.state === "required" ? s.stock.quantity : 0, spendMinor: r.entitlement.amountMinor }],
      bounds: { maxItems: 1, maxUnits: s.stock.state === "required" ? s.stock.quantity : 0, maxSpendMinor: r.entitlement.amountMinor, currency: "USD" },
      exposure: { state: "known", minor: r.entitlement.amountMinor, currency: "USD" }, acquisitionTerms: null, historicalLiability: null,
      gates: { acceptedTerms: na("Exact adopted reward terms are bound separately."), sampleAuthority: na("This is not creator sample fulfillment."),
        providerTerms: gate, launchReadiness: na("An earned reward is not media launch authority."), sourcePermission: gate,
        rewardStockAuthority: s.stock.state === "required" ? { state: "satisfied", sourceRef: s.stock.sourceRef, sourceVersion: s.stock.sourceVersion, validUntil: lease } : na("No Farda stock allocation for this route.") },
      sourceBasisRef: s.sourceRef, sourceBasisVersion: versionHash, sourceValidUntil: lease, linearIssueRef: registration.linearIssueRef, expiresAt: r.input.expiresAt });
    const e = { request: r, source: s, policy: p, draft }; assertEvidence(e, now());
    repository.freezeResourceBasis({ redemptionId: id, revision: r.revision, requestHash: r.requestHash, payloadHash, requirements: requirements(e) });
    cache.set(draft.payloadRef, e); return e;
  }
  function idFrom(payloadRef: string) {
    const match = /^reward-payload:(redemption-[a-f0-9]{32}):(\d+)$/.exec(payloadRef);
    if (!match) fail("REWARD_PAYLOAD_REFERENCE_INVALID");
    return { id: match[1]!, revision: Number(match[2]) };
  }
  const registry: ApprovalRegistry = {
    resolvePreview: async (command, _principal, actualScope) => {
      if (!same(actualScope, scope) || command.actionKind !== REWARD_ACTION || command.selectionRefs.length !== 1 || command.selectionRefs[0] !== command.entityRef)
        fail("REWARD_PREVIEW_SCOPE_INVALID");
      const e = await evidence(command.entityRef);
      if (command.entityVersion !== String(e.request.revision)) fail("REWARD_REQUEST_CHANGED");
      return e.draft;
    },
    currentDraft: async manifest => { const parsed = idFrom(manifest.draft.payloadRef); const e = await evidence(parsed.id);
      if (e.request.revision !== parsed.revision) fail("REWARD_REQUEST_CHANGED"); return e.draft; },
    assertCurrentDraft: (manifest: ApprovalManifest, observed, t) => {
      const e = cache.get(observed.payloadRef);
      if (!e || !same(stableApprovalDraft(e.draft), stableApprovalDraft(observed)) || !same(stableApprovalDraft(manifest.draft), stableApprovalDraft(observed)))
        fail("REWARD_MATERIAL_CHANGED");
      assertEvidence(e, t);
    },
  };
  function identity(context: DispatchReconcileContext): CanonicalPurchaseIdentity {
    const parsed = idFrom(context.intent.payloadRef), r = repository.canonicalRequest(parsed.id);
    if (r.revision !== parsed.revision) fail("REWARD_REQUEST_CHANGED");
    return { scope, redemptionId: parsed.id, revision: r.revision, requestHash: r.requestHash, dispatchKey: context.dispatchKey,
      payloadHash: context.intent.approval.payloadHash, providerBindingHash: context.providerBindingHash,
      attemptRef: context.attemptRef, attemptNumber: context.attemptNumber };
  }
  function resultFor(context: DispatchReconcileContext, result: CanonicalPurchaseReadback): DispatchReadback {
    if (result.state === "unknown") return result;
    const common = { dispatchKey: context.dispatchKey, payloadHash: context.intent.approval.payloadHash, handlerRef: context.intent.handlerRef,
      providerBindingHash: context.providerBindingHash, receiptRef: result.receiptRef, observedAt: result.observedAt };
    return result.state === "applied" ? { state: "applied", receipt: { ...common, sourceEffect: "providerApplied" } }
      : { state: "notApplied", ...common, attemptRef: result.attemptRef, attemptNumber: result.attemptNumber,
        complete: true, originalAttemptClosed: true, validUntil: result.validUntil };
  }
  function assertRead(lookup: RewardPurchaseLookup) {
    try { source.assertReadCurrent(lookup, now()); }
    catch (cause) { if (cause instanceof DispatchError) throw cause; throw new DispatchError("REWARD_READ_PERMISSION_REQUIRED", 403, "uncertain"); }
  }
  const handler: DispatchHandler = {
    policyVersion: registration.policyVersion, idempotency: "source-enforced", sourceEffect: "providerApplied",
    provider: { state: "required", binding: registration.binding }, reconcileBinding: registration.reconcileBinding, budgets: registration.budgets,
    resources: intent => {
      const parsed = idFrom(intent.payloadRef);
      if (intent.approval.actionKind !== REWARD_ACTION || intent.approval.phase !== "rewardRedemption" ||
          intent.approval.itemRef !== itemRef(parsed.id) || intent.approval.itemVersion !== String(parsed.revision)) fail("REWARD_EXACT_BASIS_REQUIRED");
      return repository.resourceBasis(parsed.id, parsed.revision, intent.approval.payloadHash).requirements;
    },
    execute: async (context: DispatchContext) => {
      let e = cached(context.intent);
      const proof = context.approvalProof(), id = identity(context);
      const stockGrant = context.resourceGrants().find(g => g.dimension === "stock");
      const physicalAllocationRef = e.source.stock.state === "required" ? stockGrant?.grantRef ?? fail("REWARD_STOCK_GRANT_REQUIRED") : null;
      if (proof.decisionReceipt.decision !== "approved" || !same(proof.binding, context.intent.approval)) fail("REWARD_CANONICAL_APPROVAL_REQUIRED");
      const assert = () => { context.assertCurrent(); assertEvidence(e, now()); };
      repository.beginCanonicalPurchase({ binding: context.intent.approval, decisionReceiptRef: proof.decisionReceipt.receiptRef, identity: id,
        startedAt: new Date(now()).toISOString(), physicalAllocationRef, closed: null, receipt: null }, assert);
      let raw: unknown, refusal: DispatchError | null = null;
      try {
        // The original operation is durable before another awaited check. A withdrawn grant can still be reconciled by that identity.
        await context.heartbeat();
        e = cached(context.intent);
        if (context.approvalProof().decisionReceipt.receiptRef !== proof.decisionReceipt.receiptRef ||
            (context.resourceGrants().find(g => g.dimension === "stock")?.grantRef ?? null) !== physicalAllocationRef)
          fail("REWARD_EXECUTION_GRANT_CHANGED");
        assert();
        raw = await source.purchase({ ...id, approval: context.intent.approval, decisionReceiptRef: proof.decisionReceipt.receiptRef,
          providerRef: e.source.provider.providerRef, providerBindingRef: e.source.provider.bindingRef, optionId: e.request.input.optionId,
          quoteRef: e.request.input.quoteRef, recipientRef: e.request.input.recipientRef, deliveryRoute: e.source.provider.deliveryRoute,
          fundingRef: e.source.provider.fundingRef!, capMinor: e.request.entitlement.amountMinor, currency: "USD", physicalAllocationRef,
          expectedSourceVersion: e.source.sourceVersion, expectedPolicyVersion: e.policy.rewardVersion, expectedExecutionVersion: e.policy.execution.sourceVersion });
      } catch (cause) {
        if (cause instanceof DispatchError && [401, 403].includes(cause.status)) refusal = cause;
        raw = { state: "unknown", reasonCode: "REWARD_PURCHASE_OUTCOME_UNCERTAIN" };
      }
      const recorded = repository.recordCanonicalReadback(id.redemptionId, id, raw);
      if (refusal) throw new DispatchError(refusal.code, refusal.status, recorded.state === "applied" ? "applied" : "uncertain");
      assertRead({ ...id, providerRef: registration.providerRef, providerBindingRef: registration.providerBindingRef });
      return resultFor(context, recorded);
    },
    reconcile: async context => {
      const id = identity(context), original = repository.canonicalCheckpoint(id.redemptionId, id);
      const lookup: RewardPurchaseLookup = { ...id, providerRef: registration.providerRef, providerBindingRef: registration.providerBindingRef };
      assertRead(lookup);
      const raw = original.receipt ?? await source.readPurchase(lookup);
      const recorded = repository.recordCanonicalReadback(id.redemptionId, id, raw);
      assertRead(lookup);
      return resultFor(context, recorded);
    },
  };
  return { registry, actions: new Map<string, RegisteredAction>([[REWARD_ACTION, { handlerRef: REWARD_HANDLER }]]),
    handlers: new Map<string, DispatchHandler>([[REWARD_HANDLER, handler]]) };
}
