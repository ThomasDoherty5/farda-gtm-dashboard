import { digest } from "../config.ts";
import { MonitorError } from "./reader.ts";
import type { MonitorSourceReader } from "./contract.ts";
import { monitorSnapshotSchema,type MonitorSnapshot } from "./contract.ts";
export const monitorScope={workspaceId:"synthetic-workspace",accountId:"synthetic-account",environment:"sandbox" as const};
export const monitorTime=Date.parse("2026-11-06T10:00:00Z");
/** Fictional read-only authority records, used exclusively by tests. */
export function monitorFixture(now=monitorTime):MonitorSnapshot{
  const at=(delta:number)=>new Date(now+delta).toISOString();
  const observation={at:at(-60_000),receipt:"snapshot-evidence-a",definition:"Native lifetime post views",window:"lifetime as observed",
    semantics:"cumulative" as const,context:"organic" as const,views:0,likes:0,comments:0,shares:0,saves:null,reach:null};
  const member={creatorId:"canonical-a",revision:1,network:"instagram" as const,account:"publishing-a",profileId:"profile-a",notionReceipt:"notion-a",
    sheetsReceipt:"sheets-a",cohort:"launch-a",verification:{identityReceipt:"identity-a",suppressionReceipt:"suppression-a",sheetsCanonicalReceipt:"notion-a"}};
  return monitorSnapshotSchema.parse({scope:monitorScope,version:"source-version-1",observedAt:at(0),validUntil:at(3600_000),evidenceStage:"synthetic",coverage:"complete",members:[member],
    posts:[{network:"instagram",account:"publishing-a",postId:"EXAMPLE_A",creatorId:"canonical-a",campaign:"campaign-a",campaignReceipt:"campaign-a-proof",collaborationId:"collaboration-a",
      creativeId:"creative-a",deliverableId:"deliverable-a",enrollmentSource:"social-cat",publishedAt:at(-86400_000),publicationReceipt:"native-publication-a",
      originalUrl:"https://www.instagram.com/reel/EXAMPLE_A/",visibility:"public",visibilityReceipt:"visibility-a",visibilityAt:at(-60_000),access:"authorized",checkpointHours:24,
      measurements:[observation],attribution:{level:"post",window:"observed checkout window",version:"attr-v1",receipt:"reconciled-zero",complete:true,orders:0,
        net:{minorUnits:0,currency:"USD"},gmv:null,gmvDefinition:null}},
      {network:"tiktok",account:"publishing-b",postId:"883311",creatorId:"canonical-b",campaign:"campaign-a",campaignReceipt:"campaign-b-proof",collaborationId:null,creativeId:"creative-a",
        deliverableId:"deliverable-b",enrollmentSource:"tiktok-affiliate",publishedAt:at(-2*86400_000),publicationReceipt:"native-publication-b",
        originalUrl:null,visibility:"inaccessible",visibilityReceipt:null,visibilityAt:null,access:"loginRequired",checkpointHours:48,measurements:[],
        attribution:{level:"creator",window:"observed checkout window",version:"attr-v1",receipt:"creator-wide",complete:true,orders:2,net:{minorUnits:5040,currency:"USD"},
          gmv:{minorUnits:7000,currency:"USD"},gmvDefinition:"Native shop value before discounts/refunds"}}],
    runs:[{id:"hourly-a",observedAt:at(-30_000),receipt:"run-a",snapshotSize:2,complete:true,timezone:"America/Los_Angeles",schedule:"disabled",nextRun:null,
      retryPolicy:"Resume an authorized failed read from its checkpoint.",jobId:null,
      checks:[{creatorId:"canonical-a",network:"instagram",account:"publishing-a",profileId:"profile-a",state:"unchanged",access:"authorized",at:at(-60_000),
        lastSuccessAt:at(-60_000),receipt:"check-a",checkpoint:"checkpoint-a",owner:null,reason:null},
        {creatorId:"canonical-b",network:"tiktok",account:"publishing-b",profileId:"profile-b",state:"failed",access:"loginRequired",at:at(-60_000),
          lastSuccessAt:at(-86400_000),receipt:"check-b",checkpoint:"checkpoint-b",owner:"source-owner",reason:"Source sign-in requires review."}],
      inbox:[]}]});
}
export function intakeFixture(){
  return {total:2,complete:true,records:["a","b"].map((id,i)=>({creatorId:"canonical-"+id,revision:1,identityState:"resolved" as const,
    watchlistEligibility:i?"excluded" as const:"active" as const,suppressed:!!i,
    profiles:[{network:i?"tiktok" as const:"instagram" as const,accountId:"publishing-"+id,sourceId:"profile-"+id,handle:"test."+id}],
    relationships:[{recruitmentSource:i?"tiktok-shop":"social-cat",state:"active",campaignKey:"campaign-a"}],
    handoffs:[{target:"notion-creator-crm",key:"n-"+id,state:"confirmed",receiptRef:"notion-"+id,revision:1,canonicalReceiptRef:null},
      {target:"sheets-watchlist",key:"s-"+id,state:"confirmed",receiptRef:"sheets-"+id,revision:1,canonicalReceiptRef:"notion-"+id}],
    sourceStatus:"verified" as const}))};
}

/** Optional read-only control evidence with no message body or external destination. */
export function addMonitorReviewEvidence(snapshot:MonitorSnapshot){
  const m=snapshot.members[0]!,at=snapshot.runs[0]!.checks[0]!.at!;
  snapshot.reviewEvidence=[{creatorId:m.creatorId,revision:m.revision,network:m.network,account:m.account,profileId:m.profileId,
    access:"authorized",observedAt:at,receipt:"synthetic-review-packet",historyComplete:true,
    history:[{id:"synthetic-intake-event",at,kind:"identity",decision:"quarantined",receipt:"synthetic-original-receipt",
      identityEvidence:["synthetic-original-profile-proof"],decisionReceipt:"synthetic-decision-receipt"}],
    candidates:[{creatorId:m.creatorId,network:m.network,account:m.account,profileId:m.profileId,receipt:"synthetic-candidate-a"},
      {creatorId:"synthetic-competing-creator",network:m.network,account:m.account,profileId:"synthetic-competing-profile",receipt:"synthetic-candidate-b"}],exclusion:null}];
  snapshot.runs[0]!.inbox=[{id:"synthetic-message-event",creatorId:m.creatorId,network:m.network,account:m.account,profileId:m.profileId,
    at,receipt:"synthetic-message-receipt",kind:"statusChange",interpretation:"suggestion",context:{access:"authorized",observedAt:at,conversationId:"synthetic-conversation",
      messageId:"synthetic-message",sourceVersion:"synthetic-message-v1",currentStatus:"draft",proposedStatus:"ready",expectedVersion:"synthetic-status-v1"}}];
  return snapshot;
}

/** Explicit fictional current-grant owner; never used by production source composition. */
export function monitorTestSource(current:()=>MonitorSnapshot|null,now:()=>number=Date.now,beforeRead?:()=>void|Promise<void>):MonitorSourceReader {
  return {async read(binding){await beforeRead?.();const snapshot=structuredClone(current()),time=now();return {snapshot,authority:{binding:structuredClone(binding),
    sourceVersion:snapshot?.version??null,permissionVersion:"fictional-monitor-permission-v1",observedAt:new Date(time).toISOString(),validUntil:new Date(time+15*60_000).toISOString()}};},
    assertCurrent(result,binding){if(result.authority.permissionVersion!=="fictional-monitor-permission-v1"||digest(result.authority.binding)!==digest(binding)||digest(result.snapshot)!==digest(current()))throw new MonitorError("MONITOR_SOURCE_CHANGED",409);}};
}
