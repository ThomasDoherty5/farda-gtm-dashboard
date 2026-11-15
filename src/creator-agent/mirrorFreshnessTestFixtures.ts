// Fictional, complete-run test evidence only. Never bound by the production launcher.
import { MIRROR_IDS, type MirrorId, type MirrorRun } from "./mirrorFreshness.ts";
import type { MirrorCompletion, MirrorRunSource } from "./mirrorFreshnessContract.ts";
import type { MirrorPolicyApproval } from "./mirrorFreshnessPolicy.ts";
export const mirrorTestScope = { workspaceId:"synthetic-workspace",accountId:"synthetic-account",environment:"sandbox" as const };
export const mirrorTestNow = Date.parse("2027-02-10T12:00:00Z");
export const mirrorTestApproval: MirrorPolicyApproval = {
  version:"synthetic-policy-v1",decisionRef:"synthetic-owner-decision",ownerRef:"synthetic-owner",
  approvedAt:"2027-02-01T12:00:00Z",timezone:"America/Los_Angeles",
  expectedCadenceMinutes:Object.fromEntries(MIRROR_IDS.map(id=>[id,id==="finance"?1440:15])) as MirrorPolicyApproval["expectedCadenceMinutes"],
  policies:Object.fromEntries(MIRROR_IDS.map(id=>[id,{checkEveryMinutes:15,staleAfterMinutes:id==="finance"?1560:60}])),
};
export const mirrorTestBindings = MIRROR_IDS.map(mirrorId=>({mirrorId,bindingRef:`synthetic-binding-${mirrorId}`,version:"synthetic-binding-v1"}));
export function mirrorTestCompletion(mirrorId:MirrorId="orders", outcome:MirrorRun["outcome"]="complete", at=mirrorTestNow-60_000, changed=1):MirrorCompletion {
  return {scope:mirrorTestScope,bindingRef:`synthetic-binding-${mirrorId}`,bindingVersion:"synthetic-binding-v1",receiptRef:`synthetic-receipt-${mirrorId}-${at}`,
    run:{runId:`synthetic-run-${mirrorId}-${at}`,mirrorId,startedAt:new Date(at-60_000).toISOString(),finishedAt:new Date(at).toISOString(),outcome,
      coverageWatermark:outcome==="complete"?new Date(at).toISOString():null,counts:{rowsRead:3,rowsChanged:outcome==="complete"?changed:null,rowsExpected:3},reasonCode:null},
    coverage:{basis:"fullSnapshot",sourceVersion:"synthetic-source-v1",partitionsExpected:1,partitionsCompleted:outcome==="complete"?1:0,pendingCursor:null,
      mirrorAcknowledged:outcome==="complete",sourceAsOf:outcome==="complete"?new Date(at).toISOString():null}};
}
export function mirrorTestSource() {
  const receipts = new Map<string,MirrorCompletion>();
  const state={current:true};
  const source:MirrorRunSource={readCompletion:async ref=>structuredClone(receipts.get(ref)),assertCurrent:()=>{if(!state.current)throw new Error("SOURCE_REVOKED");}};
  return {source,state,receipts,add:(c:MirrorCompletion)=>{receipts.set(c.receiptRef,c);return c.receiptRef;}};
}
