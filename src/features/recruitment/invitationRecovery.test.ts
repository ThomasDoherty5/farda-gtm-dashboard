import { webcrypto } from "node:crypto";
import { SCHEMA_VERSION, type SaveResourceResponse } from "@/adapter/contract";
import type { InvitationSaveReceipt, NativeInvitationView } from "@/creator-agent/recruitment/contract";
import { prepareInvitation, matchesInvitationAck, recoverInvitation } from "./invitationRecovery";
beforeAll(()=>vi.stubGlobal("crypto",webcrypto));afterAll(()=>vi.unstubAllGlobals());
const scope={workspaceId:"synthetic",accountId:"synthetic",environment:"sandbox" as const};
async function example(){
  const pending=await prepareInvitation(scope,"person-synthetic",{kind:"recruitmentInvitation",draftId:"synthetic-invitation",expectedVersion:null,terms:{creatorId:"synthetic-creator",offerId:"synthetic-offer",offerVersion:"v1",productRef:"product-synthetic",programRef:"program-synthetic",sourceVersion:"source-v1",templateRef:"template-synthetic",templateVersion:"template-v1",claimsVersion:"claims-v1",message:"A fictional everyday routine invitation.",startsAt:"2026-11-09T07:00:00Z",expiresAt:"2026-11-09T07:30:00Z",timezone:"UTC",sampleRequested:true}});
  const receipt:InvitationSaveReceipt={scope,expectedVersion:null,actorRef:pending.actorRef,requestKey:pending.requestKey,payloadDigest:pending.payloadDigest,resourceRef:pending.payload.draftId,version:"invitation-v1",updatedAt:"2026-11-09T06:00:00Z",sourceEffect:"none",resource:{draftId:pending.payload.draftId,version:"invitation-v1",recordedAt:"2026-11-09T06:00:00Z",actorRef:pending.actorRef,terms:pending.payload.terms,payloadDigest:"a".repeat(64),sourceEffect:"none"}};
  const ack:SaveResourceResponse<InvitationSaveReceipt>={schemaVersion:SCHEMA_VERSION,requestId:"request",scope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox",authorizationScopeVersion:"v1"},resourceRef:receipt.resourceRef,resourceVersion:receipt.version,persistedAt:receipt.updatedAt,persistedByRef:receipt.actorRef,record:receipt,reasonCodes:[],executionCertainty:"applied"};
  const data:Pick<NativeInvitationView,"requestRecovery"|"actorRef"|"filters">={actorRef:pending.actorRef,filters:{context:"recruitment",draftId:receipt.resourceRef,requestKey:pending.requestKey,creatorId:pending.payload.terms.creatorId,offerId:pending.payload.terms.offerId,offerVersion:pending.payload.terms.offerVersion},requestRecovery:{requestKey:pending.requestKey,state:"recorded",receipt,confersRetry:false}};
  return {pending,receipt,ack,data};
}
describe("invitation original save recovery",()=>{
  it("matches exact acknowledgment and restores from scoped server readback after reload",async()=>{const w=await example();expect(matchesInvitationAck(w.ack,w.pending)).toBe(true);expect((await recoverInvitation(scope,w.data,w.pending.requestKey,null))?.pending).toEqual(w.pending);});
  it.each(["resourceRef","resourceVersion","persistedAt","persistedByRef"] as const)("rejects a mismatched outer %s",async field=>{const w=await example();expect(matchesInvitationAck({...w.ack,[field]:"different"},w.pending)).toBe(false);});
  it.each(["requestKey","expectedVersion","payloadDigest","actorRef"] as const)("rejects a different request %s",async field=>{const w=await example();expect(matchesInvitationAck({...w.ack,record:{...w.receipt,[field]:"different"}},w.pending)).toBe(false);});
  it("rejects foreign scope, uncertain ACK and changed original message",async()=>{const w=await example();expect(matchesInvitationAck({...w.ack,executionCertainty:"uncertain"},w.pending)).toBe(false);expect(await recoverInvitation({...scope,accountId:"foreign"},w.data,w.pending.requestKey,null)).toBeNull();w.receipt.resource.terms.message="Changed message";expect(await recoverInvitation(scope,w.data,w.pending.requestKey,null)).toBeNull();});
  it.each(["creatorId","offerId","offerVersion"] as const)("rejects a receipt for a different selected %s",async field=>{const w=await example();
    const filters={...w.data.filters,[field]:field==="offerVersion"?"v2":"different-selection"};
    expect(await recoverInvitation(scope,{...w.data,filters},w.pending.requestKey,null)).toBeNull();
  });
  it("an absent read cannot unlock new-key retries",async()=>{const w=await example();w.data.requestRecovery={requestKey:w.pending.requestKey,state:"notFound",receipt:null,confersRetry:false};expect(await recoverInvitation(scope,w.data,w.pending.requestKey,w.pending)).toBeNull();});
  it("rejects another actor, draft or pending payload even with a valid-looking receipt",async()=>{const w=await example();expect(await recoverInvitation(scope,{...w.data,actorRef:"other"},w.pending.requestKey,null)).toBeNull();expect(await recoverInvitation(scope,{...w.data,filters:{context:"recruitment",draftId:"other"}},w.pending.requestKey,null)).toBeNull();expect(await recoverInvitation(scope,w.data,w.pending.requestKey,{...w.pending,payload:{...w.pending.payload,terms:{...w.pending.payload.terms,sampleRequested:false}}})).toBeNull();});
});
