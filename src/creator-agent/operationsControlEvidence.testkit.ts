import {createOperationsControlHttpFixture} from "./operationsControlHttp.testkit.ts";
import {approvalTestScope as scope} from "./approvals/fixtures.testkit.ts";
import {createRuntimeTestkit,syntheticRuntimeRegistration} from "./jobs/runtime.testkit.ts";
import type {RuntimeAuthority,RuntimeRegistry} from "./jobs/runtimeSchema.ts";
import {createReportingSourceFixture} from "./slackReporting/fixtures.testkit.ts";

/** Positive application-service associations only. All provider sources are fictional; no network effects. */
export async function createOperationsControlEvidenceHttpFixture(){
  const registry:RuntimeRegistry={registrations:new Map(),executors:new Map()};
  const authority=new Proxy({} as RuntimeAuthority,{get(_target,key){
    const value=runtime?.authority[key as keyof RuntimeAuthority];
    if(typeof value!=="function")throw new Error("Synthetic runtime authority is not initialized.");return value;
  }});
  const reporting=createReportingSourceFixture(scope,Date.now());
  const controls=createOperationsControlHttpFixture({runtime:{registry,authority}},{repair:true});controls.refreshClock(reporting.now);
  const base=syntheticRuntimeRegistration(),registration=syntheticRuntimeRegistration({registrationRef:"synthetic-controls-runtime",family:"registered-business",
    cadence:{kind:"event",eventType:"synthetic-controls-event"},definition:{...base.definition,jobId:"synthetic-controls-runtime-job"},
    apiBinding:{...base.apiBinding!,...scope},browserBinding:{...base.browserBinding!,...scope}});
  const runtime=createRuntimeTestkit(controls.app.store.database,{scope,now:()=>controls.a.state.now,registration});
  for(const [id,value]of runtime.registry.registrations)(registry.registrations as Map<string,typeof value>).set(id,value);
  for(const [id,value]of runtime.registry.executors)(registry.executors as Map<string,typeof value>).set(id,value);
  await runtime.initialize();
  const runtimeRun=await controls.app.runtime.fire({registrationRef:registration.registrationRef,registrationVersion:1,intendedAt:controls.a.at(),triggerEventRef:"synthetic-controls-first-window"},runtime.machine);
  // The existing report service is used directly with a source-owned read-only consumer.
  // It is admitted but never delivered: neither native Slack nor a fixture ACK is claimed.
  const {createSlackReporting}=await import("./slackReporting/service.ts");
  const {loadOperationsSecret}=await import("./operationsSecret.ts");
  const service=createSlackReporting({db:controls.app.store.database,scope,secret:loadOperationsSecret(controls.app.store.database,scope),jobs:controls.app.operations.jobs,source:reporting.source,now:()=>controls.a.state.now});
  const queuedReport=await service.accept(reporting.locator,"synthetic-controls-report-admission",reporting.machine);
  // This property is server-only composition, never a client mutation or worker credential.
  controls.app.actionFoundation.reporting=service;
  const runtimeTarget="synthetic-runtime-schedule",reportTarget="synthetic-report-delivery";
  controls.snapshot.reports.push({...structuredClone(controls.snapshot.reports[0]!),id:runtimeTarget,jobId:registration.definition.jobId,title:"Synthetic registered runtime",cadence:"source-event",configuration:"enabled"});
  controls.snapshot.reports.push({...structuredClone(controls.snapshot.reports[0]!),id:reportTarget,jobId:controls.app.operations.jobs.getRun(queuedReport.runRef).jobId,title:"Synthetic admitted internal report",cadence:"source-event",configuration:"paused"});
  controls.snapshot.runMembership.push({id:"synthetic-runtime-membership",runId:runtimeRun.run.runId,platform:"instagram",assignedActorRef:controls.current().personRef,
    sourceVersion:"synthetic-membership-v1",evidenceRef:"synthetic-runtime-window",observedAt:controls.a.at()});
  controls.state.serviceRefs.push({kind:"runtimeRegistration",targetId:runtimeTarget,jobId:registration.definition.jobId,jobVersion:1,registrationRef:registration.registrationRef,registrationVersion:1},
    {kind:"runtimeRun",targetId:runtimeRun.run.runId,runId:runtimeRun.run.runId,registrationRef:registration.registrationRef,registrationVersion:1},
    {kind:"report",targetId:reportTarget,reportRef:queuedReport.reportRef});
  return {controls,runtime,reporting,queuedReport,runtimeRun};
}
