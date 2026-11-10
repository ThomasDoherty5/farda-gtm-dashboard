// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { createAgentServer } from "./server.ts";
import { bulkServerFixture } from "./bulk/serverFixture.testkit.ts";
import { SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { nativeBulkViewSchema } from "./bulk/views.ts";

it("real authenticated bulk reads retain all finite rows, redact native references and fail closed on current authority changes",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"bulk-http-")),w=bulkServerFixture(join(dir,"db.sqlite")),app=createAgentServer(w.options);
  try{
    await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));const address=app.server.address();if(!address||typeof address==="string")throw new Error("No fixture address");
    const base=`http://127.0.0.1:${address.port}`;
    const body={schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:"fictional-bulk-read",requestedScope:{workspaceId:w.scope.workspaceId,accountIds:[w.scope.accountId],environment:"sandbox"},viewKey:"batchDetail",filters:{context:"bulk",...w.filters},period:null,sort:[],page:{cursor:null,limit:100}};
    const read=async(token=SYNTHETIC_REVIEW_TOKEN)=>{const res=await fetch(base+"/v1/read",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});return{status:res.status,body:await res.json()};};
    const first=await read();expect(first.status,JSON.stringify(first.body)).toBe(200);const data=nativeBulkViewSchema.parse(first.body.data);
    expect(data.rows).toHaveLength(24);expect(data.rows.filter(r=>r.sampleDisposition==="noNewSample")).toHaveLength(12);expect(data.sampleCommitments).toBeNull();
    expect(JSON.stringify(data)).not.toContain("fictional-private-");expect(data.confersAuthority).toBe(false);
    const viewer=await read(SYNTHETIC_READ_TOKEN);expect(viewer.status).toBe(200);expect(viewer.body.capabilities.every((c:{state:string})=>c.state==="denied")).toBe(true);
    w.state.denied=true;expect((await read()).status).toBe(403);w.state.denied=false;
    w.registry.registrations.clear();const unavailable=await read();expect(unavailable.status).toBe(503);expect(unavailable.body.code).toBe("BULK_RUNTIME_UNCONFIGURED");expect(unavailable.body.data).toBeUndefined();
    expect(w.state.calls).toHaveLength(0);expect(w.a.db.prepare("SELECT count(*) n FROM job_runtime_registrations").get()?.n).toBe(0);
  }finally{await app.close();w.close();rmSync(dir,{recursive:true,force:true});}
});
