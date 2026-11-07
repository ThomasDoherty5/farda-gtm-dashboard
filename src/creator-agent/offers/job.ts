import { z } from "zod";
import { digest } from "../config.ts";
import { offerTermsSchema, type OfferRecord, type OfferScope, type OfferTerms } from "./contract.ts";

const id=z.string().trim().min(1).max(180), time=z.string().datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)));
/** An internal reviewer-facing J03 proposal operation. Job registration and dispatch are separate owners. */
export const offerJobEnvelopeSchema=z.object({
  jobId:z.literal("J03"),jobVersion:z.literal("creator-offer.v1"),mode:z.literal("propose"),
  actor:z.object({id:z.literal("agent-reviewer"),role:z.literal("reviewer")}).strict(),
  accountRef:z.object({workspaceId:id,accountId:id}).strict(),policyVersion:id,
  inputHash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().trim().min(1).max(240),correlationId:id,
  requestedAt:time,deadline:time.nullable(),checkpoint:z.null(),
}).strict();
export type OfferJobEnvelope=z.infer<typeof offerJobEnvelopeSchema>;
export const offerJobRequestSchema=z.object({
  envelope:offerJobEnvelopeSchema,expectedVersion:id.nullable(),terms:offerTermsSchema,
}).strict();
export const offerInputHash=(offerId:string,expectedVersion:string|null,terms:OfferTerms)=>digest({offerId,expectedVersion,terms});
export function scopeMatchesJob(envelope:OfferJobEnvelope,scope:OfferScope,id:string,expectedVersion:string|null,terms:OfferTerms,key:string) {
  return envelope.accountRef.workspaceId===scope.workspaceId && envelope.accountRef.accountId===scope.accountId &&
    envelope.idempotencyKey===key && envelope.inputHash===offerInputHash(id,expectedVersion,terms) && envelope.policyVersion===terms.policyVersion;
}
export function jobResult(record:OfferRecord,envelope:OfferJobEnvelope) {
  return {
    envelope,draftOfferRef:record.offerId,offerVersion:record.version,manifestHash:record.manifestHash,
    componentOwners:[
      {component:"terms and economics",owner:"J03"},
      {component:"approval",owner:"J04"},
      {component:"sample and shipping",owner:"J07/J15"},
      {component:"commission payout",owner:record.provider?.payoutOwner??null},
      {component:"reward fulfillment",owner:"J11"},
    ],
    economicsScenarios:record.scenarios,proposedCommitments:{
      currency:record.terms.commission.currency,commission:record.terms.commission,sample:record.terms.sample,
      rewardVersion:record.terms.rewardVersion,historicalObligationRefs:record.terms.historicalObligationRefs,
    },
    missingInputs:record.blockers,proposedManifest:{hash:record.manifestHash,creatorId:record.terms.creatorId,provider:record.terms.provider,
      scope:envelope.accountRef,terms:record.terms,brief:record.terms.manifest},
    state:record.state,sourceEffects:"none",reserved:false,submitted:false,funded:false,activated:false,
  };
}
