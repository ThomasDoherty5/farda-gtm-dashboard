import {expect,test,type Page,type TestInfo} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename,join,resolve,sep} from "node:path";
import {promisify} from "node:util";
import {createOperationsControlHttpFixture} from "../src/creator-agent/operationsControlHttp.testkit.ts";
import {createOperationsControlEvidenceHttpFixture} from "../src/creator-agent/operationsControlEvidence.testkit.ts";
import {controlTestJob} from "../src/creator-agent/operationsControlsFixtures.ts";
import {nativeOperationsControlSchema} from "../src/creator-agent/operationsControlsSchema.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN} from "../src/creator-agent/testFixtures.ts";

// Actual authenticated server, canonical J04 and temporary SQLite. Source identities,
// membership, comparison and receipts are explicitly fictional; no provider is invoked.
test.setTimeout(300_000);
type World=ReturnType<typeof createOperationsControlHttpFixture>;
let w:World,directory:string;
test.beforeEach(async()=>{
 directory=mkdtempSync(join(tmpdir(),"farda-controls-completion-"));
 w=createOperationsControlHttpFixture({databasePath:join(directory,"native.sqlite")});
 renew();
 await new Promise<void>((done,reject)=>{w.app.server.once("error",reject);w.app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",done);});
});
test.afterEach(async()=>{try{await w?.close();}finally{if(directory)rmSync(directory,{recursive:true,force:true});}});
function renew(){w.refreshClock();}
async function login(page:Page,reviewer=true){expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN)}})).status()).toBe(200);}
async function controls(section="runs",filters:Record<string,unknown>={}){
 const response=await fetch(`http://127.0.0.1:${process.env.E2E_AGENT_SERVER_PORT}/v1/read`,{method:"POST",headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN,"content-type":"application/json"},body:JSON.stringify(w.readRequest(section,filters))});
 const raw=await response.json();expect(response.status,JSON.stringify(raw)).toBe(200);return nativeOperationsControlSchema.parse(raw.data);
}
function count(table:"operations_control_requests"|"job_runs"){
 return Number(w.app.store.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n??0);
}
async function task(page:Page,reason="Fictional protected operator reason"){
 const trigger=page.getByRole("button",{name:"Request task",exact:true}).first();await expect(trigger).toBeEnabled();
 await trigger.focus();await page.keyboard.press("Enter");
 const chooser=page.getByRole("dialog",{name:"Choose a registered task"});await expect(chooser).toBeVisible();
 await chooser.getByRole("button",{name:"Draft Daily evidence review task",exact:true}).click();
 const form=page.getByRole("dialog",{name:"Request task",exact:true});await expect(form.getByRole("table",{name:"Exact finite selection"})).toBeVisible();
 await form.getByLabel("Reason",{exact:true}).fill(reason);return form;
}
async function privateStorage(page:Page){
 // Persistence is inspected only by this fictional browser test, never copied into artifacts.
 // eslint-disable-next-line no-restricted-globals
 return page.evaluate(()=>JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)]));
}
async function axe(page:Page){
 const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
 expect(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
}
type SourceName="connections"|"team"|"runs"|"schedule"|"capabilities";
async function compareOriginal(page:Page,state:SourceName){
 const configured=process.env.FARDA_OPERATIONS_COMPLETION_COMPARE_DIR;if(!configured)return;
 const root=resolve(".handoff")+sep,out=resolve(configured),mapping=resolve(process.env.FARDA_OPERATIONS_COMPLETION_SOURCE_MAP??".handoff/next-305/originals/controls-map.json");
 if(!mapping.startsWith(root))throw new Error("Original source mapping must remain private.");
 const sourceFiles=JSON.parse(readFileSync(mapping,"utf8")) as Record<SourceName,string>,original=resolve(sourceFiles[state]);
 if(!out.startsWith(root)||!original.startsWith(root))throw new Error("Original Figma comparison must remain in ignored private handoff storage.");
 const target=join(out,state),auth=join(target,"synthetic-auth.json");mkdirSync(target,{recursive:true});
 try{
  writeFileSync(auth,JSON.stringify(await page.context().storageState()),{mode:0o600});
  const url=new URL(page.url()),env={...process.env};delete env.SEGMENTS;
  const result=await promisify(execFile)(process.execPath,["scripts/compare-figma.mjs",url.pathname+url.search,original],{
   env:{...env,BASE_URL:url.origin,FIGMA_COMPARE_BROWSER_CHANNEL:process.env.E2E_AGENT_BROWSER_CHANNEL,FIGMA_COMPARE_STORAGE_STATE:auth,FIGMA_COMPARE_OUTPUT_DIR:target},timeout:60000});
  writeFileSync(join(target,"comparison.json"),JSON.stringify({state,fullFrame:true,crop:null,segments:null,
   claim:"Complete original and complete native render retained privately. Different heights are an explicit source-state adaptation; pixel percentage covers only the common rectangle, not full-frame parity.",metrics:JSON.parse(result.stdout)},null,2));
  if(result.stderr)writeFileSync(join(target,"stderr.txt"),result.stderr);
 }finally{rmSync(auth,{force:true});}
}
async function capture(page:Page,info:TestInfo,state:string,source?:SourceName){
 const out=process.env.FARDA_OPERATIONS_COMPLETION_PROOF_DIR??info.outputPath("operations-completion-evidence"),captures=[];mkdirSync(out,{recursive:true});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:width===1440?1000:844});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>window.scrollTo(0,0));
  await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);await axe(page);
  const path=join(out,`${state}-${width}.png`);await page.screenshot({path,fullPage:true});const png=readFileSync(path);
  captures.push({file:basename(path),width:png.readUInt32BE(16),height:png.readUInt32BE(20),sha256:createHash("sha256").update(png).digest("hex")});
  if(source&&width===1440)await compareOriginal(page,source);
 }
 writeFileSync(join(out,`${state}-provenance.json`),JSON.stringify({state,source:"Actual authenticated HTTP, canonical J04 and SQLite; fictional source authority only",providerWrites:0,
  originalMediaIncluded:false,visualClaim:"Native source-state adaptation; no pixel-parity or real screen-reader claim",captures},null,2));
}
async function scheduleRoute(page:Page){
 await page.goto("/automations?tab=zaps");const link=page.getByRole("link",{name:/schedule draft/}).first();await expect(link).toBeVisible();const path=await link.getAttribute("href");expect(path).toBeTruthy();return path!;
}
function addMembership(){
 for(const [index,person]of ["synthetic-person-one","synthetic-person-two"].entries()){
  const run=w.app.operations.jobs.ingest({schemaVersion:"job-reference-batch.v1",jobId:controlTestJob.jobId,jobVersion:1,eventId:`synthetic-membership-${index}`,eventType:controlTestJob.eventType,eventAt:w.a.at(),
   items:[{itemKey:`synthetic-item-${index}`,subjectRef:`synthetic-subject-${index}`,evidenceRef:null}]},`synthetic-membership-ingress-${index}`);
  w.snapshot.runMembership.push({id:`synthetic-membership-${index}`,runId:run.runId,platform:index===0?"instagram":"tiktok",assignedActorRef:person,sourceVersion:"synthetic-membership-v1",evidenceRef:"synthetic-membership-proof",observedAt:w.a.at()});
 }
}

test("five native source routes retain full content, keyboard navigation and responsive accessible captures",async({page},info)=>{
 await login(page);const schedule=await scheduleRoute(page);
 const routes:[SourceName,string][]=[["connections","/settings/connections"],["team","/settings/team"],["runs","/automations"],["schedule",schedule],["capabilities","/settings/capabilities"]];
 for(const [name,path]of routes){renew();await page.goto(path);await expect(page.getByRole("heading",{name:"Finite action previews",exact:true})).toBeVisible();await capture(page,info,name,name);}
 await page.goto("/settings/team");
 const inspect=page.getByRole("button",{name:"Inspect evidence",exact:true}).first();await inspect.focus();await page.keyboard.press("Enter");
 const detail=page.getByRole("dialog");await expect(detail).toBeVisible();await expect(detail).toContainText("Provider role");
 await axe(page);await page.keyboard.press("Escape");await expect(inspect).toBeFocused();
 await page.goto("/settings/capabilities");const validation=page.getByRole("button",{name:"Plan validation",exact:true});await validation.focus();await page.keyboard.press("Enter");
 await expect(page.getByRole("dialog",{name:"Plan validation",exact:true})).toBeVisible();await page.keyboard.press("Escape");await expect(validation).toBeFocused();
 await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
 await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);await axe(page);
 await page.evaluate(()=>{document.documentElement.style.fontSize="";});expect(w.state.effects).toBe(0);
});

test("finite canonical preview opens the existing source-approval stages without dispatching",async({page},info)=>{
 await login(page);await page.goto("/automations");const form=await task(page);await capture(page,info,"finite-task-preview-dialog");
 await form.getByRole("button",{name:"Create approval preview",exact:true}).focus();await page.keyboard.press("Enter");
 const open=page.getByRole("link",{name:"Open exact approval preview",exact:true});await expect(open).toBeVisible();expect(count("operations_control_requests")).toBe(1);expect(count("job_runs")).toBe(0);
 const path=(await open.getAttribute("href"))!;await open.click();await expect(page.getByRole("heading",{name:"A human decision. A precise action.",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Approve this version",exact:true})).toBeDisabled();
 await page.getByRole("button",{name:"Request source approval",exact:true}).click();await expect(page.getByText("Command acknowledged.",{exact:false})).toBeVisible();
 const approvalRef=decodeURIComponent(path.split("/").at(-1)!);const current=w.app.actionFoundation.approvals.readApproval(approvalRef)!;
 expect(current.request.record).toBeTruthy();const event=w.a.event(current);await w.app.actionFoundation.approvals.observeDecision(event.locator,{ingressRef:"synthetic-browser-source-ingress"});
 await page.getByRole("button",{name:"Refresh approval evidence",exact:true}).click();await expect(page.getByTestId("native-approval-status")).toContainText("Approved");
 expect(count("job_runs")).toBe(0);expect(w.state.effects).toBe(0);expect(await privateStorage(page)).not.toContain("Fictional protected operator reason");
 await capture(page,info,"canonical-source-decision-readback");
});

for(const committed of [false,true])test(`lost preview acknowledgment ${committed?"after actual commit":"before service"} preserves the original key across reload`,async({page},info)=>{
 await login(page);await page.goto("/automations");const form=await task(page),writes:{idempotencyKey:string;actionKind:string;payload:unknown}[]=[];
 await page.route("**/v1/action",async route=>{
  const body=route.request().postDataJSON();writes.push(body);
  if(body.actionKind!=="previewOperationsControl")throw new Error("Unexpected command in finite preview recovery");
  if(writes.length===1){if(committed){const response=await route.fetch();expect(response.status()).toBe(200);}
   await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",executionCertainty:"uncertain",retryable:false})});
  }else await route.continue();
 });
 await form.getByRole("button",{name:"Create approval preview",exact:true}).click();await expect(page.getByRole("status").filter({hasText:"Proposal outcome is unverified"})).toBeVisible();
 expect(writes).toHaveLength(1);expect(count("operations_control_requests")).toBe(committed?1:0);
 const key=writes[0]!.idempotencyKey;expect(await privateStorage(page)).toContain(key);expect(await privateStorage(page)).not.toContain("Fictional protected operator reason");
 await page.reload();await expect(page.getByRole("region",{name:"Unverified review request",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Reconcile exact request",exact:true}).click();
 if(committed){await expect(page.getByRole("link",{name:"Open exact approval preview",exact:true})).toBeVisible();expect(await privateStorage(page)).not.toContain(key);}
 else{await expect(page.getByRole("status").filter({hasText:"original request remains held"})).toBeVisible();await expect(page.getByRole("button",{name:"Review original request",exact:true})).toHaveCount(0);expect(await privateStorage(page)).toContain(key);}
 expect(writes).toHaveLength(1);expect(count("job_runs")).toBe(0);expect(w.state.effects).toBe(0);await capture(page,info,committed?"canonical-lost-ack-recovered":"canonical-original-key-held");
});

test("Assigned to me uses named source membership, labels its denominator and resets URL filters",async({page},info)=>{
 addMembership();await login(page);await page.goto("/automations");const all=await controls();expect(all.localRuns).toHaveLength(2);
 const mine=page.getByRole("button",{name:"Assigned to me",exact:true});await mine.focus();await page.keyboard.press("Enter");await expect(mine).toHaveAttribute("aria-pressed","true");
 await expect(page).toHaveURL(/controlMine=true/);const exact=await controls("runs",{mine:true});expect(exact.localRuns).toHaveLength(1);
 const table=page.getByRole("table",{name:"Native run recovery traces",exact:true});await expect(table.locator("tbody tr")).toHaveCount(1);await expect(table).toContainText(exact.localRuns[0]!.title);
 await expect(page.getByText(/1 matching traces among 2 of 2 local runs inspected/)).toBeVisible();await page.reload();await expect(table.locator("tbody tr")).toHaveCount(1);
 await page.setViewportSize({width:390,height:844});const scroll=page.getByRole("region",{name:"Native run recovery traces",exact:true});
 if(await scroll.evaluate(el=>el.scrollWidth>el.clientWidth)){await scroll.focus();await page.keyboard.press("ArrowRight");await expect.poll(()=>scroll.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);}
 await capture(page,info,"named-person-cohort");await page.getByRole("button",{name:"Clear history filters",exact:true}).click();await expect(page).not.toHaveURL(/controlMine/);await expect(table.locator("tbody tr")).toHaveCount(2);
 expect(w.state.effects).toBe(0);
});

test("source-owned repair stages and missing runtime services do not become execution or activation",async({page},info)=>{
 const conflict=w.snapshot.conflicts[0]!;conflict.state="applied";conflict.receiptRef="synthetic-source-repair-receipt";
 w.state.serviceRefs=[{kind:"repairReceipt",targetId:conflict.id,receiptRef:conflict.receiptRef,sourceVersion:conflict.sourceVersion,state:"applied",observedAt:w.a.at(),sourceReadbackVersion:null,mirrorReadbackVersion:null,ownerPersonRef:"synthetic-person-one"},
  {kind:"runtimeRegistration",targetId:w.snapshot.reports[0]!.id,jobId:controlTestJob.jobId,jobVersion:1,registrationRef:"synthetic-missing-runtime",registrationVersion:1}];
 await login(page);await page.goto("/automations?tab=reconciliation");await expect(page.getByRole("heading",{name:"Source-owned repair",exact:true})).toBeVisible();
 await expect(page.getByText(/A request or write acknowledgment does not resolve the conflict/)).toBeVisible();await capture(page,info,"repair-applied-not-resolved");
 const comparison=w.snapshot.comparisons[0]!;comparison.mirrorCount=comparison.sourceCount;comparison.mirrorAmount=structuredClone(comparison.sourceAmount);conflict.state="resolved";conflict.mirrorValue=structuredClone(conflict.sourceValue);
 w.state.serviceRefs[0]={kind:"repairReceipt",targetId:conflict.id,receiptRef:conflict.receiptRef!,sourceVersion:conflict.sourceVersion,state:"resolved",observedAt:w.a.at(),sourceReadbackVersion:conflict.authoritativeVersion,mirrorReadbackVersion:conflict.mirrorVersion,ownerPersonRef:"synthetic-person-one"};
 await page.getByRole("button",{name:"Refresh source evidence",exact:true}).click();await expect(page.getByText(/The source reports a resolved incident with matching source\/mirror readback/)).toBeVisible();
 const schedule=await scheduleRoute(page);await page.goto(schedule);await expect(page.getByRole("button",{name:"Enable schedule",exact:true})).toBeDisabled();
 await expect(page.getByText(/Source evidence unavailable: OPERATIONS_SERVICE_UNCONFIGURED/)).toBeVisible();
 await page.getByLabel("Local time",{exact:true}).fill("09:15");await page.getByRole("button",{name:"Save draft",exact:true}).click();await expect(page.getByTestId("save-status")).toContainText("does not activate or change the source schedule");
 await expect(page.getByRole("button",{name:"Enable schedule",exact:true})).toBeDisabled();expect(w.state.effects).toBe(0);await capture(page,info,"saved-draft-source-runtime-unavailable");
});

test("actual runtime and admitted report services show their distinct source stages without provider delivery",async({page},info)=>{
 await w.close();const evidence=await createOperationsControlEvidenceHttpFixture();w=evidence.controls;
 await new Promise<void>((done,reject)=>{w.app.server.once("error",reject);w.app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",done);});
 await login(page);await page.goto("/automations?tab=zaps");
 await expect(page.getByRole("heading",{name:"Installed runtime registration",exact:true})).toBeVisible();
 await expect(page.getByRole("heading",{name:"Report receipt and recovery",exact:true})).toBeVisible();
 await expect(page.getByText("No confirmed delivery receipt",{exact:true})).toBeVisible();
 await expect(page.getByRole("link",{name:"Inspect runtime window",exact:true})).toBeVisible();
 await capture(page,info,"registered-runtime-and-admitted-report");
 await page.goto("/automations");await expect(page.getByRole("heading",{name:"Runtime run and takeover",exact:true})).toBeVisible();
 await page.getByRole("link",{name:"Inspect runtime recovery",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Resume from verified evidence.",exact:true})).toBeVisible();
 expect(evidence.runtime.state.sourceCalls).toBe(0);expect(evidence.reporting.state.calls).toHaveLength(0);
 await page.goto("/automations?tab=zaps");evidence.reporting.state.readAllowed=false;
 const denied=page.waitForResponse(r=>r.url().endsWith("/v1/read")&&r.request().postDataJSON()?.viewKey==="operationsControl"&&r.status()===403);
 await page.getByRole("button",{name:"Refresh source evidence",exact:true}).click();await denied;
 await expect(page.getByRole("heading",{name:"Report receipt and recovery",exact:true})).toHaveCount(0);
 await capture(page,info,"report-read-authority-withdrawn");
});

test("source denial clears protected controls on each owned view and idle person expiry clears an open draft",async({page},info)=>{
 await login(page);const schedule=await scheduleRoute(page);
 for(const [name,path]of [["connections","/settings/connections"],["team","/settings/team"],["runs","/automations"],["schedule",schedule],["capabilities","/settings/capabilities"]]){
  w.state.denied=false;renew();await page.goto(path!);await expect(page.getByRole("heading",{name:"Finite action previews",exact:true})).toBeVisible();
  w.state.denied=true;const denied=page.waitForResponse(r=>r.url().endsWith("/v1/read")&&r.request().postDataJSON()?.viewKey==="operationsControl"&&r.status()===403);
  await page.getByRole("button",{name:"Refresh source evidence",exact:true}).click();expect((await denied).status()).toBe(403);
  await expect(page.getByRole("heading",{name:"Finite action previews",exact:true})).toHaveCount(0);await expect(page.getByRole("table",{name:"Exact finite selection",exact:true})).toHaveCount(0);
  expect(await privateStorage(page)).not.toMatch(/Fictional protected operator reason|synthetic:provider-account|secretref:/);await capture(page,info,`${name}-source-denied`);
 }
 w.state.denied=false;renew();await page.goto("/automations");
 // Use the actual server's short named-person proof, not a fabricated HTTP response.
 const actor=w.a.humans.get("agent-reviewer")!;actor.validUntil=new Date(Date.now()+5000).toISOString();
 const refreshed=page.waitForResponse(r=>r.url().endsWith("/v1/read")&&r.request().postDataJSON()?.viewKey==="operationsControl"&&r.status()===200);
 await page.getByRole("button",{name:"Refresh source evidence",exact:true}).click();await refreshed;
 const openDraft=await task(page,"Fictional expiry-only protected reason");await expect(openDraft).toBeVisible();
 await expect(page.getByText(/Source authority expired/)).toBeVisible({timeout:10000});await expect(page.getByRole("heading",{name:"Finite action previews",exact:true})).toHaveCount(0);
 await expect(openDraft).toHaveCount(0);expect(await privateStorage(page)).not.toContain("Fictional expiry-only protected reason");expect(w.state.effects).toBe(0);await capture(page,info,"named-authority-expired");
});
