import { z } from "zod";
import { analyticsPeriodSchemaNative } from "../analytics/contract.ts";

const ref = z.string().trim().min(1).max(240);
const text = z.string().trim().min(1).max(1000);
const instant = z.string().datetime({offset:true}).refine(t => Number.isFinite(Date.parse(t)));
const count = z.number().int().nonnegative().safe();
const network = z.enum(["instagram","tiktok"]);
const id = z.object({network,account:ref,postId:ref}).strict();
const publicationState = z.enum(["public","private","deleted","expired","inaccessible","unverified"]);
const visibilityHistory=z.object({state:publicationState,at:instant,receipt:ref}).strict();
const acquisition=z.enum(["social-cat","tiktok-affiliate","other","unknown"]);
const context = z.enum(["organic","paid","mixed","unknown"]);
const money = z.object({minorUnits:z.number().int().safe(),currency:z.string().regex(/^[A-Z]{3}$/)}).strict();
const observation = z.object({at:instant,receipt:ref,definition:text,window:text,reportingPeriod:analyticsPeriodSchemaNative.optional(),
  semantics:z.enum(["cumulative","interval","unknown"]),context,views:count.nullable(),likes:count.nullable(),comments:count.nullable(),shares:count.nullable(),
  saves:count.nullable(),reach:count.nullable()}).strict();
const access = z.enum(["authorized","denied","loginRequired","throttled","unavailable","unknown"]);
const checkState = z.enum(["changed","unchanged","skipped","failed","deferred","unknown"]);
const sourceScope=z.object({workspaceId:ref,accountId:ref,environment:z.literal("sandbox")}).strict();
const historyEntry=z.object({id:ref,at:instant,kind:z.enum(["signup","identity","enrollment","exclusion"]),
  decision:z.enum(["pending","resolved","quarantined","enrolled","excluded"]),receipt:ref,
  identityEvidence:z.array(ref).min(1).max(10),decisionReceipt:ref}).strict();
const candidate=z.object({creatorId:ref,network,account:ref,profileId:ref,receipt:ref}).strict();
const exclusion=z.object({at:instant,reasonCode:z.enum(["suppressed","closed","manual-review"]),owner:ref,receipt:ref}).strict();
const reviewEvidence=z.object({creatorId:ref,revision:count,network,account:ref,profileId:ref,access,observedAt:instant,receipt:ref,
  historyComplete:z.boolean(),history:z.array(historyEntry).max(50),candidates:z.array(candidate).max(10),exclusion:exclusion.nullable()}).strict();
const sourceStatus=z.enum(["unknown","draft","ready","published","received","closed"]);
const messageEvidence=z.object({access,observedAt:instant,conversationId:ref,messageId:ref,sourceVersion:ref,
  currentStatus:sourceStatus.nullable(),proposedStatus:sourceStatus.nullable(),expectedVersion:ref.nullable()}).strict();
const member=z.object({creatorId:ref,revision:count,network,account:ref,profileId:ref,notionReceipt:ref,sheetsReceipt:ref,cohort:ref.nullable(),
  // Independently verified J01 link/suppression receipt only when supplied by the trusted Sheets/Notion source owner.
  verification:z.object({identityReceipt:ref,suppressionReceipt:ref,sheetsCanonicalReceipt:ref}).strict().optional()}).strict();
const check=z.object({creatorId:ref,network,account:ref,profileId:ref,state:checkState,access,at:instant.nullable(),lastSuccessAt:instant.nullable(),
  receipt:ref.nullable(),checkpoint:ref.nullable(),owner:ref.nullable(),reason:text.nullable()}).strict();
const inbox=z.object({id:ref,creatorId:ref,network,account:ref,profileId:ref,at:instant,receipt:ref,kind:z.enum(["reply","statusChange","post"]),
  interpretation:z.enum(["observed","suggestion"]),context:messageEvidence.optional()}).strict();
const run=z.object({id:ref,observedAt:instant,receipt:ref,snapshotSize:count,complete:z.boolean(),timezone:ref.nullable(),
  schedule:z.enum(["enabled","paused","disabled","unknown"]),nextRun:instant.nullable(),retryPolicy:text.nullable(),jobId:ref.nullable(),
  checks:z.array(check).max(2000),inbox:z.array(inbox).max(2000)}).strict().superRefine((run,ctx)=>{
    const keys=run.checks.map(c=>JSON.stringify([c.network,c.account,c.profileId]));
    if(new Set(keys).size!==keys.length || run.checks.length>run.snapshotSize || run.complete && run.checks.length!==run.snapshotSize)
      ctx.addIssue({code:"custom",message:"Run profile coverage must reconcile against one finite snapshot."});
    if(run.schedule!=="enabled" && run.nextRun!==null)ctx.addIssue({code:"custom",message:"A disabled or unverified schedule has no next run."});
    if(new Set(run.inbox.map(m=>JSON.stringify([m.network,m.account,m.id]))).size!==run.inbox.length)
      ctx.addIssue({code:"custom",message:"Inbox/status observations must have distinct source identities."});
    for(const item of run.checks) if(item.at && Date.parse(item.at)>Date.parse(run.observedAt) ||
      item.lastSuccessAt && Date.parse(item.lastSuccessAt)>Date.parse(run.observedAt) ||
      ["changed","unchanged"].includes(item.state) && (!item.receipt || !item.at || item.access!=="authorized"))
      ctx.addIssue({code:"custom",message:"A successful profile check requires current dated source evidence."});
    const checked=new Set(run.checks.filter(c=>c.state==="changed" || c.state==="unchanged").map(c=>JSON.stringify([c.creatorId,c.network,c.account,c.profileId])));
    for(const event of run.inbox) if(Date.parse(event.at)>Date.parse(run.observedAt) || event.context && (Date.parse(event.context.observedAt)>Date.parse(run.observedAt) || Date.parse(event.context.observedAt)<Date.parse(event.at)) ||
      !checked.has(JSON.stringify([event.creatorId,event.network,event.account,event.profileId])))
      ctx.addIssue({code:"custom",message:"An observation must belong to a checked profile in this run."});
  });
const attribution=z.object({level:z.enum(["post","creator","campaign","unknown"]),receipt:ref,window:text,version:ref,complete:z.boolean(),reportingPeriod:analyticsPeriodSchemaNative.optional(),
  orders:count.nullable(),net:money.nullable(),gmv:money.nullable(),gmvDefinition:text.nullable()}).strict();
const post=id.extend({creatorId:ref,campaign:ref,campaignReceipt:ref,collaborationId:ref.nullable(),creativeId:ref.nullable(),deliverableId:ref.nullable(),
  enrollmentSource:acquisition,publishedAt:instant.nullable(),publicationReceipt:ref,originalUrl:z.string().url().max(1000).nullable(),
  visibility:publicationState,visibilityReceipt:ref.nullable(),visibilityAt:instant.nullable(),access,checkpointHours:count.nullable(),
  publicationHistory:z.array(visibilityHistory).max(100).optional(),measurements:z.array(observation).max(100),attribution:attribution.nullable()}).strict().superRefine((p,ctx)=>{
    if(!["unverified","inaccessible"].includes(p.visibility) && (!p.visibilityReceipt || !p.visibilityAt))
      ctx.addIssue({code:"custom",message:"Confirmed visibility requires its dated native receipt."});
    if(p.attribution?.gmv && (p.network!=="tiktok" || !p.attribution.gmvDefinition))
      ctx.addIssue({code:"custom",message:"Native GMV requires a TikTok source definition."});
    if(p.publishedAt && p.measurements.some(m=>Date.parse(m.at)<Date.parse(p.publishedAt!)))ctx.addIssue({code:"custom",message:"Measurements cannot predate publication."});
    if(p.originalUrl && !originalPostUrl(p.network,p.postId,p.originalUrl))ctx.addIssue({code:"custom",message:"Original URL must match the exact native post and network."});
  });
export function originalPostUrl(network:"instagram"|"tiktok",postId:string,input:string):string|null {
  let u:URL;try {u=new URL(input);} catch {return null;}
  if(u.protocol!=="https:"||u.username||u.password||u.port)return null;
  const host=u.hostname.replace(/^www\./,"");
  const id=network==="instagram" && host==="instagram.com" ? /^\/(?:p|reels?|tv)\/([\w-]+)\/?$/.exec(u.pathname)?.[1] :
    network==="tiktok" && ["tiktok.com","m.tiktok.com"].includes(host) ? /^\/@[\w.]+\/video\/(\d+)\/?$/.exec(u.pathname)?.[1] : null;
  return id===postId ? u.origin+u.pathname : null;
}
/** Only a trusted server-side J08/Sheets reader supplies this packet; there is no browser write or ingestion endpoint. */
export const monitorSnapshotSchema=z.object({scope:sourceScope,version:ref,observedAt:instant,validUntil:instant,evidenceStage:z.enum(["synthetic","source"]).optional(),
  coverage:z.enum(["complete","partial"]),reviewEvidence:z.array(reviewEvidence).max(2000).optional(),members:z.array(member).max(2000),posts:z.array(post).max(2000),runs:z.array(run).max(100)}).strict().superRefine((s,ctx)=>{
    const unique=(rows:string[])=>new Set(rows).size===rows.length;
    const reviewKey=(r:{creatorId:string;revision:number;network:string;account:string;profileId:string})=>JSON.stringify([r.creatorId,r.revision,r.network,r.account,r.profileId]);
    if(!unique((s.reviewEvidence??[]).map(reviewKey)))ctx.addIssue({code:"custom",message:"Duplicate profile review evidence."});
    const sourceEvents=new Map<string,string>();
    for(const event of s.runs.flatMap(run=>run.inbox)){
      const key=JSON.stringify([event.network,event.account,event.id]),facts=JSON.stringify(event),prior=sourceEvents.get(key);
      if(prior!==undefined&&prior!==facts)ctx.addIssue({code:"custom",message:"Conflicting repeated source event evidence requires reconciliation."});
      sourceEvents.set(key,facts);
    }
    for(const r of s.reviewEvidence??[]){
      if(s.members.filter(m=>reviewKey(m)===reviewKey(r)).length!==1 || Date.parse(r.observedAt)>Date.parse(s.observedAt) ||
        r.history.some(h=>Date.parse(h.at)>Date.parse(r.observedAt)) || r.exclusion && Date.parse(r.exclusion.at)>Date.parse(r.observedAt) ||
        r.candidates.some(c=>c.network!==r.network || c.account!==r.account) || !unique(r.history.map(h=>h.id)) ||
        !unique(r.candidates.map(c=>JSON.stringify([c.creatorId,c.profileId]))))
        ctx.addIssue({code:"custom",message:"Review evidence must match one exact member and dated, same-account source facts."});
    }
    if(Date.parse(s.validUntil)<=Date.parse(s.observedAt) || s.runs.some(r=>Date.parse(r.observedAt)>Date.parse(s.observedAt)) ||
      s.posts.some(p=>p.publishedAt && Date.parse(p.publishedAt)>Date.parse(s.observedAt) || p.visibilityAt && Date.parse(p.visibilityAt)>Date.parse(s.observedAt) ||
        p.publicationHistory?.some(h=>Date.parse(h.at)>Date.parse(s.observedAt)||p.publishedAt && Date.parse(h.at)<Date.parse(p.publishedAt)) ||
        p.measurements.some(m=>Date.parse(m.at)>Date.parse(s.observedAt)||m.reportingPeriod&&Date.parse(m.reportingPeriod.endAt)>Date.parse(m.at)) ||
        p.attribution?.reportingPeriod&&Date.parse(p.attribution.reportingPeriod.endAt)>Date.parse(s.observedAt)))ctx.addIssue({code:"custom",message:"Source times must fit the observation window."});
    if(!unique(s.posts.map(p=>JSON.stringify([p.network,p.account,p.postId]))) || !unique(s.runs.map(r=>r.id)))
      ctx.addIssue({code:"custom",message:"Publication and run identities must be unique."});
  });
export type MonitorSnapshot=z.infer<typeof monitorSnapshotSchema>;
export const monitorReadBindingSchema=z.object({scope:sourceScope,principalRef:z.enum(["agent-reader","agent-reviewer"]),
  viewKey:z.enum(["contentMonitor","watchlist","hourlyRun","postPerformance"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const monitorSourceResultSchema=z.object({snapshot:monitorSnapshotSchema.nullable(),authority:z.object({binding:monitorReadBindingSchema,
  sourceVersion:ref.nullable(),permissionVersion:ref,observedAt:instant,validUntil:instant}).strict()}).strict();
export type MonitorReadBinding=z.infer<typeof monitorReadBindingSchema>;
export type MonitorSourceResult=z.infer<typeof monitorSourceResultSchema>;
export type MonitorSourceReader={read(binding:MonitorReadBinding,signal?:AbortSignal):Promise<unknown>;
  assertCurrent(result:MonitorSourceResult,binding:MonitorReadBinding,now:number):void};
export const monitorViewKeys=["contentMonitor","watchlist","hourlyRun","postPerformance"] as const;
export type MonitorViewKey=typeof monitorViewKeys[number];
const sourceFilter=z.enum(["all","social-cat","tiktok-affiliate"]);
export const monitorFilters={
  contentMonitor:z.object({source:sourceFilter.default("all"),network:z.enum(["all","instagram","tiktok"]).default("all"),
    window:z.enum(["last-30","last-7"]).default("last-30"),q:z.string().max(80).default(""),
    campaign: z.string().regex(/^campaign-[a-f0-9]{24}$/).optional(), reportingPeriod: analyticsPeriodSchemaNative.optional() }).strict(),
  watchlist:z.object({source:sourceFilter.default("all"),state:z.enum(["all","active","identity-review","excluded"]).default("all"),
    cohort:z.enum(["all","launch-a"]).default("all")}).strict(),hourlyRun:z.object({runId:ref}).strict(),postPerformance:z.object({postId:ref}).strict(),
};

const meta=z.object({observedAt:instant,synthetic:z.boolean().nullable().optional(),readAccess:z.object({validUntil:instant}).strict().nullable().optional(),sourceState:z.enum(["current","partial","expired","unconfigured","unavailable"]),sourceAsOf:instant.nullable(),
  sourceVersion:ref.nullable(),latestRunRef:ref.nullable(),membershipComplete:z.boolean()}).strict();
const outputObservation=observation;
const outputPost=z.object({id:ref,creator:ref,network,enrollmentSource:acquisition,originalUrl:z.string().url().nullable(),
  account:ref,campaign:ref,campaignReceipt:ref,collaborationRef:ref.nullable(),creative:ref.nullable(),deliverable:ref.nullable(),publishedAt:instant.nullable(),publicationReceipt:ref,
  visibility:publicationState,visibilityReceipt:ref.nullable(),visibilityAt:instant.nullable(),access,checkpointHours:count.nullable(),
  measurement:outputObservation.nullable(),attribution:attribution.nullable(),conflict:z.boolean()}).strict();
const reviewState=z.enum(["current","expired","quarantined","denied","loginRequired","throttled","unavailable","unknown"]);
const outputReview=z.object({state:reviewState,observedAt:instant.nullable(),receipt:ref.nullable(),historyComplete:z.boolean(),
  history:z.array(historyEntry).max(50),candidates:z.array(candidate).max(10),exclusion:exclusion.nullable()}).strict();
const outputMessage=z.object({id:ref,network,account:ref,profile:ref,at:instant,receipt:ref,kind:inbox.shape.kind,interpretation:inbox.shape.interpretation,
  detail:z.object({state:reviewState,observedAt:instant.nullable(),conversationId:ref.nullable(),messageId:ref.nullable(),sourceVersion:ref.nullable(),
    currentStatus:sourceStatus.nullable(),proposedStatus:sourceStatus.nullable(),expectedVersion:ref.nullable()}).strict().optional()}).strict();
const outputMember=z.object({creator:ref,network:network.nullable(),account:ref.nullable(),profile:ref.nullable(),handle:ref.nullable(),
  state:z.enum(["active","identity-review","excluded","eligibility-unverified"]),source:ref.nullable(),cohort:ref.nullable(),notionReceipt:ref.nullable(),
  sheetsReceipt:ref.nullable(),lastCheck:instant.nullable(),reason:text,review:outputReview.optional(),messages:z.array(outputMessage).max(100).optional()}).strict();
const outputCheck=z.object({profile:ref,network,state:checkState,access,at:instant.nullable(),lastSuccessAt:instant.nullable(),receipt:ref.nullable(),
  checkpoint:ref.nullable(),owner:ref.nullable(),reason:text.nullable()}).strict();
export const nativeContentSchema=meta.extend({kind:z.literal("saved-content-monitor"),posts:z.array(outputPost),total:count,
  views:count.nullable(),rate:z.number().finite().nonnegative().nullable(),orders:count.nullable(),net:money.nullable(),window:ref,
  selection:z.object({campaign:ref.nullable(),period:analyticsPeriodSchemaNative.nullable()}).strict().optional(),
  liveCount:count.nullable().optional(),
  networkCoverage:z.array(z.object({network,posts:count,measurable:count,live:count,complete:z.boolean()}).strict()).max(2).optional(),
  metricBasis:z.object({definition:text,window:text,semantics:z.enum(["cumulative","interval"]),context:z.enum(["organic","paid","mixed"])}).strict().nullable()});
export const nativeWatchlistSchema=meta.extend({kind:z.literal("saved-monitor-watchlist"),profiles:z.array(outputMember),total:count,
  active:count,pending:count,pendingReviewTotal:count.optional(),excluded:count,unverified:count});
export const nativeRunSchema=meta.extend({kind:z.literal("saved-monitor-run"),runId:ref,runAt:instant,runReceipt:ref,snapshotSize:count,
  complete:z.boolean(),checks:z.array(outputCheck),counts:z.object({changed:count,unchanged:count,skipped:count,failed:count,deferred:count,unknown:count}).strict(),timezone:ref.nullable(),
  schedule:z.enum(["enabled","paused","disabled","unknown"]),nextRun:instant.nullable(),retryPolicy:text.nullable(),
  observations:z.array(outputMessage)});
export const nativePostSchema=meta.extend({kind:z.literal("saved-monitor-post"),post:outputPost,history:z.array(outputObservation),publicationHistory:z.array(visibilityHistory)});
export type NativeContent=z.infer<typeof nativeContentSchema>;
export type NativeWatchlist=z.infer<typeof nativeWatchlistSchema>;
export type NativeRun=z.infer<typeof nativeRunSchema>;
export type NativePost=z.infer<typeof nativePostSchema>;
