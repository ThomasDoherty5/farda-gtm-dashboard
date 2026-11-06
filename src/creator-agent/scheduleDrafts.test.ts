// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "./store.ts";
import { createOperations } from "./operations.ts";
import { ScheduleDraftRepository } from "./scheduleDrafts.ts";
import { sealOperationsToken } from "./operationsTokens.ts";
import { nextRun } from "./scheduleCadence.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";

const scope = {workspaceId:"synthetic-workspace",accountId:"synthetic-account",environment:"sandbox" as const};
const secret="synthetic-schedule-secret", clock=()=>Date.parse("2027-03-14T06:00:00Z");
const initial = {cadence:"daily" as const,localTime:"02:30",timezone:"America/Los_Angeles" as const,activeCohortOverride:false};
const definition = { jobId:"synthetic-private-schedule",version:1,ownerRef:"synthetic:operator",mode:"observe",handler:"record-reference.v1",
  eventType:"synthetic",inputSchemaVersion:"job-reference-batch.v1",outputSchemaVersion:"job-local-result.v1",policyVersion:POLICY_VERSION,modelVersion:null,offerVersion:null,capabilityBinding:null,
  budgets:{maxItems:1,maxSteps:1,maxAttempts:1,maxRunMs:1000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0} } as const;
const files: string[] = [];
function setup(path = ":memory:") {
  const store = new AgentStore(path,scope), operations = createOperations(store.database,scope,{now:clock});
  const repo = new ScheduleDraftRepository(store.database,scope,secret,clock);
  return {store,operations,repo,close:()=>{operations.close();store.close();}};
}
afterEach(()=>{while(files.length) rmSync(files.pop()!,{recursive:true,force:true});});
describe("native schedule configuration",()=>{
  it("persists draft acknowledgments across restart, isolates the register, and protects a newer job version",()=>{
    const dir=mkdtempSync(join(tmpdir(),"farda-schedule-"));files.push(dir); const path=join(dir,"state.sqlite");
    const ref=sealOperationsToken(scope,secret,"schedule-job",definition.jobId), resource="schedule-"+ref;
    const first=setup(path); first.operations.jobs.register(definition,0);
    expect(first.repo.read(ref)).toMatchObject({draftVersion:"j1-d0",updatedAt:null,preview:null,draft:null,scheduleState:"disabled"});
    const receipt=first.repo.saveFromAdapter(resource,"j1-d0",initial,"first");
    expect(receipt.version).toBe("j1-d1");first.close();
    const second=setup(path);
    try {
      expect(second.repo.read(ref)).toMatchObject({draft:initial,draftVersion:"j1-d1",preview:{at:"2027-03-14T10:00:00.000Z",basis:"proposed-local-time"}});
      expect(second.repo.saveFromAdapter(resource,"j1-d0",initial,"first")).toEqual(receipt);
      expect(second.repo.saveFromAdapter(resource,"j1-d1",initial,"same")).toMatchObject({version:"j1-d1",reasonCodes:["NO_CHANGE"]});
      expect(()=>second.repo.saveFromAdapter(resource,"j1-d0",{...initial,localTime:"04:00"},"first")).toThrow("IDEMPOTENCY_KEY_REUSED");
      second.operations.jobs.register({...definition,version:2},1);
      expect(()=>second.repo.saveFromAdapter(resource,"j1-d1",{...initial,localTime:"04:00"},"outdated")).toThrow("STALE_VERSION");
      expect(second.repo.read(ref)).toMatchObject({draft:initial,savedForJobVersion:1,draftVersion:"j2-d1"});
      expect(second.repo.saveFromAdapter(resource,"j2-d1",initial,"reviewed")).toMatchObject({version:"j2-d2"});
      expect(second.operations.jobs.getJob(definition.jobId).enabled).toBe(false);
      expect(second.repo.read(sealOperationsToken({...scope, accountId:"another"},secret,"schedule-job",definition.jobId))).toBeNull();
      expect(()=>new ScheduleDraftRepository(second.store.database,{...scope,workspaceId:"another"},secret)).toThrow("DATABASE_SCOPE_MISMATCH");
    } finally {second.close();}
  });
  it("rejects invalid settings without changing the job, and honors both daylight-saving policies",()=>{
    const service=setup();try {
      service.operations.jobs.register(definition,0);
      const ref=sealOperationsToken(scope,secret,"schedule-job",definition.jobId);
      for (const change of [{cadence:"hourly"},{localTime:"24:00"},{timezone:"invalid"},{enabled:true},{activeCohortOverride:"yes"}]) {
        expect(()=>service.repo.saveFromAdapter("schedule-"+ref,"j1-d0",{...initial,...change},"bad")).toThrow("VALIDATION_FAILED");
      }
      expect(service.repo.read(ref)?.draft).toBeNull();
      expect(nextRun({...initial,localTime:"01:30"},new Date("2027-11-07T07:00:00Z"))?.at.toISOString()).toBe("2027-11-07T08:30:00.000Z");
      expect(nextRun({...initial,localTime:"01:30"},new Date("2027-11-07T08:45:00Z"))?.at.toISOString()).toBe("2027-11-08T09:30:00.000Z");
      expect(nextRun({...initial,cadence:"weekly-monday",timezone:"UTC"},new Date("2027-03-13T00:00Z"))?.at.toISOString()).toBe("2027-03-15T02:30:00.000Z");
    } finally {service.close();}
  });
});
