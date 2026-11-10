// @vitest-environment node
import {afterEach,describe,expect,it} from "vitest";
import {createOperationsControlEvidenceHttpFixture} from "./operationsControlEvidence.testkit.ts";
import {SYNTHETIC_REVIEW_TOKEN} from "./testFixtures.ts";
const closes:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
  const world=await createOperationsControlEvidenceHttpFixture(),f=world.controls;closes.push(f.close);
  await new Promise<void>((resolve,reject)=>{f.app.server.once("error",reject);f.app.server.listen(0,"127.0.0.1",resolve);});
  const address=f.app.server.address();if(!address||typeof address==="string")throw new Error("No local test address");
  const read=async(section:string)=>{const response=await fetch(`http://127.0.0.1:${address.port}/v1/read`,{method:"POST",headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN,"content-type":"application/json"},body:JSON.stringify(f.readRequest(section))});return {status:response.status,body:await response.json()};};
  return {...world,read};
}
describe("controls compose actual named runtime/report services without worker authority",()=>{
  it("projects registered source windows, admitted report holds and the original runtime run with zero provider calls",async()=>{
    const f=await fixture(),reports=await f.read("reports");expect(reports.status).toBe(200);
    expect(reports.body.data.serviceEvidence).toEqual([
      expect.objectContaining({kind:"runtimeRegistration",data:expect.objectContaining({kind:"registered-runtime",version:1,coverage:expect.objectContaining({returned:1})})}),
      expect.objectContaining({kind:"report",data:expect.objectContaining({reportRef:f.queuedReport.reportRef,executionCertainty:"notApplied",receipt:null,grantsBusinessAuthority:false})}),
    ]);
    const runs=await f.read("runs");expect(runs.status).toBe(200);expect(runs.body.data.serviceEvidence[0]).toMatchObject({kind:"runtimeRun",data:{kind:"registered-runtime-run",registrationVersion:1}});
    expect(JSON.stringify(reports.body)).not.toContain("synthetic-provider-account");expect(f.runtime.state.sourceCalls).toBe(0);expect(f.reporting.state.calls).toHaveLength(0);
  });
  it("requires exact source job/version associations rather than substituting a nearby registration",async()=>{
    const f=await fixture(),reference=f.controls.state.serviceRefs.find(row=>row.kind==="runtimeRegistration")!;
    if(reference.kind!=="runtimeRegistration")throw new Error("Missing test registration association");reference.jobVersion=2;
    const result=await f.read("reports");expect(result).toMatchObject({status:409,body:{code:"OPERATIONS_SERVICE_BINDING_CHANGED"}});expect(result.body).not.toHaveProperty("data");
  });
  it("does not emit protected mixed-service output after runtime or report authority is withdrawn",async()=>{
    const f=await fixture();f.runtime.state.denied=true;
    expect(await f.read("reports")).toMatchObject({status:403});f.runtime.state.denied=false;f.reporting.state.readAllowed=false;
    const denied=await f.read("reports");expect(denied.status).toBe(403);expect(denied.body).not.toHaveProperty("data");expect(f.reporting.state.calls).toHaveLength(0);
  });
  it("rechecks the original runtime observation after a later report-source await changes window membership",async()=>{
    const f=await fixture();f.reporting.state.beforeRead=async()=>{
      await f.controls.app.runtime.fire({registrationRef:f.runtime.registration.registrationRef,registrationVersion:1,intendedAt:f.controls.a.at(),triggerEventRef:"synthetic-later-source-window"},f.runtime.machine);
    };
    const result=await f.read("reports");expect(result.status).toBe(409);expect(result.body).not.toHaveProperty("data");expect(f.reporting.state.calls).toHaveLength(0);
  });
});
