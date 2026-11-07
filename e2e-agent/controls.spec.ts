import {expect,test,type Page} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {mkdirSync,writeFileSync} from "node:fs";
import {capabilityIdForBinding} from "../src/creator-agent/connections/ledger.ts";
import {unknownBusinessEligibility,unknownSourceFreshness,type ExpectedBinding,type VerificationReceipt} from "../src/creator-agent/connections/schema.ts";
import {healthBindingDigest,type HealthObservation} from "../src/creator-agent/providerHealth.ts";
import {createAgentServer} from "../src/creator-agent/server.ts";
import {createOperationsControlHttpFixture} from "../src/creator-agent/operationsControlHttp.testkit.ts";
import {OperationsControlError} from "../src/creator-agent/operationsControls.ts";
import {controlSourceFixture,controlTestJob,controlTestTime} from "../src/creator-agent/operationsControlsFixtures.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN,SYNTHETIC_SCOPE} from "../src/creator-agent/testFixtures.ts";
const scope={workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!,environment:"sandbox" as const};
let app:ReturnType<typeof createAgentServer>,source=controlSourceFixture(scope),denied=false,probeCalls=0,denyDuringProbe=false;
let canonical:ReturnType<typeof createOperationsControlHttpFixture>|undefined;
function setDenied(value:boolean){denied=value;if(canonical)canonical.state.denied=value;}
function renew(){canonical?.refreshClock();}
const healthBinding:ExpectedBinding={...scope,provider:"notion",providerAccountId:"synthetic-native-account",action:"observe",mode:"observe",route:"api",routeRef:"route:synthetic",authorizationScopeVersion:"v1",toolVersion:"v1",requiredScopes:["read"],connectionRef:"connection:synthetic",secretRef:"secretref:synthetic"};
const healthReceipt:VerificationReceipt={receiptRef:"receipt:synthetic",binding:healthBinding,outcome:"Ready",checkedAt:controlTestTime,expiresAt:"2026-11-06T12:10:00Z",verifiedScopes:["read"],connectionHealth:"Authenticated",sourceFreshness:unknownSourceFreshness(),businessEligibility:unknownBusinessEligibility(),reasonCodes:[]};
const healthObservation:HealthObservation={bindingDigest:healthBindingDigest(healthBinding),checkedAt:controlTestTime,status:"observed",permission:"allowed",session:"authenticated",roleScopePlan:"verified",coverage:"complete",sourceLastSuccess:controlTestTime,sourceUpdatedAt:controlTestTime,mirrorUpdatedAt:null,quotaState:"not_applicable",quotaRemaining:null,deadlineState:"not_applicable",deadline:null};
// Playwright requires a destructured fixture argument before testInfo.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async({},info)=>{
 const healthCase=info.title.startsWith("health observation");probeCalls=0;denyDuringProbe=false;
 source=controlSourceFixture(scope);denied=false;canonical=undefined;
 if(!healthCase){canonical=createOperationsControlHttpFixture({}, {repair:true});app=canonical.app;source=canonical.snapshot;renew();}
 else{app=createAgentServer({databasePath:":memory:",...scope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
  operations:{now:()=>Date.parse(controlTestTime),resolveReceipt:()=>healthReceipt,resolveJobActivation:r=>({approved:true,decisionRef:r.decisionRef,definitionHash:r.definitionHash})},
   providerHealth:{now:()=>Date.parse(controlTestTime),activationRef:"activation:synthetic",catalog:healthCase?[{binding:healthBinding,ownerRef:"owner:synthetic",documentationRef:"docs:synthetic",documentationCheckedAt:controlTestTime,maxAgeSeconds:60,freshnessBasis:"successful_read",probe:async()=>{probeCalls++;if(denyDuringProbe)denied=true;return structuredClone(healthObservation);}}]:[]},operationsControlSource:{read:async()=>{if(denied)throw new OperationsControlError("SOURCE_SCOPE_DENIED",403);return structuredClone(source);}}});
 app.operations.jobs.register(controlTestJob,0);}
 if(healthCase){const id=capabilityIdForBinding(healthBinding);app.operations.ledger.register({binding:healthBinding,ownerRef:"owner:synthetic",costBasis:{state:"unknown",reasonCode:"UNKNOWN"}},0);await app.operations.ledger.verify(id,healthReceipt.receiptRef,1);}
 await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve);});
});
test.afterEach(async()=>{if(canonical)await canonical.close();else await app.close();});
async function login(page:Page,reviewer=true){expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN)}})).ok()).toBe(true);}
async function task(page:Page){
 await page.getByRole("button",{name:"Request task",exact:true}).first().click();
 const chooser=page.getByRole("dialog",{name:"Choose a registered task"});await expect(chooser).toContainText("Daily evidence review task");
 await chooser.getByRole("button",{name:"Draft Daily evidence review task"}).click();
 const form=page.getByRole("dialog",{name:"Request task",exact:true});await form.getByLabel("Reason").fill("Synthetic operator reason");return form;
}
test("native finite task preview produces one exact canonical preview and no job execution",async({page})=>{
 await login(page);await page.goto("/automations");const form=await task(page);
 await expect(form.getByRole("table",{name:"Exact finite selection"})).toBeVisible();await form.getByRole("button",{name:"Create approval preview"}).focus();await page.keyboard.press("Enter");
 await expect(page.getByRole("link",{name:"Open exact approval preview"})).toBeVisible();
 expect(app.store.database.prepare("SELECT count(*) n FROM operations_control_requests").get()?.n).toBe(1);
 expect(app.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);
 await page.reload();await expect(page.getByRole("table",{name:"Immutable application intent receipts"})).toContainText("Synthetic operator reason");
 await page.getByRole("button",{name:"Inspect original request",exact:true}).click();await expect(page.getByRole("link",{name:"Open exact approval preview"})).toBeVisible();expect(canonical!.state.effects).toBe(0);
});
test("team roles and source authority clear on a denied reread, then recover from a fresh permitted read",async({page})=>{
 await login(page,false);await page.goto("/settings/team");await expect(page.getByRole("heading",{name:"Who can do what"})).toBeVisible();
 await expect(page.getByRole("table",{name:"Team & permissions source evidence"})).toContainText("Registered provider");
 await page.getByRole("button",{name:"Inspect evidence",exact:true}).click();await expect(page.getByRole("dialog")).toContainText("Unknown");await page.keyboard.press("Escape");
 setDenied(true);const response=page.waitForResponse(r=>r.url().endsWith("/v1/read")&&r.status()===403);
 await page.getByRole("button",{name:"Refresh source evidence"}).click();await response;
 await expect(page.getByRole("heading",{name:"Who can do what"})).toHaveCount(0);await expect(page.getByRole("table",{name:"Team & permissions source evidence"})).toHaveCount(0);
 setDenied(false);await page.reload();await expect(page.getByRole("heading",{name:"Who can do what"})).toBeVisible();
});
for(const applied of [false,true])test("uncertain task "+(applied?"after commit":"before service")+" preserves only a safe marker across reload",async({page})=>{
 await login(page);await page.goto("/automations");const form=await task(page);const writes:unknown[]=[];
 await page.route("**/v1/action",async route=>{
  writes.push(route.request().postDataJSON());if(writes.length===1){
   if(applied){const response=await route.fetch();expect(response.ok()).toBe(true);}
   await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",message:"Synthetic dropped receipt",executionCertainty:"uncertain",retryable:false,requestId:"synthetic",correlationId:null,retryAfterMs:null})});
  }else await route.continue();
 });
 const response=page.waitForResponse(r=>r.url().endsWith("/v1/action")&&r.status()===503);
 await form.getByRole("button",{name:"Create approval preview"}).click();await response;
 await expect(page.getByRole("status").filter({hasText:"Proposal outcome is unverified"})).toBeVisible();expect(writes).toHaveLength(1);
 expect(app.store.database.prepare("SELECT count(*) n FROM operations_control_requests").get()?.n).toBe(applied?1:0);
 expect(await page.evaluate(()=>JSON.stringify(Object.entries(sessionStorage)))).not.toContain("Synthetic operator reason");
 await page.reload();await expect(page.getByRole("region",{name:"Unverified review request"})).toBeVisible();
 await page.getByRole("button",{name:"Reconcile exact request"}).click();
 if(applied){await expect(page.getByRole("link",{name:"Open exact approval preview"})).toBeVisible();expect(writes).toHaveLength(1);}
 else{
  await expect(page.getByRole("status").filter({hasText:"original request remains held"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Review original request"})).toHaveCount(0);
  expect(writes).toHaveLength(1);expect(app.store.database.prepare("SELECT count(*) n FROM operations_control_requests").get()?.n).toBe(0);
 }
});
test("same-session stale original request retries its protected draft once and seals a no-op",async({page})=>{
 await login(page);await page.goto("/automations");const form=await task(page);const keys:string[]=[];
 await page.route("**/v1/action",async route=>{keys.push(route.request().postDataJSON().idempotencyKey);if(keys.length===1)await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",message:"Synthetic dropped request",executionCertainty:"uncertain",retryable:false})});else await route.continue();});
 const response=page.waitForResponse(r=>r.url().endsWith("/v1/action")&&r.status()===503);await form.getByRole("button",{name:"Create approval preview"}).click();await response;
 await expect(page.getByRole("status").filter({hasText:"Proposal outcome is unverified"})).toBeVisible();await page.keyboard.press("Escape");source.revision="new-source-version";
 await page.getByRole("button",{name:"Reconcile exact request"}).click();await page.getByRole("button",{name:"Review original request"}).click();
 const original=page.getByRole("dialog",{name:"Review original request"});await expect(original.getByLabel("Reason")).toHaveValue("Synthetic operator reason");await original.getByRole("button",{name:"Create approval preview"}).click();
 await expect(page.getByRole("status").filter({hasText:"sealed as not applied"})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(app.store.database.prepare("SELECT json_extract(receipt,'$.state') state FROM operations_control_requests").get()?.state).toBe("rejected");
 expect(await page.evaluate(()=>JSON.stringify(Object.entries(sessionStorage)))).not.toContain("Synthetic operator reason");
});
test("protected task reason is purged after source denial without discarding its safe uncertain marker",async({page})=>{
 await login(page);await page.goto("/automations");const form=await task(page);let writes=0;
 await page.route("**/v1/action",async route=>{writes++;await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",message:"Synthetic dropped request",executionCertainty:"uncertain",retryable:false})});});
 const response=page.waitForResponse(r=>r.url().endsWith("/v1/action")&&r.status()===503);await form.getByRole("button",{name:"Create approval preview"}).click();await response;await expect(page.getByRole("status").filter({hasText:"Proposal outcome is unverified"})).toBeVisible();await page.keyboard.press("Escape");
 expect(await page.evaluate(()=>JSON.stringify(Object.entries(sessionStorage)))).not.toContain("Synthetic operator reason");
 setDenied(true);const lost=page.waitForResponse(r=>r.url().endsWith("/v1/read")&&r.status()===403);await page.getByRole("button",{name:"Refresh source evidence"}).click();await lost;
 await expect(page.getByRole("region",{name:"Unverified review request"})).toHaveCount(0);
 setDenied(false);await page.getByRole("link",{name:"Connections",exact:true}).click();await page.getByRole("link",{name:"Agent runs",exact:true}).click();
 await page.getByRole("button",{name:"Reconcile exact request"}).click();await expect(page.getByRole("status").filter({hasText:"original request remains held"})).toBeVisible();
 await expect(page.getByRole("button",{name:"Review original request"})).toHaveCount(0);expect(writes).toBe(1);
});
test("nightly comparison preserves money dimensions, local-owned fields and canonical repair previews",async({page})=>{
 await login(page);await page.goto("/automations?tab=reconciliation");
 await page.getByRole("button",{name:"Inspect evidence"}).first().click();const detail=page.getByRole("dialog");
 await expect(detail).toContainText("2500 minor USD");await expect(detail).toContainText("UTC");await page.keyboard.press("Escape");
 await page.getByRole("button",{name:"Request repair",exact:true}).click();const form=page.getByRole("dialog",{name:"Request repair",exact:true});
 await form.getByLabel("Reason").fill("Synthetic repair review");await form.getByRole("button",{name:"Create approval preview"}).click();
 await expect(page.getByRole("link",{name:"Open exact approval preview"})).toBeVisible();expect(source.conflicts[0]!.state).toBe("open");expect(canonical!.state.effects).toBe(0);
 source.conflicts[0]!.ownership="local";await page.getByRole("button",{name:"Refresh source evidence"}).click();
 await expect(page.getByRole("button",{name:"Request repair",exact:true})).toBeDisabled();
});
test("health observation lost acknowledgment recovers the exact original check across reload without another probe",async({page})=>{
 await login(page);await page.goto("/settings/connections");await page.getByRole("button",{name:"Check connections",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"Check registered connections"});await expect(dialog.getByRole("button",{name:"Check notion",exact:true})).toBeEnabled();
 let writes=0;const keys:string[]=[];await page.route("**/v1/action",async route=>{const body=route.request().postDataJSON();expect(body.operation).toBe("refreshObservation");expect(body.runRef??null).toBeNull();expect(Object.keys(body.payload)).toEqual(["targetRef"]);keys.push(body.idempotencyKey);writes++;if(writes===1){const r=await route.fetch();expect(r.ok()).toBe(true);await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",message:"Synthetic lost health receipt",executionCertainty:"uncertain",retryable:false,requestId:"synthetic",correlationId:null,retryAfterMs:null})});}else await route.continue();});
 const response=page.waitForResponse(r=>r.url().endsWith("/v1/action")&&r.status()===503);await dialog.getByRole("button",{name:"Check notion",exact:true}).click();await response;
 await expect(page.getByRole("status").filter({hasText:"Health-check outcome remains unverified"})).toBeVisible();expect(probeCalls).toBe(1);
 await page.reload();await page.getByRole("button",{name:"Reconcile health check",exact:true}).click();
 await expect(page.getByRole("status").filter({hasText:"A health observation was recorded"})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(probeCalls).toBe(1);
});
test("health observation source403 after commit retains the original request across access clearing and reload",async({page})=>{
 await login(page);await page.goto("/settings/connections");await page.getByRole("button",{name:"Check connections",exact:true}).click();
 const keys:string[]=[];page.on("request",r=>{if(r.url().endsWith("/v1/action"))keys.push(r.postDataJSON().idempotencyKey);});denyDuringProbe=true;
 const response=page.waitForResponse(r=>r.url().endsWith("/v1/action")&&r.status()===403);
 await page.getByRole("dialog",{name:"Check registered connections"}).getByRole("button",{name:"Check notion",exact:true}).click();
 const deniedResponse=await response;expect((await deniedResponse.json()).executionCertainty).toBe("applied");expect(probeCalls).toBe(1);
 await expect(page.getByRole("table",{name:"Connection controls source evidence"})).toHaveCount(0);
 await page.reload();await expect(page.getByRole("button",{name:"Check connections",exact:true})).toBeDisabled();
 await expect(page.getByRole("button",{name:"Reconcile health check",exact:true})).toHaveCount(0);
 denied=false;denyDuringProbe=false;await page.reload();await page.getByRole("button",{name:"Reconcile health check",exact:true}).click();
 await expect(page.getByRole("status").filter({hasText:"A health observation was recorded"})).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(probeCalls).toBe(1);
});
test("native five-screen keyboard, desktop and mobile accessible evidence",async({page},testInfo)=>{
 await login(page);const proof=[];const dir=process.env.FARDA_CONTROLS_PROOF_DIR??testInfo.outputPath("controls-evidence");mkdirSync(dir,{recursive:true});
 await page.goto("/automations?tab=zaps");const schedule=await page.getByRole("link",{name:/schedule draft/}).getAttribute("href");expect(schedule).toBeTruthy();
 const routes=[["connections","/settings/connections"],["team","/settings/team"],["runs","/automations"],["schedule",schedule!],["capabilities","/settings/capabilities"]];
 for(const [name,route] of routes)for(const width of [1440,390]){
  await page.setViewportSize({width,height:width===390?844:1000});await page.goto(route!);
  renew();await page.reload();await expect(page.locator("section").filter({has:page.getByRole("heading",{name:"Finite action previews",exact:true})}).last()).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
  const violations=(await new AxeBuilder({page:page as never}).analyze()).violations.map(v=>v.id);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(violations).toEqual([]);expect(overflow).toBe(false);
  await page.screenshot({path:dir+"/"+name+"-"+width+".png",fullPage:true});proof.push({name,route,width,height:width===390?844:1000,violations,overflow});
 }
 await page.goto("/settings/capabilities");await page.getByRole("button",{name:"Plan validation",exact:true}).focus();await page.keyboard.press("Enter");
 await expect(page.getByRole("dialog",{name:"Plan validation"})).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Plan validation",exact:true})).toBeFocused();
 writeFileSync(dir+"/accessibility.json",JSON.stringify(proof,null,2));
});
