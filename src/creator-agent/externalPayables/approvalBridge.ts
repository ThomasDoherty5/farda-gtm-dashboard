import { digest } from "../config.ts";
import { ApprovalError, approvalDraftSchema, type ApprovalDraft, type ApprovalRegistry, type ApprovalScope } from "../approvals/contract.ts";
import { stableApprovalDraft } from "../approvals/repository.ts";
import type { ExpectedBinding } from "../connections/schema.ts";
import { DispatchError, type DispatchContext, type DispatchHandler, type DispatchIntent, type DispatchReadback, type DispatchReconcileContext } from "../jobs/dispatchSchema.ts";
import { EXTERNAL_PAYABLE_ACTION, EXTERNAL_PAYABLE_HANDLER, ExternalPayableError, type ExecutorChannel, type LiabilitySourceReader, type PaymentIntent,
  type PaymentProvider, type StoredLiability } from "./contract.ts";
import { refKey } from "./ledger.ts";
import { intentPayloadHash, payeeTarget } from "./paymentIntent.ts";
import type { ExternalPayableRepository } from "./repository.ts";

export type ExternalPayableRegistration = {
  /** The J04 approval policy version this registration runs under. */
  policyVersion: string; configVersion: string; linearIssueRef: string;
  binding: ExpectedBinding; reconcileBinding: ExpectedBinding;
  /** The one payment route (rail and paying account) this registration may use. Approval binds it. */
  paymentRouteRef: string;
  budgetResourceRef: string; quotaResourceRef: string; budgets: DispatchHandler["budgets"];
  approvalTtlMs: number;
  /** Executor channel. API and authorized-browser fallback use the same provider key and the same approved item. */
  channel: ExecutorChannel;
};
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
/** J04 keeps ApprovalError codes as hold reasons, so a held proof names the actual J12 cause. */
function asApproval<T>(work: () => T): T {
  try { return work(); }
  catch (cause) { if (cause instanceof ExternalPayableError) throw new ApprovalError(cause.code); throw cause; }
}
async function asApprovalAsync<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) { if (cause instanceof ExternalPayableError) throw new ApprovalError(cause.code); throw cause; }
}

/**
 * J04 registry and existing-dispatch handler for J12. This module owns the liability ledger, not approval or job running.
 * Builders re-read the intent and liability by reference and re-read the source; no caller copy of an intent can become a payment.
 */
export function createExternalPayableBridge(options: { scope: ApprovalScope; repository: ExternalPayableRepository; source: LiabilitySourceReader;
  provider: PaymentProvider; registration: ExternalPayableRegistration; now?: () => number }) {
  const { scope, repository, source, provider, registration: r } = options;
  const fail = (code: string, status = 409): never => { throw new ExternalPayableError(code, status); };
  const now = () => { const t = (options.now ?? Date.now)(); if (!Number.isSafeInteger(t)) fail("INVALID_CLOCK", 500); return t; };
  if (r.binding.action !== EXTERNAL_PAYABLE_ACTION || r.binding.mode !== "executeApproved" || r.reconcileBinding.action !== EXTERNAL_PAYABLE_ACTION ||
    r.reconcileBinding.mode !== "reconcile" || r.binding.provider !== r.reconcileBinding.provider || r.binding.providerAccountId !== r.reconcileBinding.providerAccountId)
    fail("PAYMENT_REGISTRATION_INVALID");
  for (const b of [r.binding, r.reconcileBinding])
    if (b.workspaceId !== scope.workspaceId || b.accountId !== scope.accountId || b.environment !== scope.environment) fail("PAYMENT_SCOPE_DENIED", 403);
  // As in mirror resync: a submission must be able to apply or fail, plus the settle margin, within one dispatch lease.
  if (!Number.isSafeInteger(provider.maxSubmitMs) || provider.maxSubmitMs <= 0 || provider.maxSubmitMs + repository.settleMarginMs >= r.budgets.leaseMs)
    fail("PAYMENT_DEADLINE_EXCEEDS_LEASE");
  if (!Number.isSafeInteger(r.approvalTtlMs) || r.approvalTtlMs <= 0) fail("PAYMENT_REGISTRATION_INVALID");

  const cache = new Map<string, ApprovalDraft>();
  const na = (reason: string) => ({ state: "notApplicable" as const, policyVersion: r.policyVersion, reason });
  function draftFor(intent: PaymentIntent, liability: StoredLiability): ApprovalDraft {
    if (intent.route.routeRef !== r.paymentRouteRef) fail("PAYMENT_ROUTE_UNAUTHORIZED", 403);
    if (intent.amount.currency !== "USD") fail("CURRENCY_UNSUPPORTED");
    const lease = liability.source.validUntil, payloadHash = intentPayloadHash(intent);
    return approvalDraftSchema.parse({
      actionKind: EXTERNAL_PAYABLE_ACTION, phase: "settlement", providerAccountRef: r.binding.providerAccountId, providerAccountVersion: intent.route.version,
      payloadHash, payloadRef: intent.intentRef,
      productVersion: na("A historical fee payment ships no product."), termsVersion: { state: "required", version: intent.termsVersion },
      rightsVersion: na("Paying an accepted fee grants no new content rights."), configVersion: r.configVersion, policyVersion: r.policyVersion,
      effects: { spendsMoney: true, sendsCreator: false, changesPolicy: false },
      items: [{ itemRef: intent.intentRef, itemVersion: String(intent.version), targetRef: payeeTarget(intent), targetVersion: intent.payee.version,
        payloadHash, sourceRef: intent.liabilityRef, units: 0, spendMinor: intent.amount.minorUnits }],
      bounds: { maxItems: 1, maxUnits: 0, maxSpendMinor: intent.amount.minorUnits, currency: "USD" },
      exposure: { state: "known", minor: intent.amount.minorUnits, currency: "USD" },
      acquisitionTerms: null,
      historicalLiability: { sourceRef: intent.liabilityRef, sourceVersion: intent.basisVersion, acceptedMinor: intent.amount.minorUnits, currency: "USD", validUntil: lease },
      gates: { acceptedTerms: { state: "satisfied", sourceRef: `contract:${digest(refKey(liability.source.acceptedObligation.contractRef))}`, sourceVersion: intent.termsVersion, validUntil: lease },
        sampleAuthority: na("No sample."), providerTerms: na("No new provider terms."), launchReadiness: na("Not a launch."),
        sourcePermission: { state: "satisfied", sourceRef: intent.liabilityRef, sourceVersion: intent.basisVersion, validUntil: lease } },
      sourceBasisRef: intent.liabilityRef, sourceBasisVersion: intent.basisVersion, sourceValidUntil: lease, linearIssueRef: r.linearIssueRef,
      expiresAt: new Date(Date.parse(intent.reservedAt ?? fail("INTENT_NOT_RESERVED")) + r.approvalTtlMs).toISOString(),
    });
  }
  /** Fresh source read, recorded, then the intent re-read by reference. A changed basis withdraws the intent inside registerLiability. */
  async function current(intentRef: string, version: number) {
    const intent = repository.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
    let raw: unknown;
    try { raw = await source.read(intent.liabilityRef); } catch { fail("LIABILITY_SOURCE_UNAVAILABLE", 503); }
    const { liability } = repository.registerLiability(raw);
    if (liability.liabilityRef !== intent.liabilityRef) fail("LIABILITY_SOURCE_MISMATCH");
    const checked = repository.assertSubmittable(intentRef, version, now());
    const draft = draftFor(checked.intent, checked.liability);
    cache.set(intentRef, draft);
    return { ...checked, draft };
  }

  const registry: ApprovalRegistry = {
    resolvePreview: (command, _principal, actualScope) => asApprovalAsync(async () => {
      if (!same(actualScope, scope) || command.actionKind !== EXTERNAL_PAYABLE_ACTION || command.selectionRefs.length !== 1 || command.selectionRefs[0] !== command.entityRef)
        fail("PAYMENT_PREVIEW_INVALID", 422);
      const version = Number(command.entityVersion);
      if (!Number.isSafeInteger(version)) fail("INTENT_VERSION_CHANGED");
      return (await current(command.entityRef, version)).draft;
    }),
    currentDraft: manifest => asApprovalAsync(async () => {
      const version = Number(manifest.draft.items[0]?.itemVersion);
      return (await current(manifest.draft.payloadRef, version)).draft;
    }),
    assertCurrentDraft: (manifest, observed, t) => asApproval(() => {
      const cached = cache.get(observed.payloadRef);
      if (!cached || !same(stableApprovalDraft(cached), stableApprovalDraft(observed)) || !same(stableApprovalDraft(manifest.draft), stableApprovalDraft(observed)))
        fail("PAYMENT_MATERIAL_CHANGED");
      const { intent } = repository.assertSubmittable(observed.payloadRef, Number(observed.items[0]!.itemVersion), t);
      if (intentPayloadHash(intent) !== observed.payloadHash) fail("PAYMENT_MATERIAL_CHANGED");
    }),
  };

  function exact(intent: Pick<DispatchIntent, "approval" | "payloadRef">): PaymentIntent {
    const stored = repository.intent(intent.payloadRef);
    if (!stored || intent.approval.actionKind !== EXTERNAL_PAYABLE_ACTION || intent.approval.phase !== "settlement" || intent.approval.itemRef !== stored.intentRef ||
      intent.approval.itemVersion !== String(stored.version) || intent.approval.payloadHash !== intentPayloadHash(stored)) fail("PAYMENT_EXACT_BASIS_REQUIRED");
    return stored!;
  }
  const at = () => new Date(now()).toISOString();
  function applied(c: DispatchReconcileContext, submissionRef: string): DispatchReadback {
    return { state: "applied", receipt: { receiptRef: submissionRef, dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash, handlerRef: c.intent.handlerRef,
      providerBindingHash: c.providerBindingHash, sourceEffect: "providerApplied", observedAt: at() } };
  }
  function notApplied(c: DispatchReconcileContext, why: string): DispatchReadback {
    return { state: "notApplied", attemptRef: c.attemptRef, attemptNumber: c.attemptNumber, dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash,
      handlerRef: c.intent.handlerRef, providerBindingHash: c.providerBindingHash, receiptRef: `xpay-${why}:${digest(c.attemptRef)}`, observedAt: at(),
      validUntil: new Date(now() + 60_000).toISOString(), complete: true, originalAttemptClosed: true };
  }

  async function execute(context: DispatchContext): Promise<DispatchReadback> {
    const intent = exact(context.intent), proof = context.approvalProof();
    if (proof.decisionReceipt.decision !== "approved" || !same(proof.binding, context.intent.approval)) fail("PAYMENT_APPROVAL_REQUIRED");
    // Fresh balance and source check immediately before the one submission. A changed basis has already withdrawn the intent.
    const fresh = await current(intent.intentRef, intent.version);
    if (fresh.draft.payloadHash !== context.intent.approval.payloadHash) fail("PAYMENT_MATERIAL_CHANGED");
    const started = repository.beginSubmission(intent.intentRef, { attemptRef: context.attemptRef, attemptNumber: context.attemptNumber, channel: r.channel },
      provider.maxSubmitMs, () => context.assertCurrent());
    const s = started.intent;
    let raw: unknown;
    try {
      raw = await provider.submit({ providerKey: s.providerKey, payee: s.payee.ref, payeeVersion: s.payee.version, amount: s.amount,
        routeRef: s.route.routeRef, routeVersion: s.route.version, deadline: started.deadlineAt, channel: r.channel });
    } catch { raw = null; }
    const recorded = repository.recordSubmitResult(s.intentRef, context.attemptRef, raw);
    if (recorded.outcome === "accepted" && recorded.intent.submissionRef) return applied(context, recorded.intent.submissionRef);
    if (recorded.outcome === "rejected") return notApplied(context, "rejected");
    return { state: "unknown", reasonCode: "PAYMENT_OUTCOME_UNCERTAIN" };
  }

  const handler: DispatchHandler = {
    policyVersion: r.policyVersion, idempotency: "source-enforced", sourceEffect: "providerApplied",
    provider: { state: "required", binding: r.binding }, reconcileBinding: r.reconcileBinding, budgets: r.budgets,
    resources: intent => {
      const stored = exact(intent);
      return { budget: { state: "required", resourceRef: r.budgetResourceRef, quantity: stored.amount.minorUnits, unit: "minor", currency: "USD" },
        stock: na("A fee payment moves no stock."), quota: { state: "required", resourceRef: r.quotaResourceRef, quantity: 1, unit: "request", currency: null } };
    },
    execute: async (context: DispatchContext) => {
      try { return await execute(context); }
      catch (cause) { if (cause instanceof ExternalPayableError) throw new DispatchError(cause.code, cause.status); throw cause; }
    },
    reconcile: async context => {
      const intent = exact(context.intent), attempt = repository.attemptByRef(context.attemptRef);
      // The attempt row commits before any provider call, so no row means this attempt never reached the provider.
      if (!attempt) return notApplied(context, "unsent");
      if (attempt.outcome === "rejected" || attempt.outcome === "notApplied") return notApplied(context, attempt.outcome === "rejected" ? "rejected" : "absent");
      if (attempt.outcome === "accepted" && intent.submissionRef) return applied(context, intent.submissionRef);
      let raw: unknown;
      try { raw = await provider.lookup(intent.providerKey); } catch { raw = null; }
      const { intent: after, resolution } = repository.recordLookup(intent.intentRef, raw);
      if (resolution === "found" && after.submissionRef) return applied(context, after.submissionRef);
      if (resolution === "notApplied") return notApplied(context, "absent");
      return { state: "unknown", reasonCode: "PAYMENT_OUTCOME_PENDING" };
    },
  };

  /** Reads settlement from the provider by the original key and records it. Never submits. */
  async function syncSettlement(intentRef: string) {
    const intent = repository.intent(intentRef) ?? fail("INTENT_NOT_FOUND", 404);
    let raw: unknown;
    try { raw = await provider.lookup(intent.providerKey); } catch { raw = null; }
    return repository.recordLookup(intentRef, raw);
  }
  return { registry, handlers: new Map<string, DispatchHandler>([[EXTERNAL_PAYABLE_HANDLER, handler]]),
    actions: new Map([[EXTERNAL_PAYABLE_ACTION, { handlerRef: EXTERNAL_PAYABLE_HANDLER }]]), syncSettlement };
}
