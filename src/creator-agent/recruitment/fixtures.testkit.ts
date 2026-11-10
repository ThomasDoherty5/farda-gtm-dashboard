import { digest } from "../config.ts";
import type { ApprovalScope } from "../approvals/contract.ts";
import type { ReviewField } from "../actions/reviewViews.ts";
import { RecruitmentError, type RecruitmentSource, type RecruitmentSourceRequest, type RecruitmentSnapshot, type RecruitmentBatchSourceSnapshot } from "./source.ts";

/** Fictional permitted source snapshots only; no deployment configuration or provider calls. */
export function recruitmentSourceFixture(scope: ApprovalScope, clock: () => number) {
  const visible = (value: string): ReviewField => ({ state: "visible", value, reasonCode: null });
  const state = {
    denied: false, version: "synthetic-source-v1", observedAt: clock(), validUntil: clock() + 300_000,
    providerAccountRef: "synthetic-provider-account", willingness: "unknown" as "unknown" | "willing" | "feeRequested" | "declined",
    batch: null as Omit<RecruitmentBatchSourceSnapshot, "kind" | "binding" | "filters" | "sourceRef" | "sourceVersion" | "observedAt" | "validUntil" | "permission" | "reasonCodes" | "provenance"> | null,
    transform: null as ((snapshot: RecruitmentSnapshot) => void) | null,
    afterRead: null as (() => void | Promise<void>) | null,
  };
  const stamp = (value: number) => new Date(value).toISOString();
  function make(request: RecruitmentSourceRequest): RecruitmentSnapshot {
    const base = { provenance:{evidenceStage:"synthetic" as const,synthetic:true as const},binding: { scope, principalRef: request.actor.principalRef, directoryVersion: request.actor.directoryVersion,
      providerAccountRef: state.providerAccountRef, providerAccountVersion: "account-v1" },
      sourceRef: "synthetic-private-recruitment-source", sourceVersion: state.version,
      observedAt: stamp(state.observedAt), validUntil: stamp(state.validUntil),
      permission: state.denied ? "denied" as const : "permitted" as const, reasonCodes: [],
    };
    if (request.kind === "batch") {
      if (!state.batch) throw new RecruitmentError("RECRUITMENT_BATCH_NOT_FOUND", 404);
      return { ...base, ...structuredClone(state.batch), kind: "batch", filters: request.filters };
    }
    return { ...base, kind: "invitation", filters: request.filters, provider: "social-cat", account: visible("Fictional recruitment account"),
      complete: true, creators: [{ ref: "synthetic-private-profile", creatorId: "synthetic-creator", label: visible("Fictional creator"), eligible: true, reasonCodes: [] }],
      products: [{ ref: "synthetic-product", programRef: "synthetic-program", label: visible("Fictional product"), eligible: true, reasonCodes: [], market: visible("Fictional market"), category: visible("Fictional category") }],
      templates: [{ ref: "synthetic-template", version: "v1", claimsVersion: "synthetic-claims-v1", label: visible("Routine template"), text: visible("A fictional everyday routine invitation.") }],
      limits: { maxRateBps: 2000, maxValiditySeconds: 604800, startsNotBefore: null, expiresNotAfter: null, timezone: "America/Los_Angeles" },
      willingness: state.willingness, acceptedOffer: null, draftPermission: true,
      capacity: [{ kind: "invitations", unit: "native invitations", currency: null, remaining: null, limit: null, observedAt: null, validUntil: null, resetAt: null, reasonCodes: ["SOURCE_QUOTA_UNKNOWN"] }],
      samples: [], sourceLink: { state: "unavailable", url: null, label: "Open source record", reasonCode: "SOURCE_LINK_UNAVAILABLE" },
    };
  }
  const material = (snapshot: RecruitmentSnapshot) => structuredClone(snapshot);
  const source: RecruitmentSource = {
    async read(request) {
      const result = make(request); state.transform?.(result); await state.afterRead?.(); return result;
    },
    assertCurrent(request, snapshot, now) {
      if (state.denied) throw new RecruitmentError("RECRUITMENT_SOURCE_SCOPE_DENIED", 403);
      const current = make(request); state.transform?.(current);
      if (digest(material(current)) !== digest(material(snapshot)) || state.validUntil <= now)
        throw new RecruitmentError("RECRUITMENT_SOURCE_CHANGED");
    },
  };
  return { source, state, visible };
}
