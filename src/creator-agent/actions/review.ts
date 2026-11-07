import { createHmac } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import { approvalScopeSchema, approvalInstantSchema, approvalHashSchema, approvalRefSchema, trustedHumanSchema } from "../approvals/contract.ts";
import { ActionServiceError } from "./contract.ts";
import { nativeApprovalViewSchema, nativeRunViewSchema } from "./views.ts";
import { approvalReviewSchema, approvalHistorySchema, runItemExecutionSchema, runAttemptOutcomeSchema,
  type ApprovalReview, type ReviewField, type ReviewLink, type RunItemRecovery } from "./reviewViews.ts";
import type { ActionReviewOptions, ActionReviewRequest, ActionReviewService, ReviewSourceSnapshot, ApprovalReviewInput, RunReviewInput,
  ReviewContextField, ReviewItemField, ReviewLinkKind, ReviewSourceText } from "./reviewSource.ts";

const ref = approvalRefSchema, instant = approvalInstantSchema, count = z.number().int().nonnegative().safe();
const text = z.object({ text: z.string().min(1).max(12_000), redacted: z.boolean() }).strict();
const contextField = z.enum(["provider", "account", "requestedBy", "reviewer", "historicalRole"]);
const itemField = z.enum(["recipient", "product", "terms", "payload"]);
const linkKind = z.enum(["approval", "source", "session", "settlement"]);
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const recovery = z.object({ kind: z.enum(["login", "mfa", "denied", "throttled", "failed", "uncertain", "notApplicable", "unknown"]),
  owner: text.nullable(), nextAction: z.enum(["signInAtSource", "completeMfaAtSource", "ownerPermissionReview", "waitForSourceReset", "inspectFailure", "reconcileOriginal", "none", "sourceEvidenceRequired"]),
  deadline: instant.nullable(), resetAt: instant.nullable(), reasonCodes: z.array(reason).max(30) }).strict();
export const reviewSourceSnapshotSchema = z.object({
  binding: z.object({ scope: approvalScopeSchema, principalRef: ref, directoryVersion: ref, approvalRef: ref,
    manifestVersion: count.positive(), manifestHash: approvalHashSchema, payloadHash: approvalHashSchema,
    providerAccountRef: ref, providerAccountVersion: ref, decisionReceiptRef: ref.nullable(), decisionReceiptHash: approvalHashSchema.nullable(),
    runRef: ref.nullable(), runRevision: count.nullable() }).strict(),
  sourceRef: ref, sourceVersion: ref, observedAt: instant, validUntil: instant,
  grants: z.object({ context: z.array(contextField).max(5), items: z.array(z.object({ itemRef: ref, fields: z.array(itemField).max(4), recovery: z.boolean() }).strict()).max(100),
    links: z.array(linkKind).max(4), settlement: z.boolean() }).strict(),
  context: z.object({ provider: text.nullable(), account: text.nullable(), requestedBy: text.nullable(), reviewer: text.nullable(), historicalRole: text.nullable() }).strict(),
  items: z.array(z.object({ itemRef: ref, itemVersion: ref, itemHash: approvalHashSchema, targetRef: ref, targetVersion: ref, payloadHash: approvalHashSchema,
    recipient: text.nullable(), product: text.nullable(), terms: text.nullable(), payload: text.nullable(), recovery: recovery.nullable() }).strict()).max(100),
  links: z.array(z.object({ kind: linkKind, url: z.string().min(1).max(2_000), providerAccountRef: ref, manifestHash: approvalHashSchema }).strict()).max(4),
  settlement: z.object({ lane: z.enum(["manualHistoricalPayable", "collabsAutoSettlement", "tiktokAutoSettlement", "notApplicable"]), detail: text.nullable() }).strict().nullable(),
}).strict();

const contextFields: ReviewContextField[] = ["provider", "account", "requestedBy", "reviewer", "historicalRole"];
const itemFields: ReviewItemField[] = ["recipient", "product", "terms", "payload"];
const linkLabels: Record<ReviewLinkKind, string> = { approval: "Open exact approval in Slack", source: "Open source record", session: "Open source handoff", settlement: "Open settlement record" };
const unavailable = (reasonCode = "REVIEW_FIELD_UNAVAILABLE"): ReviewField => ({ state: "unavailable", value: null, reasonCode });
const unavailableRecovery = (): RunItemRecovery => ({ kind: "unknown", owner: unavailable(), nextAction: "sourceEvidenceRequired",
  deadline: null, resetAt: null, reasonCodes: ["RECOVERY_SOURCE_UNAVAILABLE"], observedAt: null, validUntil: null });
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
// Defense in depth. The trusted source must separately exclude contacts, health data and session material.
const forbiddenSecret = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:Bearer\s+\S+|(?:password|cookie|access_token|refresh_token|session_token|api[_ -]?key)\s*[:=]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|xoxb-|sk_live_)[A-Za-z0-9_-]{12,}/i;
const forbiddenText = { test: (value: string) => forbiddenSecret.test(value) || /(?:\+?\d[\s().-]*){10,}/.test(value) };
const display = (value: ReviewSourceText | null, allowed: boolean): ReviewField => !allowed ? unavailable("REVIEW_FIELD_WITHHELD")
  : !value ? unavailable() : forbiddenText.test(value.text) ? unavailable("REVIEW_PRIVATE_MATERIAL_WITHHELD")
    : value.redacted ? { state: "redacted", value: value.text, reasonCode: "REVIEW_SOURCE_REDACTED" }
      : { state: "visible", value: value.text, reasonCode: null };
function assertSynchronous(assertion: () => void) {
  const result: unknown = assertion();
  // TypeScript permits async implementations of void callbacks. An async final fence
  // cannot attest the protected return in this synchronous critical section.
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => undefined);
    throw new ActionServiceError("REVIEW_SOURCE_AUTHORITY_UNAVAILABLE", 403, "notApplied");
  }
}

/** Read-only display composition. Source permission never becomes decision or execution authority. */
export function createActionReviewService(options: ActionReviewOptions): ActionReviewService {
  const scope = approvalScopeSchema.parse(options.scope);
  if (options.referenceKey.length < 32) throw new Error("Action review reference key must be private.");
  const now = () => { const n = (options.now ?? Date.now)(); if (!Number.isFinite(n)) throw new ActionServiceError("INVALID_CLOCK", 500, "notApplied"); return n; };
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", options.referenceKey).update(JSON.stringify([scope, kind, value])).digest("hex");
  const origins = new Set((options.permittedLinkOrigins ?? []).map(origin => {
    const u = new URL(origin); if (u.protocol !== "https:" || u.username || u.password || u.origin !== origin || u.search || u.hash) throw new Error("Review link origins must be exact HTTPS origins."); return origin;
  }));
  function checkInput(input: ApprovalReviewInput | RunReviewInput) {
    const actor = trustedHumanSchema.parse(input.actor), manifest = input.record.manifest;
    if (digest(actor.scope) !== digest(scope) || digest(manifest.scope) !== digest(scope) || actor.principalRef !== manifest.proposer.principalRef ||
      !actor.active || !actor.roles.some(role => ["founder", "operator", "reviewer", "finance"].includes(role)) ||
      Date.parse(actor.observedAt) > now() || Date.parse(actor.validUntil) <= now() || Date.parse(actor.observedAt) >= Date.parse(actor.validUntil))
      throw new ActionServiceError("AUTHORITY_REQUIRED", 403, "notApplied");
    assertSynchronous(input.assertCurrent);
  }
  function checkBaseItems(input: ApprovalReviewInput | RunReviewInput) {
    const items = input.base.items, manifest = input.record.manifest;
    if (!unique(items.map(item => item.itemRef)) || items.some(item => !manifest.items.some(original => alias("item", original.itemRef) === item.itemRef)))
      throw new ActionServiceError("REVIEW_MANIFEST_CHANGED", 409, "notApplied");
    if (!("dispatch" in input) && items.length !== manifest.items.length)
      throw new ActionServiceError("REVIEW_MANIFEST_CHANGED", 409, "notApplied");
  }
  function requestFor(input: ApprovalReviewInput | RunReviewInput): ActionReviewRequest {
    checkInput(input);
    return structuredClone({ scope, actor: input.actor, manifest: input.record.manifest, decisionReceipt: input.record.decisionReceipt,
      run: "dispatch" in input ? { runRef: input.dispatch.runRef, revision: input.dispatch.revision } : null });
  }
  function bound(snapshot: ReviewSourceSnapshot, request: ActionReviewRequest) {
    const m = request.manifest, b = snapshot.binding;
    if (digest(b.scope) !== digest(scope) || b.principalRef !== request.actor.principalRef || b.directoryVersion !== request.actor.directoryVersion ||
      b.approvalRef !== m.approvalRef || b.manifestVersion !== m.manifestVersion || b.manifestHash !== m.manifestHash || b.payloadHash !== m.draft.payloadHash ||
      b.providerAccountRef !== m.draft.providerAccountRef || b.providerAccountVersion !== m.draft.providerAccountVersion ||
      b.decisionReceiptRef !== (request.decisionReceipt?.receiptRef ?? null) || b.decisionReceiptHash !== (request.decisionReceipt ? digest(request.decisionReceipt) : null) ||
      b.runRef !== (request.run?.runRef ?? null) || b.runRevision !== (request.run?.revision ?? null) ||
      !unique(snapshot.items.map(i => i.itemRef)) || !unique(snapshot.grants.items.map(i => i.itemRef)) || !unique(snapshot.grants.context) || !unique(snapshot.grants.links) || !unique(snapshot.links.map(i => i.kind)))
      return false;
    for (const item of snapshot.items) {
      const original = m.items.find(i => i.itemRef === item.itemRef);
      if (!original || ["itemVersion", "itemHash", "targetRef", "targetVersion", "payloadHash"].some(key => original[key as keyof typeof original] !== item[key as keyof typeof item])) return false;
    }
    return snapshot.grants.items.every(g => snapshot.items.some(i => i.itemRef === g.itemRef) && unique(g.fields)) &&
      snapshot.links.every(link => link.providerAccountRef === m.draft.providerAccountRef && link.manifestHash === m.manifestHash);
  }
  function sourceFresh(snapshot: ReviewSourceSnapshot) {
    return Date.parse(snapshot.observedAt) <= now() && Date.parse(snapshot.validUntil) > now() && Date.parse(snapshot.observedAt) < Date.parse(snapshot.validUntil);
  }
  async function read(input: ApprovalReviewInput | RunReviewInput) {
    const request = requestFor(input);
    const inputIdentity = () => digest({ base: input.base, record: input.record, actor: input.actor,
      history: "history" in input ? input.history ?? null : null,
      dispatch: "dispatch" in input ? input.dispatch : null,
      attempts: "attemptOutcomes" in input ? [...(input.attemptOutcomes?.entries() ?? [])] : null });
    const originalIdentity = inputIdentity();
    let snapshot: ReviewSourceSnapshot | null = null;
    if (options.source) {
      const raw = await options.source.read(structuredClone(request));
      checkInput(input);
      if (raw !== null) {
        const parsed = reviewSourceSnapshotSchema.safeParse(raw);
        if (!parsed.success || !bound(parsed.data, request)) throw new ActionServiceError("REVIEW_SOURCE_BINDING_INVALID", 409, "notApplied");
        if (!sourceFresh(parsed.data)) throw new ActionServiceError("REVIEW_SOURCE_EXPIRED", 409, "notApplied");
        snapshot = parsed.data;
      }
    }
    const fence = () => {
      if (inputIdentity() !== originalIdentity) throw new ActionServiceError("REVIEW_MANIFEST_CHANGED", 409, "notApplied");
      checkInput(input);
      if (snapshot) {
        if (!sourceFresh(snapshot)) throw new ActionServiceError("REVIEW_SOURCE_EXPIRED", 409, "notApplied");
        if (!options.source?.assertCurrent) throw new ActionServiceError("REVIEW_SOURCE_AUTHORITY_UNAVAILABLE", 403, "notApplied");
        assertSynchronous(() => options.source!.assertCurrent(structuredClone(request), structuredClone(snapshot), now()));
      }
      checkInput(input);
    };
    fence();
    return { snapshot, fence };
  }
  function link(snapshot: ReviewSourceSnapshot | null, kind: ReviewLinkKind): ReviewLink {
    const missing = (reasonCode: string): ReviewLink => ({ state: "unavailable", url: null, label: linkLabels[kind], reasonCode });
    if (!snapshot?.grants.links.includes(kind)) return missing("REVIEW_LINK_WITHHELD");
    const found = snapshot.links.find(value => value.kind === kind); if (!found) return missing("REVIEW_LINK_UNAVAILABLE");
    try {
      const u = new URL(found.url);
      if (u.protocol !== "https:" || u.username || u.password || u.hash || !origins.has(u.origin) || forbiddenSecret.test(decodeURIComponent(u.pathname)) ||
        [...u.searchParams.entries()].some(([key,value]) => key === "thread_ts" ? !/^\d{10}\.\d{6}$/.test(value) : key === "cid" ? !/^[CDG][A-Z0-9]{8,}$/.test(value) : true)) return missing("REVIEW_LINK_NOT_PERMITTED");
      return { state: "available", url: found.url, label: linkLabels[kind] };
    } catch { return missing("REVIEW_LINK_NOT_PERMITTED"); }
  }
  function review(input: ApprovalReviewInput | RunReviewInput, snapshot: ReviewSourceSnapshot | null): ApprovalReview {
    const context = Object.fromEntries(contextFields.map(field => [field, display(snapshot?.context[field] ?? null, snapshot?.grants.context.includes(field) ?? false)]));
    const items: ApprovalReview["items"] = input.record.manifest.items.map(item => {
      const source = snapshot?.items.find(i => i.itemRef === item.itemRef), grant = snapshot?.grants.items.find(i => i.itemRef === item.itemRef);
      const field = (name: ReviewItemField) => display(source?.[name] ?? null, grant?.fields.includes(name) ?? false);
      return { itemRef: alias("item", item.itemRef), recipient: field("recipient"), product: field("product"), terms: field("terms"), payload: field("payload") };
    });
    const all = [...Object.values(context), ...items.flatMap(item => itemFields.map(field => item[field]))];
    const state = !snapshot ? "unavailable" : all.every(field => field.state === "visible") ? "complete" : "partial";
    return approvalReviewSchema.parse({ state, sourceVersionAlias: snapshot ? alias("review-source", snapshot.sourceVersion) : null,
      observedAt: snapshot?.observedAt ?? null, validUntil: snapshot ? new Date(Math.min(Date.parse(snapshot.validUntil), Date.parse(input.actor.validUntil))).toISOString() : null,
      reasonCodes: !snapshot ? ["REVIEW_SOURCE_UNAVAILABLE"] : state === "partial" ? ["REVIEW_FIELDS_INCOMPLETE"] : [],
      context, items, links: Object.fromEntries((Object.keys(linkLabels) as ReviewLinkKind[]).map(kind => [kind, link(snapshot, kind)])),
      settlement: { lane: snapshot?.grants.settlement ? snapshot.settlement?.lane ?? "unknown" : "unknown",
        detail: display(snapshot?.settlement?.detail ?? null, snapshot?.grants.settlement ?? false) }, confersAuthority: false });
  }
  function history(input: ApprovalReviewInput) {
    if (!input.history) return undefined;
    const selected = input.record, h = input.history;
    for (const row of h.records) {
      if (row.manifest.approvalRef !== selected.manifest.approvalRef || digest(row.manifest.scope) !== digest(scope) || row.manifest.proposer.principalRef !== input.actor.principalRef)
        throw new ActionServiceError("REVIEW_HISTORY_SCOPE_INVALID", 403, "notApplied");
    }
    const decision = (d: NonNullable<typeof selected.decisionReceipt>) => ({ decision: d.decision, decidedAt: d.decidedAt, actorRef: alias("person", d.personRef), receiptRef: alias("decision", d.receiptRef) });
    return approvalHistorySchema.parse({ mode: h.mode, selectedVersion: selected.manifest.manifestVersion, latestVersion: h.latestVersion,
      records: h.records.map(row => ({ manifestVersion: row.manifest.manifestVersion, createdAt: row.manifest.createdAt, expiresAt: row.manifest.draft.expiresAt,
        manifestRef: "manifest-" + row.manifest.manifestHash, decision: row.decisionReceipt ? decision(row.decisionReceipt) : null, outcomeCount: row.outcomeRefs.length })),
      selectedDecisions: selected.decisionHistory.map(decision), totalVersions: h.total, hasMore: h.nextBeforeVersion !== null,
      nextBeforeVersion: h.nextBeforeVersion, confersAuthority: false });
  }
  return {
    async decorateApproval(input) {
      const { snapshot, fence } = await read(input);
      checkBaseItems(input);
      if (input.base.approvalRef !== input.record.manifest.approvalRef || input.base.manifestVersion !== input.record.manifest.manifestVersion ||
        input.base.manifestRef !== "manifest-" + input.record.manifest.manifestHash) throw new ActionServiceError("REVIEW_MANIFEST_CHANGED", 409, "notApplied");
      const result = nativeApprovalViewSchema.parse({ ...input.base, review: review(input, snapshot), ...(input.history ? { history: history(input) } : {}) });
      fence(); return result;
    },
    async decorateRun(input) {
      const { snapshot, fence } = await read(input), m = input.record.manifest;
      checkBaseItems(input);
      if (input.base.runRef !== input.dispatch.runRef || input.base.approvalRef !== m.approvalRef || input.base.manifestRef !== "manifest-" + m.manifestHash)
        throw new ActionServiceError("REVIEW_MANIFEST_CHANGED", 409, "notApplied");
      const result = nativeRunViewSchema.parse({ ...input.base, review: review(input, snapshot), approvalManifestVersion: m.manifestVersion,
        items: input.base.items.map(item => {
          const d = input.dispatch.items.find(value => alias("item", value.intent.approval.itemRef) === item.itemRef);
          const job = d ? input.dispatch.run.items.find(value => value.itemKey === d.dispatchKey) : null;
          if (!d || !job || d.intent.approval.manifestHash !== m.manifestHash || d.intent.approval.manifestVersion !== m.manifestVersion)
            throw new ActionServiceError("REVIEW_RUN_ITEM_CHANGED", 409, "notApplied");
          const source = snapshot?.items.find(value => value.itemRef === d.intent.approval.itemRef), grant = snapshot?.grants.items.find(value => value.itemRef === d.intent.approval.itemRef);
          const sourceRecovery = grant?.recovery ? source?.recovery : null;
          const found = input.attemptOutcomes?.get(d.dispatchKey), parsed = runAttemptOutcomeSchema.safeParse(found);
          const attemptOutcome = parsed.success && (!parsed.data.observedAt || Date.parse(parsed.data.observedAt) <= now()) ? { ...parsed.data, receiptRef: parsed.data.receiptRef ? alias("attempt-outcome", parsed.data.receiptRef) : null }
            : { state: "unknown" as const, attemptNumber: null, receiptRef: null, observedAt: null };
          return { ...item, execution: runItemExecutionSchema.parse({ state: job.state, attempts: job.attempts, dueAt: job.dueAt,
            updatedAt: job.updatedAt, checkpointVersion: job.checkpointVersion, reasonCode: job.reasonCode,
            attemptOutcome, recovery: sourceRecovery && snapshot ? { ...sourceRecovery, owner: display(sourceRecovery.owner, true),
              observedAt: snapshot.observedAt, validUntil: new Date(Math.min(Date.parse(snapshot.validUntil), Date.parse(input.actor.validUntil))).toISOString() } : unavailableRecovery() }) };
        }) });
      fence(); return result;
    },
  };
}
