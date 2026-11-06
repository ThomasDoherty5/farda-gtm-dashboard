import { digest } from "./config.ts";
import type { FunnelEvent, FunnelType } from "./funnelContract.ts";
import { evt, fixtureRef, jan } from "./funnelFixtures.testkit.ts";

export function platformEvent(account: string, id: string, type: FunnelType, opportunity: string, options: {
  acquisition?: "social-cat" | "tiktok-shop"; producer?: string; day?: number; patch?: Partial<FunnelEvent>;
  details?: Partial<FunnelEvent["details"]>;
} = {}): FunnelEvent {
  const acquisition = options.acquisition ?? "social-cat", producer = options.producer ?? acquisition;
  const ref = (source: string, value: string) => ({ ...fixtureRef(source,value), accountId:account });
  const base = evt(id,type,opportunity,options.day ?? 5,{
    creatorRef:ref(acquisition,"native-private-creator-"+opportunity), sourceAccount:ref(producer,"native-private-account-"+producer),
    acquisitionRef:ref(acquisition,"native-private-acquisition-"+acquisition), campaignCohortRef:ref("notion","native-private-cohort"),
    collaborationRef:ref("notion","synthetic-collaboration-"+opportunity),
    ...(type === "sourceOutage" ? { evidenceRef:{ ...evt(id,"discovered").evidenceRef, access:"unavailable" as const } } : {}), details:{blockers:[],...options.details}, ...options.patch,
  });
  return { ...base, evidenceRef:{ ...base.evidenceRef, window:"2026-01-01/2026-01-31", ...options.patch?.evidenceRef } };
}
export function platformEnvelope(event: FunnelEvent) {
  return { jobId:"synthetic-reference-job", jobVersion:"v1", mode:event.correctsEventId ? "reconcile" : "observe", actor:{ id:"synthetic-reviewer", role:"observer" },
    accountRef:event.sourceAccount, policyVersion:event.policyOfferApprovalVersions.policy, inputHash:digest(event),
    idempotencyKey:event.eventId, correlationId:"synthetic-"+event.eventId, requestedAt:jan(25), deadline:null, checkpoint:null,event };
}
