import { digest } from "../config.ts";
import { ActionServiceError } from "./contract.ts";
import type { ActionReviewRequest, ActionReviewSource, ReviewSourceSnapshot } from "./reviewSource.ts";

/** Fictional read-only source; not a provider adapter or deployment credential. */
export function reviewSourceFixture(now: () => number) {
  const state = { permitted: true, version: "synthetic-review-v1", redactPayload: false,
    withheld: false, afterRead: null as null | (() => void | Promise<void>),
    transform: null as null | ((snapshot: ReviewSourceSnapshot) => ReviewSourceSnapshot) };
  const visible = (text: string) => ({ text, redacted: false });
  const project = (request: ActionReviewRequest): ReviewSourceSnapshot => {
    const m = request.manifest;
    const value: ReviewSourceSnapshot = {
      binding: { scope: request.scope, principalRef: request.actor.principalRef, directoryVersion: request.actor.directoryVersion,
        approvalRef: m.approvalRef, manifestVersion: m.manifestVersion, manifestHash: m.manifestHash, payloadHash: m.draft.payloadHash,
        providerAccountRef: m.draft.providerAccountRef, providerAccountVersion: m.draft.providerAccountVersion,
        decisionReceiptRef: request.decisionReceipt?.receiptRef ?? null, decisionReceiptHash: request.decisionReceipt ? digest(request.decisionReceipt) : null,
        runRef: request.run?.runRef ?? null, runRevision: request.run?.revision ?? null },
      sourceRef: "synthetic:review-record", sourceVersion: state.version, observedAt: new Date(now()).toISOString(), validUntil: new Date(now() + 60_000).toISOString(),
      grants: { context: ["provider", "account", "requestedBy", "reviewer", "historicalRole"],
        items: m.items.map(i => ({ itemRef: i.itemRef, fields: state.withheld ? ["recipient", "product", "terms"] : ["recipient", "product", "terms", "payload"], recovery: true })),
        links: ["approval", "source", "session", "settlement"], settlement: true },
      context: { provider: visible("Fictional sandbox source"), account: visible("Synthetic review account"), requestedBy: visible("Fictional operator"),
        reviewer: visible("Fictional reviewer"), historicalRole: visible("Reviewer at decision time") },
      items: m.items.map((i, n) => ({ itemRef: i.itemRef, itemVersion: i.itemVersion, itemHash: i.itemHash, targetRef: i.targetRef,
        targetVersion: i.targetVersion, payloadHash: i.payloadHash, recipient: visible(`Synthetic recipient ${n + 1}`), product: visible("Synthetic product context"),
        terms: visible("Source-bound commission terms; no upfront fee"), payload: { text: state.redactPayload ? "[Source redacted protected content]" : "Fictional exact review payload. No real outreach.", redacted: state.redactPayload },
        recovery: { kind: "login", owner: visible("Fictional account owner"), nextAction: "signInAtSource", deadline: null, resetAt: null, reasonCodes: ["SOURCE_LOGIN_REQUIRED"] } })),
      links: [{ kind: "approval", url: "https://review.example.test/archives/synthetic/p1", providerAccountRef: m.draft.providerAccountRef, manifestHash: m.manifestHash },
        { kind: "session", url: "https://review.example.test/handoff/synthetic", providerAccountRef: m.draft.providerAccountRef, manifestHash: m.manifestHash }],
      settlement: { lane: "notApplicable", detail: visible("This synthetic review does not settle a payment.") },
    };
    return state.transform ? state.transform(value) : value;
  };
  const material = (snapshot: ReviewSourceSnapshot) => ({ ...snapshot, observedAt: null, validUntil: null });
  const source: ActionReviewSource = {
    read: async request => { if (!state.permitted) throw new ActionServiceError("REVIEW_SOURCE_DENIED", 403); const value = project(request); await state.afterRead?.(); return structuredClone(value); },
    assertCurrent: (request, snapshot, at) => {
      if (!state.permitted) throw new ActionServiceError("REVIEW_SOURCE_DENIED", 403);
      if (Date.parse(snapshot.validUntil) <= at || digest(material(project(request))) !== digest(material(snapshot))) throw new ActionServiceError("REVIEW_SOURCE_CHANGED", 409);
    },
  };
  return { state, source, project };
}
