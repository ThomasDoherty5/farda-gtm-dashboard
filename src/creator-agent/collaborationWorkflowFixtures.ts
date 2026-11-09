/** Synthetic registry snapshots used only by collaboration workflow tests. */
import type { CollaborationSourceSnapshot, CollaborationSourceReader, WorkflowIntent } from "./collaborationWorkflowSchema.ts";
import { digest } from "./config.ts";
import { CollaborationWorkflowError } from "./collaborationWorkflow.ts";
/** Explicit fictional current-grant owner; a null fixture is an authoritative exact lookup. */
export function collaborationTestSource(current:(id:string)=>CollaborationSourceSnapshot|null,now:()=>number=()=>Date.parse(collabTestAt),beforeRead?:()=>void|Promise<void>):CollaborationSourceReader {
  return {async read(binding){await beforeRead?.();const snapshot=structuredClone(current(binding.collaborationId)),time=now();return {snapshot,absence:"verified",authority:{binding:structuredClone(binding),
    sourceVersion:snapshot?.sourceRevision??null,permissionVersion:"fictional-collaboration-permission-v1",observedAt:new Date(time).toISOString(),validUntil:new Date(time+15*60_000).toISOString()}};},
    assertCurrent(result,binding){if(result.authority.permissionVersion!=="fictional-collaboration-permission-v1"||digest(result.authority.binding)!==digest(binding)||digest(result.snapshot)!==digest(current(binding.collaborationId)))throw new CollaborationWorkflowError("COLLABORATION_SOURCE_CHANGED",409);}};
}
export const collabTestScope={workspaceId:"synthetic-workspace",accountId:"synthetic-account",environment:"sandbox" as const};
export const collabTestAt="2026-11-06T18:00:00.000Z";
export const collabTestId="synthetic-collaboration";
export function collaborationSnapshot():CollaborationSourceSnapshot{
  const unknown={state:"unknown" as const,receiptRef:null};
  return {scope:collabTestScope,id:collabTestId,sourceRevision:"synthetic-registry-v1",sourceRef:"synthetic-registry",observedAt:collabTestAt,coverage:"complete",
    title:"Synthetic creator agreement",platform:"Social Cat",creatorRef:"synthetic-creator",campaignRef:"synthetic-campaign",stage:"Creating",
    nextAction:"Review the submitted revision",terms:{kind:"Historical agreement",agreementRef:"synthetic-terms-receipt",acceptedAt:"2026-10-16",version:"terms-v2",
      brief:"A product demonstration",usage:"Organic only",posting:"committed",due:"2026-10-26",graceDays:2,observationUntil:null,timezone:"America/Los_Angeles",
      retainedSampleCost:{minorUnits:1200,currency:"USD"},historicalFee:{minorUnits:5000,currency:"USD"}},
    sample:{state:"Delivered",observedAt:"2026-10-18",sourceRef:"synthetic-sample-receipt"},suppression:{state:"clear",sourceRef:"synthetic-suppression"},
    history:[{label:"Terms accepted",at:"2026-10-16",sourceRef:"synthetic-terms-receipt"}],deliverables:[{ref:"synthetic-deliverable",revision:"content-v2",
      title:"Product demo",stage:"Review",brief:"A product demonstration",blocker:"Awaiting revision",submissionVersion:"submission-v2",
      revisions:[{label:"Earlier version received",at:"2026-10-19",sourceRef:"synthetic-submission-v1"}],review:unknown,rights:unknown,publishPermission:unknown,
      publisher:"Creator",plannedSlot:"2026-11-07T20:00:00Z",publication:{state:"planned",nativeReceiptRef:null,nativePostRef:null,confirmedSlot:null,publishedAt:null,
        observedAt:null,visibility:"unknown"},nextAction:"Review draft",sourceRef:"synthetic-material"}]};
}
export function collaborationAction(version:string,intent:Partial<WorkflowIntent>={},key="synthetic-request"){
  return {operation:"requestApproval",actionKind:"proposeCollaborationReview",entityRefs:[],approvalRef:null,manifestRef:null,
    expectedVersion:version,idempotencyKey:key,requestedScope:{workspaceId:collabTestScope.workspaceId,accountIds:[collabTestScope.accountId],environment:"sandbox"},
    payload:{collaborationRef:collabTestId,kind:"review",reason:"Review the source evidence",...intent}};
}
