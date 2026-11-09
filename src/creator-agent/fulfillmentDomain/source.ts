import { z } from "zod";
import { approvalScopeSchema, approvalRefSchema as ref, approvalInstantSchema as instant, principalSchema,
  type ApprovalSources, type ApprovalDraft, type TrustedHuman } from "../approvals/contract.ts";
import type { RegisteredAction } from "../actions/registration.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import { fulfillmentKind, fulfillmentPlanSchema, type FulfillmentKind, type FulfillmentIntent } from "./contract.ts";

export const FULFILLMENT_SOURCE_TTL_MS=300_000;
export const fulfillmentSourceRequestSchema=z.object({scope:approvalScopeSchema,principal:principalSchema,personRef:ref,directoryVersion:ref,
  kind:fulfillmentKind,targetRef:ref,history:z.object({intentRef:ref,digest:ref}).strict().nullable()}).strict();
export type FulfillmentSourceRequest=z.infer<typeof fulfillmentSourceRequestSchema>;
export const fulfillmentSnapshotSchema=z.object({request:fulfillmentSourceRequestSchema,version:ref,permissionVersion:ref,policyVersion:ref,
  observedAt:instant,validUntil:instant,access:z.enum(["allowed","denied","unknown"]),canPropose:z.boolean(),synthetic:z.boolean(),
  historicalIntentAccess:z.enum(["allowed","denied","unknown"]).nullable(),unresolvedActionRef:ref.nullable(),plans:z.array(fulfillmentPlanSchema).max(100),
}).strict().superRefine((s,c)=>{
  if(new Set(s.plans.map(p=>p.planRef)).size!==s.plans.length || s.plans.some(p=>p.kind!==s.request.kind || p.sourceVersion!==s.version || p.policyVersion!==s.policyVersion || p.inspection && Date.parse(p.inspection.observedAt)>Date.parse(s.observedAt)))
    c.addIssue({code:"custom",message:"Plans must match the exact source request, revision, policy and observation."});
});
export type FulfillmentSnapshot=z.infer<typeof fulfillmentSnapshotSchema>;
export interface FulfillmentSource {
  /** Read-only plans for the exact opaque public target; no client-generated alias/composite is a source identity.
   * Historical lookup requires an explicit current grant even after the target version changes.
   * unresolvedActionRef must include any unresolved prior source effect so a new key cannot rebase it. */
  read(request:FulfillmentSourceRequest,options:{signal?:AbortSignal}):Promise<unknown>;
  assertCurrent(snapshot:FulfillmentSnapshot,request:FulfillmentSourceRequest,now:number):void;
}
export type FulfillmentOwnerObservation={intent:FulfillmentIntent;snapshot:FulfillmentSnapshot;actor:TrustedHuman};
export type FulfillmentOwner={
  registration:RegisteredAction;handlers:ReadonlyMap<string,DispatchHandler>;
  /** Pure source observation: never executes, reserves stock, creates a refund or changes a provider.
   * The existing owner must resolve the stored canonical payloadRef and dispatchKey for execution/reconciliation.
   * The bridge passes its handler and approval proof through unchanged; it grants no provider readiness. */
  resolveDraft(input:FulfillmentOwnerObservation & {phase:"preview"|"current"}):Promise<unknown>;
  assertCurrent(input:FulfillmentOwnerObservation,draft:ApprovalDraft,now:number):void;
};
export type FulfillmentBindings={source?:FulfillmentSource;authority?:ApprovalSources;owners?:ReadonlyMap<FulfillmentKind,FulfillmentOwner>};
