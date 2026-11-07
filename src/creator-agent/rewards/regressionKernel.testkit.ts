import type { DatabaseSync } from "node:sqlite";
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
import { createRewardDomainBridge } from "./approvalBridge.ts";
import { entitlementSchema, quoteSchema, providerStateSchema, purchaseLookupSchema, purchaseReceiptSchema, type RewardPolicy } from "./contract.ts";
import { RewardRedemptionRepository, type RewardAuthority } from "./repository.ts";
import { canonicalPurchaseIdentitySchema, REWARD_ACTION, REWARD_HANDLER, type RewardDomainSource } from "./canonicalContract.ts";

/** Migrates the existing receipt regressions to actual J04 + job execution, not the retired decision DTO executor. */
export function regressionRewardKernel(input: { db: DatabaseSync; repository: RewardRedemptionRepository; authority: RewardAuthority;
  policy: RewardPolicy; decisions: Map<string, unknown>; now: () => Date }) {
  const { repository, authority, db } = input;
  const native = approvalFixture(); native.db.close();
  const stamp = () => input.now().toISOString(), until = () => "2027-01-01T00:00:00Z";
  Object.defineProperty(native.state, "now", { get: () => input.now().getTime() });
  native.policy.observedAt = stamp(); native.policy.validUntil = until();
  for (const human of native.humans.values()) { human.observedAt = stamp(); human.validUntil = until(); }
  const readLinear = native.sources.readLinearRecord!;
  native.sources.readLinearRecord = async intent => {
    const result = await readLinear(intent);
    if (result && typeof result === "object" && "state" in result && result.state === "recorded") {
      const current = native.linear.get(intent.intentRef)!;
      current.observedAt = stamp(); current.validUntil = until(); return structuredClone(current);
    }
    return result;
  };
  const policyFor = (programmeRef: string, rewardVersion: string): RewardPolicySnapshot => ({ scope, programmeRef, rewardVersion,
    sourceRef: "synthetic-policy-source", sourceVersion: input.policy.adoptionRef ?? "synthetic-proposed", observedAt: stamp(), validUntil: until(),
    terms: { state: input.policy.state === "adopted" ? "effective" : "proposed", adoptionRef: input.policy.adoptionRef,
      effectiveAt: input.policy.state === "adopted" ? "2026-10-01T00:00:00Z" : null, fundingRef: "synthetic-funding", economicsRef: "synthetic-economics",
      conditionsRef: "synthetic-conditions", currency: "USD", base: "matured-retained-eligible-merchandise", allInCaps: true, preservesEarnedObligations: true,
      milestones: [{ milestone: "tech", thresholdMinor: 500000, additionalCapMinor: 30000 }, { milestone: "phone", thresholdMinor: 1500000, additionalCapMinor: 100000 },
        { milestone: "vacation", thresholdMinor: 6000000, additionalCapMinor: 500000 }], options: input.policy.options },
    pausedForNewAcquisition: false, execution: { state: "permitted", permissionRef: "synthetic-execution-permission", sourceVersion: "permission-v1", observedAt: stamp(), validUntil: until() } });
  const commercialPolicy: CommercialPolicySource = { readCurrent: () => null,
    readRewardPolicy: q => q.rewardVersion === input.policy.version ? policyFor(q.programmeRef, q.rewardVersion) : null,
    assertCurrent: () => { throw new Error("No acquisition source in reward receipt tests."); },
    assertRewardCurrent: p => { const current = policyFor(p.programmeRef, p.rewardVersion);
      if (digest(p.terms) !== digest(current.terms) || p.sourceVersion !== current.sourceVersion) throw new DispatchError("REWARD_TERMS_CHANGED"); },
  };
  const selections = new Map<string, string | null>(), runById = new Map<string, string>(), approvalById = new Map<string, ApprovalRead>();
  const purchaseCommands = new Map<string, string>();
  const cores = new Map<string, { approvals: ApprovalRepository; dispatch: DispatchGuard; source: RewardDomainSource }>();
  let latest: { approvals: ApprovalRepository; dispatch: DispatchGuard } | null = null;
  async function core(id: string) {
    const r = repository.canonicalRequest(id), provider = providerStateSchema.parse(authority.provider?.(r.option!.providerRef, r.option!.deliveryRoute, r.entitlement.scope));
    const key = digest([provider.providerRef, provider.bindingRef]);
    if (cores.has(key)) return cores.get(key)!;
    const binding: ExpectedBinding = { ...scope, provider: "synthetic-reward-provider", providerAccountId: provider.bindingRef,
      action: REWARD_ACTION, mode: "executeApproved", route: "api", routeRef: "route:reward-regression-" + key, authorizationScopeVersion: "scope-v1", toolVersion: "tool-v1",
      requiredScopes: ["synthetic-purchase"], connectionRef: null, secretRef: null };
    const readBinding: ExpectedBinding = { ...binding, mode: "reconcile", requiredScopes: ["synthetic-readback"] };
    const source: RewardDomainSource = {
      idempotency: "source-enforced",
      readBasis: async q => {
        const request = repository.canonicalRequest(q.redemptionId), e = entitlementSchema.parse(authority.entitlement?.(request.entitlement.entitlementRef, request.entitlement.scope)),
          quote = quoteSchema.parse(authority.quote?.(request.input.quoteRef, request.entitlement.scope)), p = providerStateSchema.parse(authority.provider?.(request.option!.providerRef, request.option!.deliveryRoute, request.entitlement.scope));
        const selected = selections.get(q.redemptionId), allocation = selected ? authority.allocation?.(selected, request.entitlement.scope) as Record<string, unknown> | undefined : undefined;
        if (request.option!.deliveryRoute === "farda-physical" && (!selected || !allocation || allocation.state !== "reserved" || allocation.purpose !== "creator-reward" ||
            allocation.redemptionId !== q.redemptionId || allocation.requestHash !== q.requestHash || allocation.revision !== q.revision ||
            allocation.optionId !== request.input.optionId || allocation.recipientRef !== request.input.recipientRef)) throw new DispatchError("PHYSICAL_ALLOCATION_UNVERIFIED");
        return { ...q, sourceRef: e.sourceRef, sourceVersion: digest([e, quote, p, allocation ?? null]), observedAt: stamp(), validUntil: until(),
          entitlement: e, quote, provider: p, providerBinding: binding,
          stock: request.option!.deliveryRoute === "farda-physical" ? { state: "required", sourceRef: selected!, sourceVersion: digest(allocation), purpose: "creator-reward", resourceRef: selected!,
            skuRef: request.input.optionId, locationRef: "synthetic-home", quantity: 1, productVersion: "product-v1", validUntil: String(allocation!.validUntil) }
            : { state: "notApplicable", policyVersion: native.policy.version, reason: "Provider supplied reward." } };
      },
      assertCurrent: s => {
        const request = repository.canonicalRequest(s.redemptionId), e = authority.entitlement?.(request.entitlement.entitlementRef, request.entitlement.scope),
          q = authority.quote?.(request.input.quoteRef, request.entitlement.scope), p = authority.provider?.(request.option!.providerRef, request.option!.deliveryRoute, request.entitlement.scope),
          selected = selections.get(s.redemptionId), allocation = selected ? authority.allocation?.(selected, request.entitlement.scope) : null;
        if (s.sourceVersion !== digest([e, q, p, allocation ?? null])) throw new DispatchError("REWARD_SOURCE_CHANGED");
      },
      purchase: async intent => {
        const receipt = await authority.executor?.purchase(intent.dispatchKey, { ...intent, purchaseKey: intent.dispatchKey });
        const parsed = purchaseReceiptSchema.safeParse(receipt); if (!parsed.success) return { state: "unknown", reasonCode: "PURCHASE_RESPONSE_UNVERIFIED" };
        return { ...canonicalPurchaseIdentitySchema.parse(Object.fromEntries(Object.keys(canonicalPurchaseIdentitySchema.shape).map(k => [k, intent[k as keyof typeof intent]]))),
          state: "applied", receipt: parsed.data, receiptRef: "synthetic-native:" + digest(parsed.data), observedAt: stamp() };
      },
      readPurchase: async identity => {
        const result = await authority.executor?.read(identity.dispatchKey, { providerRef: identity.providerRef, providerBindingRef: identity.providerBindingRef });
        const legacyRead = result && typeof result === "object" ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "originalAttemptClosed")) : result;
        const parsed = purchaseLookupSchema.safeParse(legacyRead), exact = canonicalPurchaseIdentitySchema.parse(Object.fromEntries(Object.keys(canonicalPurchaseIdentitySchema.shape).map(k => [k, identity[k as keyof typeof identity]])));
        if (parsed.success && parsed.data.state === "found") return { ...exact, state: "applied", receipt: parsed.data.receipt, receiptRef: "synthetic-native:" + digest(parsed.data.receipt), observedAt: stamp() };
        // The old fixture's explicit keyed absence now also requires its positive original-attempt closure flag.
        const terminal = result && typeof result === "object" && "originalAttemptClosed" in result && result.originalAttemptClosed === true;
        if (parsed.success && parsed.data.state === "notFound" && terminal && parsed.data.purchaseKey === identity.dispatchKey && parsed.data.providerRef === identity.providerRef &&
            parsed.data.providerBindingRef === identity.providerBindingRef && Date.parse(parsed.data.checkedAt) === input.now().getTime())
          return { ...exact, state: "notApplied", receiptRef: "synthetic-closure:" + identity.attemptRef, observedAt: stamp(), validUntil: until(), complete: true, originalAttemptClosed: true };
        return { state: "unknown", reasonCode: "PURCHASE_READBACK_UNVERIFIED" };
      },
      assertReadCurrent: () => { if (!authority.executor) throw new DispatchError("PURCHASE_EXECUTOR_UNAVAILABLE", 403); },
    };
    const bridge = createRewardDomainBridge({ scope, repository, source, commercialPolicy, now: () => input.now().getTime(), registration: {
      policyVersion: native.policy.version, configVersion: "config-v1", linearIssueRef: "synthetic-reward-issue", binding, reconcileBinding: readBinding,
      providerRef: provider.providerRef, providerBindingRef: provider.bindingRef, budgetResourceRef: "synthetic-budget", quotaResourceRef: "synthetic-quota",
      budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 5, maxRunMs: 900000, leaseMs: 300000, maxConcurrency: 1, retryBaseMs: 0 } } });
    const receipts = new Map<string, VerificationReceipt>();
    const ledger = new CapabilityLedger(db, scope, { now: () => input.now().getTime(), resolveReceipt: ref => receipts.get(ref) ?? null });
    for (const b of [binding, readBinding]) {
      const registered = ledger.register({ binding: b, ownerRef: "owner:synthetic", costBasis: { state: "unknown", reasonCode: "UNKNOWN" } }, 0), receiptRef = "receipt:" + digest(b);
      receipts.set(receiptRef, { receiptRef, binding: b, outcome: "Ready", checkedAt: stamp(), expiresAt: new Date(input.now().getTime() + 900000).toISOString(),
        verifiedScopes: b.requiredScopes, connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: ["SYNTHETIC_VERIFIED"] });
      await ledger.verify(registered.capabilityId, receiptRef, 1);
    }
    const grants = new Map<string, ResourceGrant>();
    const resources: ResourceAuthority = {
      resolveGrants: async r => Object.entries(r.requirements).flatMap(([dimension, need]) => {
        if (need.state !== "required") return [];
        const grantKey = `${r.dispatchKey}:${dimension}`;
        if (!grants.has(grantKey)) grants.set(grantKey, { scope, dispatchKey: r.dispatchKey, dimension: dimension as ResourceGrant["dimension"],
          grantRef: "synthetic-grant:" + digest(grantKey), issuerRef: "synthetic-resource-owner", allocationVersion: "v1", resourceRef: need.resourceRef,
          quantity: need.quantity, unit: need.unit, currency: need.currency, exclusive: true, observedAt: stamp(), validUntil: until(),
          ...(dimension === "quota" ? { quotaBasis: { publishedLimit: 100, operatingLimit: 80, allocatedTotal: 1, windowRef: "window-v1", windowStart: stamp(), windowEnd: until(), sharedAcrossRoutes: true as const } } : {}) });
        return [structuredClone(grants.get(grantKey)!)];
      }), assertCurrent: g => { if (g.some(value => ![...grants.values()].some(actual => digest(value) === digest(actual)))) throw new Error("Synthetic grant changed."); },
    };
    const jobs = new JobRepository(db, { scope, now: () => input.now().getTime(), resolveCapability: b => ledger.requireReady(b) });
    const approvals: ApprovalRepository = new ApprovalRepository(db, { ...native.options, registry: bridge.registry,
      verifyOutcome: out => dispatch.verifyOutcome(out) });
    const dispatch: DispatchGuard = new DispatchGuard({ db, scope, jobs, ledger, approvals, handlers: bridge.handlers, resourceAuthority: resources, now: () => input.now().getTime() });
    const result = { approvals, dispatch, source }; cores.set(key, result); latest = result; return result;
  }
  async function decide(id: string, sourceRef: string, key: string) {
    const requested = input.decisions.get(sourceRef) as Record<string, unknown> | undefined;
    if (!requested) throw new Error("J04_DECISION_UNVERIFIED");
    selections.set(id, typeof requested.physicalAllocationRef === "string" ? requested.physicalAllocationRef : null);
    const k = await core(id), r = repository.canonicalRequest(id), p = await k.approvals.preparePreview({ actionKind: REWARD_ACTION, entityRef: id,
      entityVersion: String(r.revision), selectionRefs: [id], expectedVersion: 0 }, { principalRef: "synthetic:requester" }, "preview:" + key);
    const request = await k.approvals.requestDecision({ approvalRef: p.manifest.approvalRef, expectedVersion: p.manifest.manifestVersion }, { principalRef: "synthetic:requester" }, "request:" + key);
    const event = native.event(request, "approved", "synthetic:founder", sourceRef);
    if (requested.revision !== r.revision) event.manifestVersion = Number(requested.revision);
    if (requested.requestHash !== r.requestHash) event.manifestHash = String(requested.requestHash);
    event.state = requested.state as typeof event.state; event.decidedAt = String(requested.decidedAt);
    event.validUntil = String(requested.validUntil); event.decision = requested.decision as typeof event.decision;
    input.decisions.set(sourceRef, event); native.events.set(sourceRef, event);
    // Subsequent source mutation in an existing test changes the actual native event backing J04.
    native.sources.readSlackDecision = async locator => {
      const current = input.decisions.get(locator.eventRef);
      if (current && typeof current === "object") native.events.set(locator.eventRef, current as typeof event);
      return structuredClone(current ?? null);
    };
    const read = await k.approvals.observeDecision(event.locator, { ingressRef: "synthetic:verified-native-event" });
    approvalById.set(id, read);
    const run = await k.dispatch.handoff({ approval: approvalDispatchBinding(read.manifest, id), handlerRef: REWARD_HANDLER, payloadRef: read.manifest.draft.payloadRef },
      { principalRef: "synthetic:requester", idempotencyKey: "handoff:" + key });
    runById.set(id, run.runRef); latest = k;
    return repository.read(id)!;
  }
  async function purchase(id: string, key: string) {
    const previous = purchaseCommands.get(key); if (previous && previous !== id) throw new Error("IDEMPOTENCY_KEY_REUSED");
    const k = await core(id), run = runById.get(id); if (!run) throw new Error("J04_APPROVAL_REQUIRED");
    purchaseCommands.set(key, id);
    const current = k.dispatch.read(run);
    if (current.executionCertainty === "uncertain") await k.dispatch.reconcile(run);
    await k.dispatch.execute(run);
    return repository.read(id)!;
  }
  return { decide, purchase, core, native, runById, approvalById, current: () => latest };
}
