import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { recruitmentServerFixture } from "../src/creator-agent/recruitment/serverFixture.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import type { NativeInvitationView, InvitationSave } from "../src/creator-agent/recruitment/contract.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

let dir:string,fixture:ReturnType<typeof recruitmentServerFixture>,app:ReturnType<typeof createAgentServer>;
let selectedRun:{approvalRef:string;runRef:string}|null=null;
const port=Number(process.env.E2E_AGENT_SERVER_PORT),base=`http://127.0.0.1:${port}`;
const composer=()=>`/creators/tiktok/invitations/new?${new URLSearchParams({creatorId:fixture.offer.terms.creatorId,offerId:fixture.offer.offerId,offerVersion:fixture.offer.version})}`;
const queue=()=>`/creators/social-cat/recruitment?${new URLSearchParams({creatorId:fixture.offer.terms.creatorId,offerId:fixture.offer.offerId,offerVersion:fixture.offer.version})}`;
let sequence=0;
const scope=()=>({workspaceId:fixture.scope.workspaceId,accountIds:[fixture.scope.accountId],environment:"sandbox"});
async function post(path:string,body:unknown,token=SYNTHETIC_REVIEW_TOKEN){const result=await fetch(base+path,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});return {status:result.status,body:await result.json()};}
async function read(viewKey:string,filters:unknown){return post("/v1/read",{schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:`read-${++sequence}`,requestedScope:scope(),viewKey,filters,period:null,sort:[],page:{cursor:null,limit:100}});}
async function login(page:Page,reviewer=true){expect((await page.request.get("/v1/session",{headers:{authorization:`Bearer ${reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN}`}})).ok()).toBe(true);}
async function listen(){await new Promise<void>(resolve=>app.server.listen(port,"127.0.0.1",resolve));}
test.beforeEach(async()=>{
  dir=mkdtempSync(join(tmpdir(),"farda-recruitment-test-"));fixture=recruitmentServerFixture(join(dir,"test.sqlite"));selectedRun=null;
  const source=fixture.options.recruitmentWorkspace!.source!;
  app=createAgentServer({...fixture.options,recruitmentWorkspace:{...fixture.options.recruitmentWorkspace,source:{read:async(request,options)=>{if(request.kind==="batch"&&selectedRun)fixture.publishBatch(app,selectedRun.approvalRef,selectedRun.runRef);return source.read(request,options);},assertCurrent:source.assertCurrent}}});
  await listen();
});
test.afterEach(async()=>{await app.close();fixture.close();rmSync(dir,{recursive:true,force:true});});
async function saveRequest(){
  const observed=await read("invitationDraft",fixture.filters);expect(observed.status,JSON.stringify(observed.body)).toBe(200);const data=observed.body.data as NativeInvitationView,p=data.products[0]!,t=data.templates[0]!;
  const payload:InvitationSave={kind:"recruitmentInvitation",draftId:"synthetic-invitation-browser",expectedVersion:null,terms:{creatorId:fixture.offer.terms.creatorId,offerId:fixture.offer.offerId,offerVersion:fixture.offer.version,productRef:p.ref,programRef:p.programRef,sourceVersion:data.sourceVersion,templateRef:t.ref,templateVersion:t.version,claimsVersion:t.claimsVersion,message:"A fictional everyday routine invitation.",startsAt:new Date(fixture.o.now()+30_000).toISOString(),expiresAt:new Date(fixture.o.now()+180_000).toISOString(),timezone:"America/Los_Angeles",sampleRequested:true}};
  const saved=await post("/v1/save",{schemaVersion:SCHEMA_VERSION,operation:"saveResource",requestId:"save-original",requestedScope:scope(),resourceKind:"configurationDraft",resourceRef:payload.draftId,expectedVersion:null,idempotencyKey:"synthetic-save-browser",payload});
  expect(saved.status,JSON.stringify(saved.body)).toBe(200);return {payload,record:saved.body.record};
}
async function batch(){const saved=await saveRequest();const view=await read("invitationDraft",{...fixture.filters,draftId:saved.payload.draftId});expect(view.status,JSON.stringify(view.body)).toBe(200);
  const result=await post("/v1/action",{schemaVersion:SCHEMA_VERSION,operation:"previewAction",requestId:"preview-original",requestedScope:scope(),actionKind:"recruitment.invitation",entityRefs:[],expectedVersion:saved.record.version,approvalRef:null,manifestRef:null,runRef:null,idempotencyKey:"synthetic-preview-browser",payload:{entityRef:saved.payload.draftId,entityVersion:saved.record.version,selectionRefs:view.body.data.previewSelectionRefs}});
  expect(result.status,JSON.stringify(result.body)).toBe(200);const queued=await fixture.approveAndQueue(app,result.body.approvalRef);selectedRun={approvalRef:result.body.approvalRef,runRef:queued.run.runRef};return {...queued,...saved};}
async function capture(page:Page,info:TestInfo,name:string,width:number){await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`recruitment-${name}-${width}.png`),fullPage:true});}

test("recruitment source holds are honest and cannot fall back to demo data",async({page})=>{
  await app.close();app=createAgentServer({...fixture.options,recruitmentWorkspace:undefined,recruitmentSource:undefined});await listen();await login(page);
  for(const path of [composer(),queue(),"/batches/synthetic-unbound"]){await page.goto(path);await expect(page.getByRole("alert").filter({hasText:"Data unavailable"})).toBeVisible();await expect(page.getByText("@studio.rae",{exact:false})).toHaveCount(0);await expect(page.getByRole("button",{name:"Save invitation draft",exact:true})).toHaveCount(0);}
});

test("actual HTTP invitation save, original readback, immutable preview and canonical batch cancellation",async({page},info)=>{
  test.setTimeout(240_000);await login(page);await page.goto(composer());await expect(page.getByLabel("Invitation message",{exact:true})).toHaveValue("A fictional everyday routine invitation.");
  const product=await page.getByLabel("Product",{exact:true}).locator("option").nth(1).getAttribute("value");await page.getByLabel("Product",{exact:true}).selectOption(product!);
  await page.getByLabel("Invitation starts",{exact:true}).fill(new Date(fixture.o.now()+30_000).toISOString());await page.getByLabel("Invitation expires",{exact:true}).fill(new Date(fixture.o.now()+180_000).toISOString());
  const recordedKeys:string[]=[];let originalDraftId="";
  await page.route("**/v1/save",async route=>{const body=route.request().postDataJSON();if(body.payload?.kind!=="recruitmentInvitation")return route.continue();recordedKeys.push(body.idempotencyKey);originalDraftId=body.resourceRef;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");});
  await page.getByRole("button",{name:"Save invitation draft",exact:true}).click();await expect(page.getByRole("button",{name:"Continue with saved revision",exact:true})).toBeVisible();
  const savedUrl=page.url();expect(savedUrl).toContain("requestKey=");await page.reload();await expect(page.getByRole("button",{name:"Continue with saved revision",exact:true})).toBeVisible();await page.getByRole("button",{name:"Continue with saved revision",exact:true}).click();expect(recordedKeys).toHaveLength(2);expect(new Set(recordedKeys).size).toBe(1);expect(fixture.drafts.read(originalDraftId,fixture.principal)?.version).toBe("invitation-v1");
  await page.getByRole("button",{name:"Review exact request",exact:true}).first().click();const dialog=page.getByRole("dialog",{name:"Review exact invitation request"});await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:"Create immutable approval preview",exact:true}).click();
  const preview=dialog.getByRole("link",{name:"Open immutable invitation preview",exact:true});await expect(preview).toBeVisible();const approvalRef=decodeURIComponent(new URL((await preview.getAttribute("href"))!,page.url()).pathname.split("/").pop()!);await page.keyboard.press("Escape");
  const queued=await fixture.approveAndQueue(app,approvalRef);selectedRun={approvalRef,runRef:queued.run.runRef};await page.goto(`/approvals/${encodeURIComponent(approvalRef)}`);await page.getByRole("link",{name:"Open finite recruitment batch",exact:true}).click();await expect(page.getByRole("table",{name:"Exact finite batch outcomes"})).toBeVisible();
  await page.getByRole("checkbox",{name:/Select Fictional creator/}).check();await page.getByRole("button",{name:"Cancel selected unsent items",exact:true}).click();const cancel=page.getByRole("dialog",{name:"Review selected unsent cancellation"});await expect(cancel).toBeVisible();await cancel.getByRole("button",{name:"Request selected cancellation",exact:true}).click();
  await expect(page.getByRole("table",{name:"Exact finite batch outcomes"})).toContainText("cancelled");expect(fixture.owner.state.contexts).toHaveLength(0);expect(app.actionFoundation.dispatch.read(queued.run.runRef,false).run.items[0]?.state).toBe("cancelled");await capture(page,info,"cancelled",1440);
});

test("a lost preview acknowledgment recovers its original immutable manifest after the saved offer changes",async({page})=>{
  const saved=await saveRequest();await login(page);await page.goto(`${composer()}&draftId=${encodeURIComponent(saved.payload.draftId)}`);
  let approvalRef="";const previewKeys:string[]=[];
  await page.route("**/v1/action",async route=>{
    const body=route.request().postDataJSON();if(body.operation!=="previewAction"||body.actionKind!=="recruitment.invitation")return route.continue();
    previewKeys.push(body.idempotencyKey);const response=await route.fetch();
    if(!approvalRef){expect(response.status()).toBe(200);approvalRef=(await response.json()).approvalRef;
      const prior=fixture.o.repo.readOffer(fixture.offer.offerId)!;
      const next=structuredClone(prior.terms);next.commission.standardRateBps=1700;
      fixture.o.repo.saveFromAdapter(prior.offerId,prior.version,next,"fictional-concurrent-offer-revision");
    }
    await route.abort("failed");
  });
  await page.getByRole("button",{name:"Review exact request",exact:true}).first().click();
  const dialog=page.getByRole("dialog",{name:"Review exact invitation request"});
  await dialog.getByRole("button",{name:"Create immutable approval preview",exact:true}).click();
  await expect(page.getByRole("link",{name:"Open immutable invitation preview",exact:true}).first()).toHaveAttribute("href",/\/approvals\//);
  const originalUrl=page.url();expect(originalUrl).toContain("previewRequestKey=");expect(originalUrl).toContain("previewVersion=invitation-v1");
  await page.reload();
  await expect(page.getByRole("link",{name:"Open immutable invitation preview",exact:true}).first()).toHaveAttribute("href",`/approvals/${encodeURIComponent(approvalRef)}?version=v1`);
  await expect(page.getByRole("button",{name:"Save invitation draft",exact:true})).toBeDisabled();
  expect(previewKeys.length).toBeGreaterThan(0);expect(new Set(previewKeys).size).toBe(1);expect(fixture.o.repo.readOffer(fixture.offer.offerId)?.version).toBe("v2");
  expect(fixture.drafts.read(saved.payload.draftId,fixture.principal)?.terms.offerVersion).toBe("v1");
  expect(fixture.owner.state.contexts).toHaveLength(0);expect(app.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);
});

test("proposed Social Cat terms save through the actual offer repository and remain proposals after reload",async({page})=>{
  await login(page);await page.goto(queue());
  await expect(page.getByRole("button",{name:"Save proposed terms",exact:true})).toBeEnabled();
  await page.getByRole("checkbox",{name:"Propose Instagram deliverable",exact:true}).check();await page.getByLabel("Instagram deliverable",{exact:true}).fill("Proposed everyday routine video");
  await page.getByLabel("Instagram deliverable count",{exact:true}).fill("1");
  await page.getByRole("checkbox",{name:"Propose optional TikTok post",exact:true}).check();await page.getByLabel("TikTok deliverable",{exact:true}).fill("Optional routine post");
  await page.getByLabel("Commission percent",{exact:true}).fill("17");await page.getByLabel("instagram rights proposal",{exact:true}).fill("Organic repost proposal; scope requires agreement");
  const due=new Date(fixture.o.now()+86_400_000).toISOString();await page.getByLabel("instagram delivery timestamp",{exact:true}).fill(due);await page.getByLabel("instagram delivery timezone",{exact:true}).fill("America/Los_Angeles");
  await page.getByLabel("Sample creators",{exact:true}).fill("1");await page.getByLabel("Units per creator",{exact:true}).fill("1");
  await page.getByRole("button",{name:"Save proposed terms",exact:true}).click();await expect(page.getByRole("button",{name:"Use saved offer revision",exact:true})).toBeVisible();
  await page.reload();await page.getByRole("button",{name:"Use saved offer revision",exact:true}).click();
  await expect(page.getByLabel("Commission percent",{exact:true})).toHaveValue("17");expect(page.url()).toContain("offerVersion=v2");
  const saved=fixture.o.repo.readOffer(fixture.offer.offerId)!;expect(saved.version).toBe("v2");expect(saved.state).toBe("proposed");expect(saved.acceptedRef).toBeNull();
  expect(saved.terms.commission.standardRateBps).toBe(1700);expect(saved.terms.manifest.deliverables.map(d=>d.network)).toEqual(expect.arrayContaining(["instagram","tiktok"]));
  expect(saved.terms.manifest.deliverables.find(d=>d.network==="instagram")).toMatchObject({format:"Proposed everyday routine video",dueAt:due,timezone:"America/Los_Angeles"});
  expect(fixture.owner.state.contexts).toHaveLength(0);expect(app.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);
});

test("source denial clears the protected composer and reader role cannot save",async({page})=>{
  await login(page,false);await page.goto(composer());await expect(page.getByRole("button",{name:"Save invitation draft",exact:true})).toBeDisabled();
  await login(page);await page.reload();await expect(page.getByLabel("Invitation message",{exact:true})).toBeVisible();fixture.source.state.denied=true;await page.getByRole("button",{name:"Refresh source evidence",exact:true}).click();await expect(page.getByRole("alert").filter({hasText:"No access"})).toBeVisible();await expect(page.getByLabel("Invitation message",{exact:true})).toHaveCount(0);
});

test("finite batch filters withdraw selected cancellation and capacity units stay separate",async({page})=>{
  const w=await batch();await login(page);await page.goto(`/batches/${encodeURIComponent(w.run.runRef)}`);await page.getByRole("checkbox",{name:/Select Fictional creator/}).check();await expect(page.getByRole("button",{name:"Cancel selected unsent items",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:/Source:/}).click();await page.getByRole("radio",{name:"Social Cat",exact:true}).click();await expect(page).toHaveURL(/source=social-cat/);await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Cancel selected unsent items",exact:true})).toBeDisabled();expect(page.url()).toContain("source=social-cat");
  await page.getByRole("button",{name:"Capacity",exact:true}).click();expect(page.url()).toContain("tab=capacity");await expect(page.getByRole("table",{name:"Source capacity by native unit"})).toBeVisible();expect(fixture.owner.state.contexts).toHaveLength(0);
});

test("complete native source layouts, keyboard dialog return and actual representative screen-reader evidence",async({page},info)=>{
  test.setTimeout(240_000);const w=await batch();await login(page);
  for(const [name,path] of [["social-cat",queue()],["invitation",composer()],["batch",`/batches/${encodeURIComponent(w.run.runRef)}`]]){
    await page.goto(path!);await expect(page.getByRole("heading",{level:1})).toBeVisible();await expect(page.getByRole("alert").filter({hasText:"Data unavailable"})).toHaveCount(0);
    if(name==="social-cat")await expect(page.getByRole("button",{name:"Save proposed terms",exact:true})).toBeVisible();
    else if(name==="invitation"){await expect(page.getByLabel("Invitation message",{exact:true})).toHaveValue("A fictional everyday routine invitation.");await expect(page.getByLabel("Product",{exact:true}).locator("option")).toHaveCount(2);}
    else {await expect(page.getByRole("table",{name:"Exact finite batch outcomes"})).toBeVisible();await expect(page.getByRole("checkbox",{name:/Select Fictional creator/})).toBeVisible();}
    for(const width of [1440,1024,390])await capture(page,info,name!,width);
    const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  }
  await page.setViewportSize({width:1440,height:1000});await page.goto(composer());const review=page.getByRole("button",{name:"Review exact request",exact:true}).first();await review.focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog",{name:"Review exact invitation request"})).toBeVisible();await page.keyboard.press("Escape");await expect(review).toBeFocused();
  await screenReaderCheckpoint(page,"recruitment-invitation-dialog-focus-return",review,["Review exact request","button"]);
  await page.getByRole("button",{name:"Save invitation draft",exact:true}).click();await expect(page.getByLabel("Invitation starts",{exact:true})).toHaveAttribute("aria-invalid","true");await screenReaderCheckpoint(page,"recruitment-invitation-invalid-start",page.getByLabel("Invitation starts",{exact:true}),["Invitation starts","invalid"]);
  await page.goto(`/batches/${encodeURIComponent(w.run.runRef)}`);await screenReaderCheckpoint(page,"recruitment-finite-outcomes-table",page.getByRole("region",{name:"Exact finite batch outcomes"}),["Exact finite batch outcomes","Recipient","Outcome"],"KP_Enter");
});
