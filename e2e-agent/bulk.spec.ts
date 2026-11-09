import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test,expect,type Page,type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { bulkServerFixture } from "../src/creator-agent/bulk/serverFixture.testkit.ts";
import { SYNTHETIC_REVIEW_TOKEN,SYNTHETIC_READ_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import { approvalDispatchBinding } from "../src/creator-agent/approvals/repository.ts";
import type { BulkReadData } from "../src/creator-agent/bulk/views.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

let dir:string,w:ReturnType<typeof bulkServerFixture>,app:ReturnType<typeof createAgentServer>;
const port=Number(process.env.E2E_AGENT_SERVER_PORT),base=`http://127.0.0.1:${port}`;
const path=()=>`/batches/${encodeURIComponent(w.filters.batchRef)}?context=bulk&batchVersion=${encodeURIComponent(w.filters.batchVersion)}`;
const scope=()=>({workspaceId:w.scope.workspaceId,accountIds:[w.scope.accountId],environment:"sandbox"});
async function post(endpoint:string,body:unknown){const response=await fetch(base+endpoint,{method:"POST",headers:{authorization:`Bearer ${SYNTHETIC_REVIEW_TOKEN}`,"content-type":"application/json"},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}
async function read(){const r=await post("/v1/read",{schemaVersion:SCHEMA_VERSION,operation:"readView",requestId:"fictional-bulk-browser-read",requestedScope:scope(),viewKey:"batchDetail",filters:{context:"bulk",...w.filters},period:null,sort:[],page:{cursor:null,limit:100}});expect(r.status,JSON.stringify(r.body)).toBe(200);return r.body.data as BulkReadData;}
async function approve(index:number){const data=await read(),group=data.groups[index]!;const p=await post("/v1/action",{schemaVersion:SCHEMA_VERSION,operation:"previewAction",requestId:`fictional-preview-${index}`,requestedScope:scope(),actionKind:group.actionKind,entityRefs:[],expectedVersion:group.preview!.entityVersion,approvalRef:null,manifestRef:null,runRef:null,payload:group.preview,idempotencyKey:`fictional-bulk-preview-${index}`});expect(p.status,JSON.stringify(p.body)).toBe(200);
  const repo=app.actionFoundation.approvals,preview=repo.readApproval(p.body.approvalRef)!;
  const requested=await repo.requestDecision({approvalRef:preview.manifest.approvalRef,expectedVersion:preview.manifest.manifestVersion},{principalRef:"agent-reviewer"},`fictional-request-${index}`);
  const event=w.a.event(requested,"approved","synthetic:founder",`fictional-decision-${index}`);return repo.observeDecision(event.locator,{ingressRef:"fictional-verified-source"});
}
async function login(page:Page,reviewer=true){expect((await page.request.get("/v1/session",{headers:{authorization:`Bearer ${reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN}`}})).ok()).toBe(true);}
async function capture(page:Page,info:TestInfo,name:string,width:number){await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:info.outputPath(`bulk-${name}-${width}.png`),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);}
test.beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"farda-bulk-browser-"));w=bulkServerFixture(join(dir,"db.sqlite"));app=createAgentServer(w.options);await new Promise<void>(resolve=>app.server.listen(port,"127.0.0.1",resolve));});
test.afterEach(async()=>{await app.close();w.close();rmSync(dir,{recursive:true,force:true});});

test("finite membership and separately approved sample math use actual canonical readback",async({page})=>{
  await login(page);await page.goto(path());await expect(page.getByRole("table",{name:"Exact finite bulk rows"})).toBeVisible();
  await expect(page.getByRole("table",{name:"Exact finite bulk rows"}).getByRole("row")).toHaveCount(25);
  await expect(page.getByText("Unknown until separate approval proof is returned",{exact:true})).toBeVisible();
  await approve(1);await page.getByRole("button",{name:"Refresh batch evidence",exact:true}).click();
  await expect(page.getByText("12 / $300.00",{exact:true})).toBeVisible();await expect(page.getByText("12 no-new-sample rows · separate approval",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Samples",exact:true}).click();await expect(page.getByText("Approved: 12 samples / $300.00. Remaining: 12 samples / $300.00.",{exact:true})).toBeVisible();expect(w.state.calls).toHaveLength(0);
});

test("lost preview acknowledgment survives reload without a fresh key or duplicate manifest",async({page})=>{
  await login(page);await page.goto(path());const keys:string[]=[];let ref="";
  await page.route("**/v1/action",async route=>{const body=route.request().postDataJSON();if(body.operation!=="previewAction")return route.continue();keys.push(body.idempotencyKey);const response=await route.fetch();expect(response.status(),await response.text()).toBe(200);ref=(await response.json()).approvalRef;await route.abort("failed");});
  await page.getByRole("button",{name:"Preview invitation",exact:true}).click();await expect(page.getByRole("link",{name:"Review invitation approval",exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole("link",{name:"Review invitation approval",exact:true})).toHaveAttribute("href",`/approvals/${encodeURIComponent(ref)}?version=v1`);
  expect(new Set(keys).size).toBe(1);expect(w.a.db.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(1);expect(w.state.calls).toHaveLength(0);
});

test("source permission loss clears finite identities and reader cannot propose",async({page})=>{
  await login(page,false);await page.goto(path());await expect(page.getByRole("button",{name:"Preview invitation",exact:true})).toBeDisabled();
  await login(page);await page.reload();await expect(page.getByRole("button",{name:"Preview invitation",exact:true})).toBeEnabled();
  w.state.denied=true;await page.getByRole("button",{name:"Refresh batch evidence",exact:true}).click();await expect(page.getByRole("alert").filter({hasText:"No access"})).toBeVisible();await expect(page.getByRole("table",{name:"Exact finite bulk rows"})).toHaveCount(0);expect(w.state.calls).toHaveLength(0);
});

test("original run controls cancel only unsent canonical rows; batch never claims external reversal",async({page})=>{
  const approved=await approve(0);const intents=approved.manifest.items.map(item=>({approval:approvalDispatchBinding(approved.manifest,item.itemRef),handlerRef:"bulk.invitation.v1",payloadRef:approved.manifest.draft.payloadRef}));
  const run=await app.actionFoundation.dispatch.handoffBatch(intents,{principalRef:"agent-reviewer",idempotencyKey:"fictional-bulk-handoff"});
  await login(page);await page.goto(path());await page.getByRole("button",{name:"Capacity",exact:true}).click();
  await expect(page.getByRole("link",{name:"Open original run controls",exact:true})).toHaveAttribute("href",`/runs/${encodeURIComponent(run.runRef)}?tab=recovery`);
  await page.getByRole("link",{name:"Open original run controls",exact:true}).click();await expect(page).toHaveURL(/\/runs\//);
  expect(w.state.calls).toHaveLength(0);expect(app.actionFoundation.dispatch.read(run.runRef,false).run.items.every(i=>i.state==="queued")).toBe(true);
});

test("complete bulk frame at three widths, keyboard row inspection and actual screen-reader evidence",async({page},info)=>{
  test.setTimeout(150_000);await approve(1);await login(page);await page.goto(path());await expect(page.getByText("12 / $300.00",{exact:true})).toBeVisible();
  for(const width of [1440,1024,390])await capture(page,info,"complete",width);
  const axe=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();expect(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  await page.setViewportSize({width:1440,height:1000});const trigger=page.getByRole("button",{name:"Inspect row",exact:true}).first();await trigger.focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog",{name:"Exact row evidence"})).toBeVisible();await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
  await screenReaderCheckpoint(page,"bulk-row-dialog-focus-return",trigger,["Inspect row","button"]);
  await screenReaderCheckpoint(page,"bulk-finite-row-table",page.getByRole("region",{name:"Exact finite bulk rows"}),["Exact finite bulk rows","Recipient","All blockers"],"KP_Enter");
});
