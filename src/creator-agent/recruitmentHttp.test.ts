// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { recruitmentServerFixture } from "./recruitment/serverFixture.testkit.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { SYNTHETIC_REVIEW_TOKEN,SYNTHETIC_READ_TOKEN } from "./testFixtures.ts";
import type { InvitationSave,NativeInvitationView } from "./recruitment/contract.ts";
let directory:string,app:ReturnType<typeof createAgentServer>,fixture:ReturnType<typeof recruitmentServerFixture>,origin:string,sequence=0;
beforeEach(async()=>{directory=mkdtempSync(join(tmpdir(),"farda-recruitment-http-"));fixture=recruitmentServerFixture(join(directory,"scope.sqlite"));app=createAgentServer(fixture.options);await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));const address=app.server.address();if(!address||typeof address==="string")throw Error("Missing address");origin=`http://127.0.0.1:${address.port}`;});
afterEach(async()=>{vi.restoreAllMocks();await app.close();fixture.close();rmSync(directory,{recursive:true,force:true});});
const scope=()=>({workspaceId:fixture.scope.workspaceId,accountIds:[fixture.scope.accountId],environment:"sandbox"});
async function post(path:string,value:unknown,token=SYNTHETIC_REVIEW_TOKEN){const response=await fetch(origin+path,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(value)});return {status:response.status,body:await response.json()};}
function request(viewKey:string,filters:unknown){return {schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:`read-${++sequence}`,requestedScope:scope(),viewKey,filters,period:null,sort:[],page:{cursor:null,limit:100}};}
async function invitation(){const result=await post("/v1/read",request("invitationDraft",fixture.filters));expect(result.status,JSON.stringify(result.body)).toBe(200);return result.body.data as NativeInvitationView;}
function save(data:NativeInvitationView){const product=data.products[0]!,template=data.templates[0]!;const payload:InvitationSave={kind:"recruitmentInvitation",draftId:"synthetic-http-invitation",expectedVersion:null,terms:{creatorId:fixture.filters.creatorId,offerId:fixture.filters.offerId,offerVersion:fixture.filters.offerVersion,productRef:product.ref,programRef:product.programRef,sourceVersion:data.sourceVersion,templateRef:template.ref,templateVersion:template.version,claimsVersion:template.claimsVersion,message:"Fictional source-reviewed invitation.",startsAt:new Date(fixture.o.now()+30_000).toISOString(),expiresAt:new Date(fixture.o.now()+120_000).toISOString(),timezone:"America/Los_Angeles",sampleRequested:true}};return {schemaVersion:SCHEMA_VERSION,operation:"saveResource",requestId:"save-exact",requestedScope:scope(),resourceKind:"configurationDraft",resourceRef:payload.draftId,expectedVersion:null,idempotencyKey:"synthetic-http-save",payload};}
describe("recruitment native HTTP integration",()=>{
  it("reads current source catalog, saves one exact immutable draft, then recovers that scoped original",async()=>{const first=await invitation();expect(first.provenance).toEqual({evidenceStage:"synthetic",synthetic:true});const command=save(first);const result=await post("/v1/save",command);expect(result.status,JSON.stringify(result.body)).toBe(200);expect(result.body.record).toMatchObject({resourceRef:command.resourceRef,requestKey:command.idempotencyKey,actorRef:first.actorRef,sourceEffect:"none"});expect((await post("/v1/save",command)).body).toEqual(result.body);const observed=await post("/v1/read",request("invitationDraft",{...fixture.filters,draftId:command.resourceRef,requestKey:command.idempotencyKey}));expect(observed.status,JSON.stringify(observed.body)).toBe(200);expect(observed.body.data.requestRecovery).toMatchObject({state:"recorded",confersRetry:false,receipt:result.body.record});expect(fixture.owner.state.contexts).toHaveLength(0);});
  it("denies reader saves and foreign scope before persistence",async()=>{const command=save(await invitation());expect((await post("/v1/save",command,SYNTHETIC_READ_TOKEN)).status).toBe(403);expect((await post("/v1/save",{...command,requestedScope:{...scope(),accountIds:["foreign"]}})).status).toBe(403);expect(fixture.drafts.read(command.resourceRef,fixture.principal)).toBeNull();});
  it("requires matching outer and inner draft/version selectors",async()=>{const command=save(await invitation());const response=await post("/v1/save",{...command,resourceRef:"other"});expect(response.status).toBe(422);expect(response.body.code).toBe("RECRUITMENT_SAVE_SCOPE_MISMATCH");expect(fixture.drafts.read(command.resourceRef,fixture.principal)).toBeNull();});
  it("source denial or material change during an awaited read cannot publish cached source content",async()=>{fixture.source.state.afterRead=()=>{fixture.source.state.denied=true;};const result=await post("/v1/read",request("invitationDraft",fixture.filters));expect(result.status).toBe(403);expect(result.body).not.toHaveProperty("data");});
  it("does not persist a draft when its caller credential rotates during the captured source read",async()=>{
    const command=save(await invitation()),rotated="synthetic-rotated-recruitment-reviewer-0005";
    fixture.source.state.afterRead=()=>{fixture.options.reviewToken=rotated;};
    const denied=await post("/v1/save",command);
    expect(denied.status).toBe(401);expect(denied.body).toMatchObject({code:"RECRUITMENT_CALLER_DENIED",executionCertainty:"notApplied"});
    expect(denied.body).not.toHaveProperty("record");expect(denied.body).not.toHaveProperty("resourceVersion");
    expect(app.store.database.prepare("SELECT COUNT(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
    expect(app.store.database.prepare("SELECT COUNT(*) n FROM recruitment_invitation_saves").get()?.n).toBe(0);
    const lookup=await post("/v1/read",request("invitationDraft",{...fixture.filters,draftId:command.resourceRef,requestKey:command.idempotencyKey}),rotated);
    expect(lookup.status).toBe(200);expect(lookup.body.data.requestRecovery).toMatchObject({state:"notFound",confersRetry:false,receipt:null});
    expect(fixture.owner.state.contexts).toHaveLength(0);
  });
  it("withholds a postcommit acknowledgment after caller revocation and recovers the immutable original without a second save",async()=>{
    const command=save(await invitation()),rotated="synthetic-rotated-recruitment-reviewer-0006",db=app.store.database;
    const execute=db.exec.bind(db);let receipt:string|null=null;
    const observer=vi.spyOn(db,"exec").mockImplementation((sql:string)=>{
      execute(sql);
      if(sql.trim().toUpperCase()!=="COMMIT"||receipt!==null)return;
      const row=db.prepare("SELECT receipt FROM recruitment_invitation_saves").get();
      if(typeof row?.receipt==="string"){receipt=row.receipt;fixture.options.reviewToken=rotated;}
    });
    const denied=await post("/v1/save",command);observer.mockRestore();
    expect(denied.status).toBe(401);expect(denied.body).toMatchObject({code:"RECRUITMENT_CALLER_DENIED",executionCertainty:"uncertain"});
    expect(denied.body).not.toHaveProperty("record");expect(denied.body).not.toHaveProperty("resourceVersion");expect(receipt).not.toBeNull();
    const original=JSON.parse(receipt!);
    expect(original).toMatchObject({resourceRef:command.resourceRef,requestKey:command.idempotencyKey,expectedVersion:null,sourceEffect:"none"});
    expect((await post("/v1/read",request("invitationDraft",{...fixture.filters,draftId:command.resourceRef,requestKey:command.idempotencyKey}))).status).toBe(401);
    const lookup=await post("/v1/read",request("invitationDraft",{...fixture.filters,draftId:command.resourceRef,requestKey:command.idempotencyKey}),rotated);
    expect(lookup.status).toBe(200);expect(lookup.body.data.requestRecovery).toMatchObject({state:"recorded",confersRetry:false,receipt:original});
    expect(app.store.database.prepare("SELECT COUNT(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(1);
    expect(app.store.database.prepare("SELECT COUNT(*) n FROM recruitment_invitation_saves").get()?.n).toBe(1);
    expect(fixture.owner.state.contexts).toHaveLength(0);
  });
  it("preserves legacy invitation read and scorecard-preview filters as separate owners",async()=>{const legacy=await post("/v1/read",request("invitationDraft",{}));expect(legacy.status).toBe(503);expect(legacy.body).not.toHaveProperty("data");const invalid=await post("/v1/read",request("batchDetail",{context:"recruitment",batchId:"synthetic-missing",selection:[]}));expect(invalid.status).toBe(400);});
});
