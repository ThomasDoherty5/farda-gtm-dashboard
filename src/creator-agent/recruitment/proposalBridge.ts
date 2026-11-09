import { digest } from "../config.ts";
import { acquisitionTermsOf } from "../commercialPolicy/evaluate.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import type { ActionDomain } from "../actionDomains.ts";
import { approvalDraftSchema, type ApprovalDraft, type ApprovalPrincipal, type ApprovalScope, type TrustedHuman } from "../approvals/contract.ts";
import type { OfferRecord } from "../offers/contract.ts";
import type { StoredInvitationDraft } from "./drafts.ts";
import { RecruitmentError, type InvitationSourceSnapshot, type RecruitmentInvitationOwner } from "./source.ts";

export const RECRUITMENT_INVITATION_ACTION="recruitment.invitation";
export const RECRUITMENT_INVITATION_HANDLER="recruitment-invitation.v1";
export const recruitmentInvitationPayloadRef=(draftId:string,version:string)=>`recruitment-invitation:${draftId}:${version}`;
type Context={stored:StoredInvitationDraft;snapshot:InvitationSourceSnapshot;actor:TrustedHuman;record:OfferRecord;
  assertCurrent():void;bindApproval(ref:string,version:number):void};
type Options={owner?:RecruitmentInvitationOwner;loadSaved(id:string,version:string,principal:ApprovalPrincipal):Promise<Context>;
  alias(kind:string,value:string):string;scope:ApprovalScope;now():number;timeoutMs:number};
function fail(code="RECRUITMENT_INVITATION_BINDING_CHANGED"):never{throw new RecruitmentError(code);}

/** The source owner receives the original canonical manifest on currentDraft and unchanged
 * handler context/approvalProof on execute/reconcile. Only itemRef and its commercial selector
 * are mapped for public J04 selection equality; raw target/source/payload identity is preserved.
 * No effect is performed by resolvePreview/currentDraft. */
export function createRecruitmentActionDomain(options:Options):ActionDomain|undefined {
  const owner=options.owner;if(!owner)return undefined;
  if(!owner.registry.assertCurrentDraft||owner.handler.idempotency!=="source-enforced"||
    owner.handler.sourceEffect!=="providerApplied"&&owner.handler.sourceEffect!=="localArtifact"||
    owner.handler.sourceEffect==="providerApplied"&&owner.handler.provider.state!=="required")fail("RECRUITMENT_INVITATION_OWNER_INVALID");
  const retained=new Map<string,Context>();
  const contextKey=(d:ApprovalDraft,p:string)=>JSON.stringify([d.payloadRef,d.payloadHash,p]);
  const publicItem=(raw:string)=>options.alias("creator",raw);
  function validate(raw:unknown,c:Context):ApprovalDraft {
    const d=approvalDraftSchema.parse(raw),{draft,basis}=c.stored,item=d.items[0],offer=c.record.terms;
    if(d.actionKind!==RECRUITMENT_INVITATION_ACTION||d.phase!=="invitation"||!d.effects.sendsCreator||d.effects.spendsMoney||d.effects.changesPolicy||
      d.historicalLiability!==null||!d.acquisitionTerms||d.acquisitionTerms.relationship!=="commissionOnly"||d.acquisitionTerms.upfrontFeeMinor!==0||
      d.acquisitionTerms.guaranteedFeeMinor!==0||d.acquisitionTerms.paidComponentMinor!==0||
      digest(d.acquisitionTerms)!==digest(acquisitionTermsOf(offer))||
      d.bounds.maxItems!==1||d.bounds.maxUnits!==0||d.bounds.maxSpendMinor!==0||d.exposure.state!=="known"||d.exposure.minor!==0||
      d.items.length!==1||!item||item.itemRef!==basis.creatorRef||item.targetRef!==basis.creatorId||item.payloadHash!==draft.payloadDigest||item.units!==0||item.spendMinor!==0||
      item.sourceRef!==basis.sourceRef||item.targetVersion!==basis.sourceVersion||item.itemVersion!==draft.version||
      d.payloadHash!==draft.payloadDigest||d.payloadRef!==recruitmentInvitationPayloadRef(draft.draftId,draft.version)||
      d.sourceBasisRef!==basis.sourceRef||d.sourceBasisVersion!==basis.sourceVersion||
      d.providerAccountRef!==basis.providerAccountRef||d.providerAccountVersion!==basis.providerAccountVersion||
      d.productVersion.state!=="required"||d.productVersion.version!==basis.productVersion||d.termsVersion.state!=="required"||d.termsVersion.version!==draft.terms.offerVersion||
      !d.commercialOffers||d.commercialOffers.length!==1||d.commercialOffers[0]?.itemRef!==basis.creatorRef||d.commercialOffers[0]?.offerRef!==offerId(c)||d.commercialOffers[0]?.offerVersion!==undefined&&d.commercialOffers[0]?.offerVersion!==draft.terms.offerVersion||
      Date.parse(d.sourceValidUntil)>Date.parse(c.snapshot.validUntil)||Date.parse(d.sourceValidUntil)>Date.parse(c.actor.validUntil)||Date.parse(d.sourceValidUntil)<=options.now()||
      Date.parse(d.expiresAt)>Date.parse(draft.terms.expiresAt)||Date.parse(d.expiresAt)<=options.now()||
      !c.snapshot.provenance.synthetic&&owner!.handler.sourceEffect!=="providerApplied")return fail();
    c.assertCurrent();return d;
  }
  function offerId(c:Context){return c.stored.draft.terms.offerId;}
  function publish(d:ApprovalDraft){return {...d,items:d.items.map(i=>({...i,itemRef:publicItem(i.itemRef)})),
    commercialOffers:d.commercialOffers?.map(o=>({...o,itemRef:publicItem(o.itemRef)}))};}
  function original(d:ApprovalDraft,c:Context){const id=c.stored.basis.creatorRef;
    if(d.items.length!==1||d.items[0]?.itemRef!==publicItem(id)||d.commercialOffers?.some(o=>o.itemRef!==publicItem(id)))return fail();
    return {...d,items:d.items.map(i=>({...i,itemRef:id})),commercialOffers:d.commercialOffers?.map(o=>({...o,itemRef:id}))};}
  function keep(d:ApprovalDraft,c:Context,principal:string){
    for(const [key,old] of retained)if(Date.parse(old.snapshot.validUntil)<=options.now())retained.delete(key);
    if(retained.size>=500)retained.delete(retained.keys().next().value!);
    retained.set(contextKey(d,principal),c);return publish(d);
  }
  return {actions:new Map([[RECRUITMENT_INVITATION_ACTION,{handlerRef:RECRUITMENT_INVITATION_HANDLER}]]),
    handlers:new Map([[RECRUITMENT_INVITATION_HANDLER,owner.handler]]),registry:{
      async resolvePreview(command,principal,scope){
        if(digest(scope)!==digest(options.scope)||command.actionKind!==RECRUITMENT_INVITATION_ACTION)return fail();
        const c=await options.loadSaved(command.entityRef,command.entityVersion,principal),id=c.stored.basis.creatorRef;
        if(command.selectionRefs.length!==1||command.selectionRefs[0]!==publicItem(id))return fail("RECRUITMENT_INVITATION_SELECTION_INVALID");
        const raw=await boundedSourceRead(()=>owner.registry.resolvePreview({...command,selectionRefs:[id]},principal,scope),undefined,options.timeoutMs);
        return keep(validate(raw,c),c,principal.principalRef);
      },
      async currentDraft(manifest){
        const match=/^recruitment-invitation:([A-Za-z0-9][A-Za-z0-9_-]{0,119}):(invitation-v[1-9]\d*)$/.exec(manifest.draft.payloadRef);
        if(!match)return fail();
        const c=await options.loadSaved(match[1]!,match[2]!,{principalRef:manifest.proposer.principalRef});
        const raw=await boundedSourceRead(()=>owner.registry.currentDraft(manifest),undefined,options.timeoutMs);
        return keep(validate(raw,c),c,manifest.proposer.principalRef);
      },
      assertCurrentDraft(manifest,observed,now){
        const c=retained.get(contextKey(observed,manifest.proposer.principalRef));if(!c)return fail("RECRUITMENT_INVITATION_SOURCE_UNVERIFIED");
        const raw=validate(original(observed,c),c);
        assertSynchronousVoid(()=>owner.registry.assertCurrentDraft!(manifest,raw,now));c.assertCurrent();
        // J04 calls this inside its existing BEGIN IMMEDIATE before inserting the immutable manifest.
        c.bindApproval(manifest.approvalRef,manifest.manifestVersion);c.assertCurrent();
      },
    }};
}
