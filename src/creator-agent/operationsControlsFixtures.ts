import type { OperationsControlSnapshot } from "./operationsControlsSchema.ts";
import type { JobDefinition } from "./jobs/schema.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import {digest} from "./config.ts";
import {OperationsControlError,type OperationsControlSource,type OperationsReadBinding,type OperationsSourceResult} from "./operationsControls.ts";
export const controlTestScope={workspaceId:"synthetic-controls-workspace",accountId:"synthetic-controls-account",environment:"sandbox" as const};
export const controlTestTime="2026-11-06T12:00:00.000Z";
/** Fictional source grant, independent of stale data and canonical action authority. */
export function controlSourceProvider(current:()=>OperationsControlSnapshot,now:()=>number,permitted:()=>boolean=()=>true):OperationsControlSource{
  const packet=(binding:OperationsReadBinding):OperationsSourceResult=>{if(!permitted())throw new OperationsControlError("SOURCE_SCOPE_DENIED",403);
    const snapshot=structuredClone(current()),at=now();return {snapshot,authority:{binding:structuredClone(binding),sourceVersion:snapshot.revision,
      permissionVersion:"synthetic-control-access-v1",observedAt:new Date(at).toISOString(),validUntil:new Date(at+60_000).toISOString()}};};
  return {read:async binding=>packet(binding),assertCurrent(result,binding){
    const live=packet(binding);if(result.authority.permissionVersion!==live.authority.permissionVersion||digest(result.snapshot)!==digest(live.snapshot))throw new OperationsControlError("SOURCE_CHANGED",409);
  }};
}
export const controlTestJob:JobDefinition={jobId:"synthetic-controls-job",version:1,ownerRef:"owner:synthetic",mode:"propose",handler:"draft-reference.v1",
  eventType:"synthetic-control-event",inputSchemaVersion:"job-reference-batch.v1",outputSchemaVersion:"job-local-result.v1",policyVersion:POLICY_VERSION,
  capabilityBinding:null,modelVersion:null,offerVersion:null,budgets:{maxItems:5,maxSteps:20,maxAttempts:2,maxRunMs:10000,leaseMs:5000,maxConcurrency:1,retryBaseMs:0}};
export function controlSourceFixture(scope=controlTestScope):OperationsControlSnapshot{
  const proof={sourceVersion:"synthetic-source-v1",evidenceRef:"evidence:synthetic",observedAt:controlTestTime};
  return {scope,revision:"synthetic-v1",observedAt:controlTestTime,coverage:"complete",
    roles:[{id:"role:synthetic",provider:"Synthetic provider",account:"Synthetic account",role:null,ownerRef:null,backupRef:null,...proof}],
    tasks:[{id:"task:synthetic",title:"Synthetic finite review",jobId:controlTestJob.jobId,jobVersion:1,category:"daily-review",permission:"allowed",ownerRef:"owner:synthetic",...proof,
      items:[{itemKey:"item:synthetic",subjectRef:"subject:synthetic",evidenceRef:"evidence:synthetic"}]}],
    runMembership:[],takeovers:[],permissions:[],comparisons:[{id:"comparison:synthetic",label:"Synthetic order mirror",grain:"order",period:{startAt:"2026-11-05T00:00:00Z",endAt:controlTestTime,timezone:"UTC"},
      currency:"USD",sourceCount:2,mirrorCount:1,sourceAmount:{minorUnits:2500,currency:"USD"},mirrorAmount:{minorUnits:1500,currency:"USD"},coverage:"complete",cutoff:controlTestTime,...proof}],
    conflicts:[{id:"conflict:synthetic",comparisonId:"comparison:synthetic",category:"amount",field:"net-sales",ownership:"source",sourceValue:{kind:"money",minorUnits:2500,currency:"USD"},mirrorValue:{kind:"money",minorUnits:1500,currency:"USD"},
      authoritativeVersion:"source-v1",mirrorVersion:"mirror-v1",ownershipVersion:"ownership-v1",repairAllowed:true,state:"open",receiptRef:null,...proof}],
    reports:[{id:"report:synthetic",jobId:controlTestJob.jobId,title:"Synthetic daily report",category:"report",cadence:"weekdays",timezone:"America/Los_Angeles",configuration:"draft",
      ownerRef:null,destination:null,lastCompleteAt:null,nextRunAt:null,preview:[],history:[],...proof}],
    attribution:[{id:"attribution:synthetic",title:"Synthetic refund test",account:"Synthetic account",expected:"refund-reversal",observed:null,state:"notRun",...proof}],handoffs:[]};
}
