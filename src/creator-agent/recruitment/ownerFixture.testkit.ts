import { digest } from "../config.ts";
import { acquisitionTermsOf } from "../commercialPolicy/evaluate.ts";
import type { ApprovalDraft, ApprovalManifest, ApprovalPrincipal } from "../approvals/contract.ts";
import type { OfferRepository } from "../offers/repository.ts";
import type { DispatchHandler, DispatchContext, DispatchReconcileContext } from "../jobs/dispatchSchema.ts";
import type { InvitationDraftRepository } from "./drafts.ts";
import { RecruitmentError, type RecruitmentInvitationOwner } from "./source.ts";
import { RECRUITMENT_INVITATION_ACTION, recruitmentInvitationPayloadRef } from "./proposalBridge.ts";

/** Explicitly fictional owner, actual canonical draft/handler protocol. No provider is contacted.
 * Callers can pass an existing qualified fictional handler to exercise their source protocol;
 * the default only records a local artifact and never reports an invitation delivered. */
export function recruitmentInvitationOwnerFixture(options:{drafts:InvitationDraftRepository;offers:Pick<OfferRepository,"readOffer">;
  baseDraft:ApprovalDraft;now:()=>number;handler?:DispatchHandler}) {
  const state={allowed:true,contexts:[] as (DispatchContext|DispatchReconcileContext)[],beforeFence:null as null|(()=>void)};
  const na={state:"notApplicable" as const,policyVersion:"synthetic-policy-v1",reason:"Fictional local artifact; no provider operation."};
  const handler:DispatchHandler=options.handler??{policyVersion:options.baseDraft.policyVersion,idempotency:"source-enforced",sourceEffect:"localArtifact",provider:na,
    resources:()=>({budget:na,stock:na,quota:na}),budgets:{maxItems:1,maxSteps:5,maxAttempts:2,maxRunMs:5000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},
    execute:async context=>{state.contexts.push(context);return {state:"unknown",reasonCode:"FICTIONAL_OWNER_NOT_EXECUTED"};},
    reconcile:async context=>{state.contexts.push(context);return {state:"unknown",reasonCode:"FICTIONAL_OWNER_NOT_EXECUTED"};}};
  function make(id:string,version:string,principal:ApprovalPrincipal):ApprovalDraft {
    const stored=options.drafts.readStored(id,principal,version);if(!stored)throw new RecruitmentError("RECRUITMENT_DRAFT_NOT_FOUND",404);
    const {draft,basis}=stored,offer=options.offers.readOffer(draft.terms.offerId)!;
    const until=new Date(Math.min(options.now()+300_000,Date.parse(options.baseDraft.sourceValidUntil),Date.parse(draft.terms.expiresAt))).toISOString();
    return {...structuredClone(options.baseDraft),actionKind:RECRUITMENT_INVITATION_ACTION,phase:"invitation",providerAccountRef:basis.providerAccountRef,providerAccountVersion:basis.providerAccountVersion,
      payloadRef:recruitmentInvitationPayloadRef(id,version),payloadHash:draft.payloadDigest,sourceBasisRef:basis.sourceRef,sourceBasisVersion:basis.sourceVersion,sourceValidUntil:until,expiresAt:draft.terms.expiresAt,
      productVersion:{state:"required",version:basis.productVersion},termsVersion:{state:"required",version:draft.terms.offerVersion},
      acquisitionTerms:acquisitionTermsOf(offer.terms),
      items:[{itemRef:basis.creatorRef,itemVersion:draft.version,targetRef:basis.creatorId,targetVersion:basis.sourceVersion,payloadHash:draft.payloadDigest,sourceRef:basis.sourceRef,units:0,spendMinor:0}],
      commercialOffers:[{itemRef:basis.creatorRef,offerRef:draft.terms.offerId,offerVersion:draft.terms.offerVersion}],
      bounds:{maxItems:1,maxUnits:0,maxSpendMinor:0,currency:"USD"},exposure:{state:"known",minor:0,currency:"USD"}};
  }
  function fromManifest(manifest:ApprovalManifest){const match=/^recruitment-invitation:([^:]+):(invitation-v[1-9]\d*)$/.exec(manifest.draft.payloadRef);
    if(!match)throw new RecruitmentError("RECRUITMENT_INVITATION_BINDING_CHANGED");return make(match[1]!,match[2]!,{principalRef:manifest.proposer.principalRef});}
  const sourceMaterial=(draft:ApprovalDraft)=>({...draft,commercialOffers:draft.commercialOffers?.map(({itemRef,offerRef})=>({itemRef,offerRef}))});
  const owner:RecruitmentInvitationOwner={handler,registry:{resolvePreview:async(command,principal)=>make(command.entityRef,command.entityVersion,principal),currentDraft:async manifest=>fromManifest(manifest),
    assertCurrentDraft(manifest,observed,now){state.beforeFence?.();if(!state.allowed||Date.parse(observed.sourceValidUntil)<=now||digest(sourceMaterial(fromManifest(manifest)))!==digest(sourceMaterial(observed)))throw new RecruitmentError("RECRUITMENT_INVITATION_SOURCE_CHANGED");}}};
  return {owner,state};
}
