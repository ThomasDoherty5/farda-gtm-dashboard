// Synthetic J10 fixtures for tests only. No real creators, merchants, programmes or provider identifiers.
import { commercialPolicyFixture, commercialSourceFixture, syntheticCommercialScope } from "../commercialPolicy/fixtures.testkit.ts";
import { digest } from "../config.ts";
import { costKeys, newOfferTerms, type OfferTerms } from "../offers/contract.ts";
import type { OperationsScope } from "../operations.ts";
import { AgentStore } from "../store.ts";
import type { AccountRecord, OnboardingAction, OnboardingInput, Ref, StoredIntent } from "./contract.ts";
import type { SandboxOrder } from "./attributionMatrix.ts";
import type { CanonicalIdentity, OfferView, OnboardingAuthority } from "./preflight.ts";
import { AffiliateOnboardingRepository } from "./repository.ts";

export const onboardingScope: OperationsScope = { workspaceId: syntheticCommercialScope.workspaceId, accountId: syntheticCommercialScope.accountId, environment: "sandbox" };
export const PROVIDER = "shopify-collabs";
export const PROVIDER_ACCOUNT = "synthetic-provider-account";
export const CREATOR_ID = "synthetic-creator";
export const START = Date.parse("2026-11-09T00:00:00.000Z");

/** A provider-account ref with an optional plain https source link on a reserved example host. */
export const providerRef = (sourceId: string, url: string | null = null): Ref => ({ provider: PROVIDER, accountId: PROVIDER_ACCOUNT, sourceId, url });

export function offerTermsFixture(now = START): OfferTerms {
  const terms = newOfferTerms(CREATOR_ID, "website", "synthetic-brief");
  terms.rewardVersion = null; terms.programRef = "synthetic-program"; terms.recruitmentSource = "Social Cat"; terms.publishingNetwork = "Instagram";
  terms.expiresAt = new Date(now + 30 * 86_400_000).toISOString(); terms.commission.effectiveAt = new Date(now - 1000).toISOString();
  terms.manifest = { ...terms.manifest, campaignRef: "synthetic-campaign", productRef: "synthetic-product", productRevision: "synthetic-product-v1",
    claimsRefs: ["claims"], guidanceRefs: ["guide"], contactRoute: "synthetic-inbox" };
  terms.sample = { requested: true, seededCreators: 1, unitsPerCreator: 1, merchandiseCapMinor: 1600, shippingCapMinor: 600 };
  for (const key of costKeys) terms.costs[key] = { minor: 100, sourceRef: `synthetic-cost-${key}` };
  return terms;
}

export function accountFixture(now = START, over: Partial<AccountRecord> = {}): AccountRecord {
  const observedAt = new Date(now - 1000).toISOString(), validUntil = new Date(now + 3_600_000).toISOString();
  return { origin: "synthetic", provider: PROVIDER, providerAccountRef: PROVIDER_ACCOUNT,
    merchantRef: { provider: PROVIDER, accountId: "synthetic-merchant-account", sourceId: "synthetic-merchant", url: null },
    creatorRef: { provider: "farda-creator", accountId: onboardingScope.accountId, sourceId: CREATOR_ID, url: null },
    sourceRef: "synthetic-account-record", observedAt, validUntil,
    plan: { name: "synthetic-plan", sourceRef: "synthetic-plan-source", unknownReason: null },
    merchantEligibility: { state: "eligible", sourceRef: "synthetic-merchant-eligibility", unknownReason: null },
    creatorEligibility: { state: "eligible", sourceRef: "synthetic-creator-eligibility", unknownReason: null },
    permissions: (["invite", "observeAcceptance", "issueLinkCode", "observeLinkCode", "sandboxCheckout", "activate"] as const)
      .map(action => ({ action, state: "granted" as const, sourceRef: `synthetic-permission-${action}` })),
    quota: { state: "known", unit: "invitation", limit: 50, remaining: 12, resetAt: new Date(now + 86_400_000).toISOString(), sourceRef: "synthetic-quota" },
    commission: { supportsPercent: true, supportsFixedPerSale: false, eligibleBases: ["retained-eligible-merchandise"], currencies: ["USD"], sourceRef: "synthetic-commission-support" },
    definitions: { version: "synthetic-definitions-v1", gross: "Fictional gross order value", eligible: "Fictional retained eligible merchandise",
      refund: "Fictional refund reduces eligible merchandise", hold: "Fictional hold before payout", holdDays: 30, sourceRef: "synthetic-definitions" },
    attributionPrecedence: "link-over-code", payoutOwnerRef: "synthetic-payout-owner", trackingOwnerRef: "synthetic-attribution-owner",
    recruitment: { source: "social-cat", campaignRef: "synthetic-campaign", campaignVersion: "v1", collaboration: "affiliate", sourceRef: "synthetic-campaign-source",
      observedAt, validUntil }, ...over };
}

/** A real shared agent SQLite store plus fictional source bindings whose state the test controls. */
export function onboardingFixture() {
  let now = START;
  const store = new AgentStore(":memory:", { workspaceId: onboardingScope.workspaceId, accountId: onboardingScope.accountId });
  const policy = commercialSourceFixture(commercialPolicyFixture(syntheticCommercialScope, now));
  const offer: { current: OfferView | null } = { current: null };
  const setOffer = (terms: OfferTerms, version = "synthetic-offer-v1") => {
    offer.current = { offerId: "synthetic-offer", version, manifestHash: "m-" + digest([terms, version]).slice(0, 40), terms, state: "approved", ownerApprovalRef: "synthetic-owner-approval" };
    return offer.current;
  };
  setOffer(offerTermsFixture(now));
  const state = { account: accountFixture(now) as unknown, identity: { creatorId: CREATOR_ID, revision: 1, suppressions: [] } as CanonicalIdentity | null,
    capability: new Map<OnboardingAction, unknown>() };
  const readiness = (over: Record<string, unknown> = {}) => ({ allowed: true, state: "Ready", reasonCodes: ["VERIFIED"], capabilityId: "c".repeat(64), revision: 1,
    checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(), receiptRef: "receipt:synthetic-capability", ownerRef: "owner:synthetic", recovery: "none", ...over });
  const authority: OnboardingAuthority = {
    commercialPolicy: policy.source,
    offer: id => id === offer.current?.offerId ? structuredClone(offer.current) : null,
    identity: id => state.identity && state.identity.creatorId === id ? structuredClone(state.identity) : null,
    account: () => structuredClone(state.account),
    capability: action => state.capability.has(action) ? state.capability.get(action) : readiness(),
    // Test-only: these synthetic account records may stand in for the unbound provider account.
    allowSyntheticAccounts: true,
  };
  const repo = new AffiliateOnboardingRepository(store.database, onboardingScope, authority, () => now);

  function input(over: Partial<OnboardingInput> = {}): OnboardingInput {
    const o = offer.current!;
    return { merchantRef: { provider: PROVIDER, accountId: "synthetic-merchant-account", sourceId: "synthetic-merchant", url: null },
      creatorRef: { provider: "farda-creator", accountId: onboardingScope.accountId, sourceId: CREATOR_ID, url: null }, objective: "website_affiliate",
      providerProgram: { provider: PROVIDER, programRef: providerRef("synthetic-program"), version: "synthetic-program-v1" }, offerId: o.offerId,
      approvedTerms: { policyVersion: o.terms.policyVersion, offerVersion: o.version, rateType: "percent", rateValue: "20", eligibleBase: "retained-eligible-merchandise",
        currency: "USD", approvalRef: { provider: "farda-j04", accountId: onboardingScope.accountId, sourceId: "synthetic-owner-approval", url: null } },
      acquisition: { relationship: "commission-only", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0,
        productAllocation: { merchandiseMinor: 1600, shippingMinor: 600, approvalRef: { provider: "farda-j04", accountId: onboardingScope.accountId, sourceId: "synthetic-sample-approval", url: null } } },
      storefrontRoute: { checkoutOwner: "synthetic-merchant", storefrontType: "shopify-online-store", url: "https://synthetic-store.example/" }, ...over };
  }
  const evidence = <T>(sourceId: string, value: T | null, unknownReason: string | null = null, url: string | null = null) =>
    ({ ref: providerRef(sourceId, url), observedAt: new Date(now).toISOString(), sourceUpdatedAt: null, method: "synthetic-source-read", value, unknownReason });

  let keys = 0;
  const key = (label: string) => `${label}-${++keys}`;
  /** Drives an intent through J04 answers to a sent receipt. Nothing is sent: these are recorded answers only. */
  function sendIntent(intent: StoredIntent, expiresAt: string | null = null) {
    repo.reserve(intent.intentRef, key("reserve"), { requestId: key("request") });
    repo.recordOutcome({ kind: "approvalRecorded", intentRef: intent.intentRef, approvalRef: "approval-" + intent.kind, manifestRef: "manifest-" + intent.kind }, key("approved"));
    repo.recordOutcome({ kind: "dispatchPending", intentRef: intent.intentRef, approvalRef: "approval-" + intent.kind, manifestRef: "manifest-" + intent.kind,
      runRef: "run-" + intent.kind, runVersion: "run-v1" }, key("dispatched"));
    return repo.recordOutcome({ kind: "sent", intentRef: intent.intentRef, approvalRef: "approval-" + intent.kind, manifestRef: "manifest-" + intent.kind,
      runRef: "run-" + intent.kind, runVersion: "run-v1", receiptRefs: ["receipt-" + intent.kind], providerReceipt: providerRef("native-" + intent.kind + "-receipt"), expiresAt }, key("sent"));
  }
  function opened() { return repo.open(input(), key("open")).record; }
  function invited() {
    const record = opened();
    sendIntent(repo.proposeInvitation(record.onboardingId, key("invite")), new Date(now + 7 * 86_400_000).toISOString());
    return repo.read(record.onboardingId)!;
  }
  function accepted() {
    const record = invited();
    repo.observe(record.onboardingId, { type: "acceptance", evidence: evidence("synthetic-acceptance", { offerId: record.offerId, offerVersion: record.offerVersion }) }, key("accept"));
    return repo.read(record.onboardingId)!;
  }
  const relationship = (offerVersion: string, relationshipId = "synthetic-relationship", link = "synthetic-link", code = "SYNTHETICCODE") => ({
    evidence: evidence("synthetic-relationship-read", { relationshipRef: providerRef(relationshipId), offerVersion,
      linkCodeRefs: [{ kind: "link" as const, ref: providerRef(link) }, { kind: "code" as const, ref: providerRef(code) }] }) });
  function linked() {
    const record = accepted();
    repo.mapRelationship(record.onboardingId, relationship(record.offerVersion), key("map"));
    return repo.read(record.onboardingId)!;
  }
  function order(kind: SandboxOrder["case"], over: Partial<SandboxOrder> = {}): SandboxOrder {
    const ids: Record<SandboxOrder["case"], SandboxOrder["identifiers"]> = { linkOnly: { linkRef: "synthetic-link", codeRef: null },
      codeOnly: { linkRef: null, codeRef: "SYNTHETICCODE" }, conflicting: { linkRef: "synthetic-link", codeRef: "OTHERSYNTHETICCODE" },
      untracked: { linkRef: null, codeRef: null }, storefrontRoute: { linkRef: "synthetic-link", codeRef: null }, refund: { linkRef: "synthetic-link", codeRef: null } };
    const via = kind === "codeOnly" ? "code" as const : "link" as const;
    const orderId = `synthetic-order-${kind}`;
    return { case: kind, environment: "sandbox", orderRef: providerRef(orderId), storefront: { checkoutOwner: "synthetic-merchant", storefrontType: "shopify-online-store",
      url: "https://synthetic-store.example/" }, salesChannel: "online-store", identifiers: ids[kind],
      providerCredit: kind === "untracked" ? { state: "notCredited", relationshipSourceId: null, via: null } : { state: "credited", relationshipSourceId: "synthetic-relationship", via },
      amounts: { gross: { minorUnits: 4098, currency: "USD" }, eligible: { minorUnits: 3499, currency: "USD" }, holdUntil: new Date(now + 30 * 86_400_000).toISOString() },
      refund: kind === "refund" ? { state: "applied", refundOfOrderSourceId: orderId, amount: { minorUnits: 3499, currency: "USD" }, eligibleAfter: { minorUnits: 0, currency: "USD" } } : { state: "none" },
      definitionsVersion: "synthetic-definitions-v1", sourceRef: `synthetic-sandbox-${kind}`, observedAt: new Date(now).toISOString(), ...over };
  }
  const passingOrders = () => (["linkOnly", "codeOnly", "conflicting", "untracked", "storefrontRoute", "refund"] as const).map(kind => order(kind));
  return { repo, store, authority, state, policy, offer, setOffer, readiness, input, evidence, key, sendIntent, opened, invited, accepted, linked,
    relationship, order, passingOrders, now: () => now, advance: (ms: number) => { now += ms; } };
}
