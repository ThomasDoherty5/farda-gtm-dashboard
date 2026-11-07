import { createHmac, timingSafeEqual } from "node:crypto";
import { actionResponseSchema, SCHEMA_VERSION, type ActionResponse } from "../../adapter/contract.ts";
import { approvalCommandSchema, trustedHumanSchema, type ApprovalCommand, type ApprovalPrincipal,
  type ApprovalRead, type ProposeCommand, type ApprovalDraft } from "../approvals/contract.ts";
import type { DispatchGuard } from "../jobs/dispatchGuard.ts";
import type { DispatchIntent, DispatchRead, DispatchApprovalAuthority } from "../jobs/dispatchSchema.ts";
import { ActionServiceError, reference, type ActionPrincipalAuthority, type ActionAuthorityFence, type PrincipalGrant, type ActionScope } from "./contract.ts";
import type { createActionDomainServices } from "./domainServices.ts";
import { nativeApprovalViewSchema, nativeRunViewSchema } from "./views.ts";
import { foundationActionSchema, domainActionSchema, type FoundationAction } from "./wire.ts";

export type ApprovalGateway = {
  preparePreview(command: ProposeCommand, principal: ApprovalPrincipal, key: string): Promise<ApprovalRead>;
  requestDecision(command: ApprovalCommand, principal: ApprovalPrincipal, key: string): Promise<ApprovalRead>;
  reconcileDecision(command: ApprovalCommand, principal: ApprovalPrincipal, key: string): Promise<ApprovalRead>;
  readApproval(ref: string, manifestVersion?: number): ApprovalRead | null;
  readCommand(kind: "propose" | "request" | "reconcile", command: ProposeCommand | ApprovalCommand, principal: ApprovalPrincipal, key: string): ApprovalRead | null;
} & DispatchApprovalAuthority;

export { foundationActionSchema, domainActionSchema, previewPayload } from "./wire.ts";
export type { FoundationAction, DomainAction } from "./wire.ts";
export type RegisteredAction = { handlerRef: string };
export type ActionServiceOptions = { scope: ActionScope; secret: string; approvals: ApprovalGateway;
  dispatch: Pick<DispatchGuard, "handoffBatch" | "lookupHandoff" | "lookupControl" | "control" | "reconcile" | "read">; registry: ReadonlyMap<string, RegisteredAction>;
  authorize?: ActionPrincipalAuthority; assertAuthority?: ActionAuthorityFence; domains?: ReturnType<typeof createActionDomainServices>; now?: () => number };
function fail(code: string, status = 409, certainty: "notApplied" | "applied" | "uncertain" = "notApplied"): never { throw new ActionServiceError(code, status, certainty); }

/** The envelope composes J04 and the existing runner. It owns no approval, dispatch or financial ledger. */
export function createActionService(options: ActionServiceOptions) {
  const { scope, approvals, dispatch } = options;
  const now = () => { const value = (options.now ?? Date.now)(); if (!Number.isFinite(value)) fail("INVALID_CLOCK", 500); return value; };
  if (options.secret.length < 32) throw new Error("Action reference key must be private.");
  const alias = (kind: string, ref: string) => kind + "-" + createHmac("sha256", options.secret).update(JSON.stringify([scope, kind, ref])).digest("hex");
  // Signed opaque versions preserve the original expected revision for exact-key replay. No current-state substitution.
  const token = (kind: string, ref: string, version: number, revision = version) => {
    const body = `${version}.${revision}`;
    return `av1-${body}-` + createHmac("sha256", options.secret).update(JSON.stringify([scope, kind, ref, body])).digest("hex");
  };
  function version(raw: string, kind: string, ref: string) {
    const match = /^av1-(\d+)\.(\d+)-([a-f0-9]{64})$/.exec(raw); if (!match) fail("STALE_VERSION");
    const manifestVersion = Number(match[1]), revision = Number(match[2]);
    if (!Number.isSafeInteger(manifestVersion) || !Number.isSafeInteger(revision) || manifestVersion < 1 || revision < 1) fail("STALE_VERSION");
    const expected = token(kind, ref, manifestVersion, revision);
    if (expected.length !== raw.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(raw))) fail("STALE_VERSION");
    return { manifestVersion, revision };
  }
  const manifestRef = (a: ApprovalRead) => "manifest-" + a.manifest.manifestHash;
  function scopeCheck(s: FoundationAction["requestedScope"]) {
    if (s.workspaceId !== scope.workspaceId || s.environment !== scope.environment || s.accountIds.length !== 1 || s.accountIds[0] !== scope.accountId) fail("FORBIDDEN", 403);
  }
  function assertActor(p: PrincipalGrant, principal: ApprovalPrincipal) {
    if (!p.active || p.principalRef !== principal.principalRef || p.scope.workspaceId !== scope.workspaceId || p.scope.accountId !== scope.accountId || p.scope.environment !== scope.environment ||
      Date.parse(p.observedAt) > now() || Date.parse(p.validUntil) <= now() || Date.parse(p.observedAt) >= Date.parse(p.validUntil) || !p.roles.some(r => ["founder", "operator", "reviewer", "finance"].includes(r))) fail("AUTHORITY_REQUIRED", 403);
    if (!options.assertAuthority) fail("ACTOR_AUTHORITY_FENCE_UNCONFIGURED", 403);
    try { options.assertAuthority({ scope, actor: p, slack: null, linearRecords: [] }, now()); }
    catch { fail("AUTHORITY_REQUIRED", 403); }
  }
  async function actor(principal: ApprovalPrincipal) {
    reference.parse(principal.principalRef); if (!options.authorize) fail("NAMED_ACTOR_UNCONFIGURED", 403);
    const parsed = trustedHumanSchema.safeParse(await options.authorize(principal.principalRef, scope)); if (!parsed.success) fail("AUTHORITY_REQUIRED", 403);
    const p = parsed.data; assertActor(p, principal);
    return p;
  }
  function approval(ref: string, principal: ApprovalPrincipal, manifestVersion?: number) {
    const a = approvals.readApproval(ref, manifestVersion); if (!a) fail("RECORD_NOT_FOUND", 404);
    if (a.manifest.scope.workspaceId !== scope.workspaceId || a.manifest.scope.accountId !== scope.accountId || a.manifest.scope.environment !== scope.environment || a.manifest.proposer.principalRef !== principal.principalRef) fail("FORBIDDEN", 403);
    return a;
  }
  function originalApproval(input: FoundationAction & { approvalRef: string }, principal: ApprovalPrincipal) {
    const v = version(input.expectedVersion, "approval", input.approvalRef);
    const a = approval(input.approvalRef, principal, v.manifestVersion);
    if (input.manifestRef !== manifestRef(a)) fail("MANIFEST_CHANGED");
    return a;
  }
  function response(request: { requestId: string }, a: ApprovalRead, state: ActionResponse["state"], certainty: ActionResponse["executionCertainty"], over: Partial<ActionResponse> = {}): ActionResponse {
    return actionResponseSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: request.requestId,
      scope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment, authorizationScopeVersion: "actions.scope.v1" },
      actionRef: a.manifest.approvalRef, approvalRef: a.manifest.approvalRef, manifestRef: manifestRef(a), state, runRef: null,
      payloadVersion: token("approval", a.manifest.approvalRef, a.manifest.manifestVersion), policyVersion: a.manifest.draft.policyVersion,
      modelVersion: null, offerVersion: null, reasonCodes: a.current.reasonCodes,
      receiptRefs: [], nextAction: null, nextPollAfterMs: null, executionCertainty: certainty, ...over });
  }
  function approvalResponse(input: { requestId: string; operation?: string }, a: ApprovalRead) {
    if (a.request.state === "uncertain") fail("OUTCOME_UNCERTAIN", 502, "uncertain");
    if (input.operation === "requestApproval" && a.request.state === "local") fail("APPROVAL_REQUEST_UNVERIFIED");
    const state = a.current.state === "approved" ? "approved" : a.current.state === "held" ? "blocked" : a.current.state === "rejected" || a.current.state === "canceled" ? "canceled" : a.request.state === "recorded" ? "approvalPending" : "draft";
    return response(input, a, state, "applied", { receiptRefs: a.request.record ? ["decision-request-" + createHmac("sha256", options.secret).update(a.request.record.recordRef).digest("hex")] : [],
      reasonCodes: [...a.current.reasonCodes, "APPROVED_IS_NOT_SENT"] });
  }
  function runResponse(input: { requestId: string }, a: ApprovalRead, run: DispatchRead, recordedControl = false, currentHolds: string[] = []) {
    if (run.executionCertainty === "uncertain") fail("OUTCOME_UNCERTAIN", 502, "uncertain");
    const receipts = run.items.flatMap(item => item.receipt ? [item.receipt] : []), allApplied = receipts.length === run.items.length;
    const state: ActionResponse["state"] = allApplied ? "succeeded" : run.run.control === "cancelled" ? receipts.length ? "partiallySucceeded" : "canceled" : run.run.control === "paused" ? "paused" : run.current.state === "running" ? "running" : currentHolds.length ? "blocked" : "queued";
    return response(input, a, state, recordedControl || !allApplied ? "applied" : run.executionCertainty, { runRef: run.runRef,
      payloadVersion: token("run", run.runRef, run.revision), reasonCodes: [...currentHolds, ...run.current.reasonCodes, ...(!allApplied ? ["SOURCE_EFFECT_NOT_CONFIRMED"] : [])],
      receiptRefs: receipts.map(receipt => alias("effect", receipt.receiptRef)) });
  }

  function toIntent(a: ApprovalRead, itemRef: string): DispatchIntent {
    const registered = options.registry.get(a.manifest.draft.actionKind); if (!registered) fail("SOURCE_ACTION_UNSUPPORTED");
    const item = a.manifest.items.find(i => i.itemRef === itemRef);
    if (!item) fail("EXACT_MANIFEST_ITEM_REQUIRED", 422);
    const d = a.manifest.draft;
    return { handlerRef: registered.handlerRef, payloadRef: d.payloadRef, approval: { scope, approvalRef: a.manifest.approvalRef, manifestVersion: a.manifest.manifestVersion,
      manifestHash: a.manifest.manifestHash, itemRef: item.itemRef, itemVersion: item.itemVersion, itemHash: item.itemHash, actionKind: d.actionKind,
      providerAccountRef: d.providerAccountRef, payloadHash: item.payloadHash, policyVersion: d.policyVersion, termsVersion: d.termsVersion, rightsVersion: d.rightsVersion, phase: d.phase } };
  }
  async function executeUnchecked(input: FoundationAction, principal: ApprovalPrincipal): Promise<ActionResponse> {
    scopeCheck(input.requestedScope);
    if (input.operation === "decideApproval") fail("APPROVAL_CHANNEL_REQUIRED", 403);
    if (input.operation === "previewAction") {
      if (!options.registry.has(input.actionKind)) fail("SOURCE_ACTION_UNSUPPORTED");
      const old = input.approvalRef ? originalApproval({ ...input, approvalRef: input.approvalRef }, principal) : null;
      if (!old && (input.manifestRef !== null || input.expectedVersion !== input.payload.entityVersion)) fail("STALE_VERSION");
      const a = await approvals.preparePreview({ ...input.payload, actionKind: input.actionKind, expectedVersion: old?.manifest.manifestVersion ?? 0,
        ...(old ? { approvalRef: old.manifest.approvalRef } : {}) }, principal, input.idempotencyKey);
      return approvalResponse(input, a);
    }
    if (input.operation === "requestApproval") {
      const a = originalApproval(input, principal);
      const command = approvalCommandSchema.parse({ approvalRef: input.approvalRef, expectedVersion: a.manifest.manifestVersion });
      return approvalResponse(input, await (input.actionKind === "reconcileApproval" ? approvals.reconcileDecision(command, principal, input.idempotencyKey) : approvals.requestDecision(command, principal, input.idempotencyKey)));
    }
    if (input.operation === "dispatchApprovedAction") {
      const a = originalApproval(input, principal);
      // The guard owns durable original request mapping and re-evaluates current dispatch holds; HTTP never executes the provider handler.
      const refs = input.payload.itemRefs ?? a.manifest.items.map(i => i.itemRef);
      const intents = refs.map(ref => toIntent(a, a.manifest.items.find(i => i.itemRef === ref || alias("item", i.itemRef) === ref)?.itemRef ?? ref));
      const request = { principalRef: principal.principalRef, idempotencyKey: input.idempotencyKey };
      const prior = dispatch.lookupHandoff(intents, request);
      const proofs = [], currentHolds: string[] = [];
      for (const intent of intents) {
        const resolved = await approvals.resolveCurrentProof(intent.approval);
        if (resolved.state !== "verified") {
          if (!prior) fail(resolved.reasonCodes[0] ?? "APPROVAL_REQUIRED");
          currentHolds.push(...resolved.reasonCodes);
        } else proofs.push(resolved.proof);
      }
      // Fresh named authorization is required after slow source readbacks, followed by synchronous proof fences.
      await actor(principal);
      for (const proof of proofs) approvals.assertCurrentProof(proof, now());
      return runResponse(input, a, prior ?? await dispatch.handoffBatch(intents, request), false, currentHolds);
    }
    const run = dispatch.read(input.runRef), a = approval(run.intent.approval.approvalRef, principal, run.intent.approval.manifestVersion);
    if (input.approvalRef !== a.manifest.approvalRef || input.manifestRef !== manifestRef(a)) fail("MANIFEST_CHANGED");
    const original = version(input.expectedVersion, "run", run.runRef);
    if (input.operation === "controlRun") {
      const allowed = { pauseRun: "pause", cancelUnsent: "cancel", resumeRun: "resume" } as const;
      if (allowed[input.actionKind] !== input.payload.control) fail("VALIDATION_FAILED", 422);
      return runResponse(input, a, dispatch.control(run.runRef, original.revision, input.payload.control, { principalRef: principal.principalRef, idempotencyKey: input.idempotencyKey }), true);
    }
    if (input.actionKind !== input.payload.request) fail("VALIDATION_FAILED", 422);
    return runResponse(input, a, await dispatch.reconcile(run.runRef));
  }
  function priorCertainty(input: FoundationAction, principal: ApprovalPrincipal): ActionResponse["executionCertainty"] | null {
    if (input.operation === "previewAction") {
      const old = input.approvalRef ? originalApproval({ ...input, approvalRef: input.approvalRef }, principal) : null;
      const command = { ...input.payload, actionKind: input.actionKind, expectedVersion: old?.manifest.manifestVersion ?? 0, ...(old ? { approvalRef: old.manifest.approvalRef } : {}) };
      return approvals.readCommand("propose", command, principal, input.idempotencyKey) ? "applied" : null;
    }
    if (input.operation === "requestApproval") {
      const a = originalApproval(input, principal), stored = approvals.readCommand(input.actionKind === "requestApproval" ? "request" : "reconcile", { approvalRef: input.approvalRef, expectedVersion: a.manifest.manifestVersion }, principal, input.idempotencyKey);
      return !stored ? null : stored.request.state === "uncertain" ? "uncertain" : stored.request.state === "recorded" ? "applied" : "notApplied";
    }
    if (input.operation === "dispatchApprovedAction") {
      const a = originalApproval(input, principal), intents = (input.payload.itemRefs ?? a.manifest.items.map(i => i.itemRef)).map(ref => toIntent(a, a.manifest.items.find(i => i.itemRef === ref || alias("item", i.itemRef) === ref)?.itemRef ?? ref));
      const stored = dispatch.lookupHandoff(intents, { principalRef: principal.principalRef, idempotencyKey: input.idempotencyKey });
      return !stored ? null : stored.executionCertainty === "uncertain" ? "uncertain" : "applied";
    }
    if (input.operation === "controlRun") {
      const run = dispatch.read(input.runRef, false); approval(run.intent.approval.approvalRef, principal, run.intent.approval.manifestVersion);
      const expected = version(input.expectedVersion, "run", input.runRef);
      return dispatch.lookupControl(input.runRef, expected.revision, input.payload.control, { principalRef: principal.principalRef, idempotencyKey: input.idempotencyKey }) ? "applied" : null;
    }
    if (input.operation === "reconcileRun") {
      const run = dispatch.read(input.runRef, false); approval(run.intent.approval.approvalRef, principal, run.intent.approval.manifestVersion); return run.executionCertainty;
    }
    return null;
  }
  async function execute(raw: unknown, principal: ApprovalPrincipal): Promise<ActionResponse> {
    const input = foundationActionSchema.parse(raw); scopeCheck(input.requestedScope);
    try { const grant = await actor(principal), result = await executeUnchecked(input, principal);
      assertActor(grant, principal); return result; }
    catch (error) {
      let prior: ActionResponse["executionCertainty"] | null = null;
      try { prior = priorCertainty(input, principal); } catch { /* A conflicting request is not its original receipt. */ }
      const typed = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; executionCertainty?: unknown } : {};
      const code = typeof typed.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(typed.code) ? typed.code : "SOURCE_UNAVAILABLE";
      const status = typeof typed.status === "number" && [400,401,403,404,409,422,429,500,502,503,504].includes(typed.status) ? typed.status : 503;
      const original = typed.executionCertainty === "applied" || typed.executionCertainty === "uncertain" ? typed.executionCertainty : "notApplied";
      throw new ActionServiceError(code, status, prior ?? original);
    }
  }
  async function executeDomain(raw: unknown, principal: ApprovalPrincipal): Promise<ActionResponse> {
    const input = domainActionSchema.parse(raw); scopeCheck(input.requestedScope);
    if (!options.domains) fail("SOURCE_ACTION_UNCONFIGURED");
    if (input.operation === "recordSourceDecision") {
      const target = input.entityRefs[0];
      if (target.accountId !== scope.accountId || target.provenanceRef !== input.expectedVersion) fail("SOURCE_SCOPE_DENIED", 403);
      const receipt = await options.domains.recordReadinessFromView(target.canonicalId, input.payload, input.expectedVersion, principal, input.idempotencyKey);
      return actionResponseSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: input.requestId, scope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment, authorizationScopeVersion: "actions.scope.v1" },
        actionRef: target.canonicalId, state: "succeeded", runRef: null, approvalRef: null, manifestRef: null, payloadVersion: receipt.recordedVersion,
        policyVersion: "readiness-record-only.v1", modelVersion: null, offerVersion: null, reasonCodes: ["READINESS_RECORDED_RELEASE_NOT_GRANTED"], receiptRefs: [receipt.receiptRef], nextAction: null, nextPollAfterMs: null, executionCertainty: "applied" });
    }
    const receipt = await options.domains.exportLedger(input.payload, input.expectedVersion, principal, input.idempotencyKey);
    return actionResponseSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId: input.requestId, scope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment, authorizationScopeVersion: "actions.scope.v1" },
      actionRef: receipt.artifactRef, state: "succeeded", runRef: receipt.runRef, approvalRef: null, manifestRef: null, payloadVersion: receipt.sha256,
      policyVersion: "authorized-ledger-export.v1", modelVersion: null, offerVersion: null, reasonCodes: ["ARTIFACT_GENERATED_RELEASE_NOT_GRANTED"], receiptRefs: [receipt.artifactRef], nextAction: null, nextPollAfterMs: null, executionCertainty: "applied" });
  }
  const publicVersion = (requirement: ApprovalDraft["productVersion"]) => requirement.state === "required"
    ? { state: "required" as const, version: alias("basis-version", requirement.version) }
    : { state: "notApplicable" as const, policyVersion: alias("policy", requirement.policyVersion), reason: "Not applicable under the recorded policy" };
  async function readApproval(ref: string, principal: ApprovalPrincipal) {
    const grant = await actor(principal); let a = approval(ref, principal);
    if (a.decisionReceipt?.decision === "approved") { await approvals.resolveCurrentProof(toIntent(a, a.manifest.items[0]!.itemRef).approval); a = approval(ref, principal); }
    assertActor(grant, principal);
    return nativeApprovalViewSchema.parse({ kind: "native-approval" as const, approvalRef: ref, manifestRef: manifestRef(a), version: token("approval", ref, a.manifest.manifestVersion),
      actionKind: a.manifest.draft.actionKind, policyVersion: alias("policy", a.manifest.draft.policyVersion), phase: a.manifest.draft.phase, manifestVersion: a.manifest.manifestVersion, current: a.current,
      createdAt: a.manifest.createdAt, expiresAt: a.manifest.draft.expiresAt, bounds: a.manifest.draft.bounds, exposure: a.manifest.draft.exposure.state === "known" ? a.manifest.draft.exposure : { state: "unknown", reason: "Authoritative economic exposure unavailable" },
      items: a.manifest.items.map(item => ({ itemRef: alias("item", item.itemRef), targetRef: alias("target", item.targetRef), itemVersion: alias("item-version", item.itemVersion), units: item.units, spendMinor: item.spendMinor })),
      versions: { product: publicVersion(a.manifest.draft.productVersion), terms: publicVersion(a.manifest.draft.termsVersion), rights: publicVersion(a.manifest.draft.rightsVersion) },
      requestState: a.request.state, sourceEffect: "none" as const,
      decision: a.decisionReceipt ? { receiptRef: alias("decision", a.decisionReceipt.receiptRef), decision: a.decisionReceipt.decision, decidedAt: a.decisionReceipt.decidedAt, actorRef: alias("person", a.decisionReceipt.personRef) } : null,
      appDecision: { allowed: false as const, reasonCode: "APPROVAL_CHANNEL_REQUIRED" }, approvedIsSent: false as const });
  }
  async function readRun(ref: string, principal: ApprovalPrincipal) {
    await actor(principal); const run = dispatch.read(ref), a = approval(run.intent.approval.approvalRef, principal, run.intent.approval.manifestVersion);
    return nativeRunViewSchema.parse({ kind: "native-run" as const, runRef: ref, version: token("run", ref, run.revision), approvalRef: a.manifest.approvalRef, manifestRef: manifestRef(a),
      state: run.run.state, control: run.run.control, current: run.current, executionCertainty: run.executionCertainty, counts: run.run.counts,
      usage: run.run.usage, items: run.items.map(item => ({ itemRef: alias("item", item.intent.approval.itemRef), receiptRef: item.receipt ? alias("effect", item.receipt.receiptRef) : null,
        sourceEffect: item.receipt?.sourceEffect ?? null, observedAt: item.receipt?.observedAt ?? null })) });
  }
  return { execute, executeDomain, readApproval, readRun, approvalVersion: (a: ApprovalRead) => token("approval", a.manifest.approvalRef, a.manifest.manifestVersion),
    manifestRef, runVersion: (run: DispatchRead) => token("run", run.runRef, run.revision), toIntent };
}
