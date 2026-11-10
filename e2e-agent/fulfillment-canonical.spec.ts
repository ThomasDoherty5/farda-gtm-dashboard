import { screenReaderCheckpoint } from "./support/screen-reader.ts";
import AxeBuilder from "@axe-core/playwright";
import { expect,test,type Page,type TestInfo } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { fulfillmentFixture } from "../src/creator-agent/fulfillmentDomain/fixtures.testkit.ts";
import { fulfillmentPreviewAction,type FulfillmentKind,type FulfillmentPreviewAction } from "../src/creator-agent/fulfillmentDomain/contract.ts";
import { OperationsReadError } from "../src/creator-agent/operationsReads/source.ts";
import { operationsSnapshot,operationsTestSource } from "../src/creator-agent/operationsReads/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

// Fictional source plans; browser requests traverse the real HTTP, SQLite and canonical J04 services.
// No provider grant, worker execution, shipment, stock movement or refund is enabled.
let app:ReturnType<typeof createAgentServer>|undefined;
let fixture:ReturnType<typeof fulfillmentFixture>|undefined;
const reason="Fictional inspection requires exact source review";
const pathFor=(kind:FulfillmentKind)=>kind==="returnTask"?"/returns/TEST-RET-028":"/shipments/TEST-SP-0093/exceptions/TEST-EVT-129";
const titleFor=(kind:FulfillmentKind)=>kind==="returnTask"?"Prepare the source return plan":"Record the next step";
test.afterEach(async()=>{if(app)await app.close();app=undefined;fixture?.close();fixture=undefined;});

async function setup(page:Page,kind:FulfillmentKind){
  const f=fulfillmentFixture(kind);fixture=f;
  await page.clock.install({time:f.a.state.now});
  const human=structuredClone(f.a.humans.get(f.principal.principalRef)!);
  f.a.humans.set("agent-reviewer",{...human,principalRef:"agent-reviewer"});
  f.a.humans.set("agent-reader",{...human,principalRef:"agent-reader",roles:["viewer"]});
  const operationsSource=operationsTestSource(async(_scope,request)=>{
    if(f.state.denied)throw new OperationsReadError("SOURCE_AUTHORITY_DENIED",403);
    const snapshot=operationsSnapshot(request.viewKey),record=snapshot.record;
    // The source owns these public target references; the UI never derives an action identity from a display ID.
    if(request.viewKey==="returnDetail"||request.viewKey==="shippingException")record.proposalTargetRef=f.filters.targetRef;
    record.provenance={...(record.provenance as object),observedAt:f.a.at()};
    return {...snapshot,scope:f.scope,observedAt:f.a.at(),validUntil:f.a.until(),record};
  });
  const server=createAgentServer({databasePath:":memory:",workspaceId:f.scope.workspaceId,accountId:f.scope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:()=>f.a.state.now},
    operationsReadSource:operationsSource,fulfillment:{source:f.source,owners:f.bindings.owners},
    actionFoundation:{approvals:{sources:f.a.sources,currentPolicy:f.a.options.currentPolicy}}});app=server;
  await new Promise<void>((resolve,reject)=>{server.server.once("error",reject);server.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve);});
  expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN}})).ok()).toBe(true);
  return {f,server,count:()=>Number(server.store.database.prepare("SELECT COUNT(*) AS n FROM approval_manifests").get()?.n??0),
    intentCount:()=>Number(server.store.database.prepare("SELECT COUNT(*) AS n FROM fulfillment_proposal_intents").get()?.n??0)};
}
async function openPlan(page:Page,kind:FulfillmentKind){
  await page.getByRole("button",{name:kind==="returnTask"?"Prepare browser task":"Record next step",exact:true}).click();
  const dialog=page.getByRole(kind === "returnTask" ? "region" : "dialog",{name:titleFor(kind),exact:true});
  await expect(dialog).toBeVisible();return dialog;
}
async function choosePlan(page:Page,kind:FulfillmentKind){
  const dialog=await openPlan(page,kind);
  await expect(dialog.getByLabel("Exact source plan",{exact:true})).toBeVisible();
  if(kind==="returnTask"){
    await dialog.getByLabel("Inspected quantity",{exact:true}).selectOption("1");
    await dialog.getByLabel("Disposition",{exact:true}).selectOption("restock");
  }
  await dialog.getByLabel("Resolution",{exact:true}).selectOption("refund");
  await dialog.getByLabel("Exact source plan",{exact:true}).selectOption({label:"Review exact refund plan"});
  await dialog.getByLabel("Reason",{exact:true}).fill(reason);
  await expect(dialog.getByText("Remaining refundable",{exact:true})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"Preview exact source plan",exact:true})).toBeEnabled();
  return dialog;
}
async function capture(page:Page,info:TestInfo,name:string){
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({path:info.outputPath(`${name}.png`),fullPage:true,animations:"disabled"});
  const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
  expect(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
}
async function safeMarker(page:Page){
  const values=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.includes("native-fulfillment-preview-v1")).map(([,value])=>JSON.parse(value) as Record<string,unknown>));
  expect(values).toHaveLength(1);expect(Object.keys(values[0]!).sort()).toEqual(["kind","planRef","requestKey","targetRef","version"]);
  // Test-only inspection of browser storage: neither the reason nor a derived reason digest is persisted.
  // eslint-disable-next-line no-restricted-globals
  expect(await page.evaluate(()=>JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)]))).not.toContain(reason);
  return values[0]!;
}

for(const kind of ["shippingDecision","returnTask"] as const){
  test(`${kind} previews one exact source plan through real HTTP and canonical J04 without business effects`,async({page},info)=>{
    const w=await setup(page,kind);const sent:FulfillmentPreviewAction[]=[];
    page.on("request",request=>{if(new URL(request.url()).pathname==="/v1/action")sent.push(fulfillmentPreviewAction.parse(request.postDataJSON()));});
    await page.goto(pathFor(kind));const dialog=await choosePlan(page,kind);
    await capture(page,info,`${kind}-source-plan`);
    await screenReaderCheckpoint(page, `${kind}-canonical-plan-preview`, dialog.getByRole("button", {name:"Preview exact source plan",exact:true}), ["Preview exact source plan"]);
    await dialog.getByRole("button",{name:"Preview exact source plan",exact:true}).click();
    const approval=dialog.getByRole("link",{name:"Review exact approval manifest",exact:true});await expect(approval).toBeVisible();
    await expect.poll(w.count).toBe(1);expect(w.intentCount()).toBe(1);expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({...w.f.filters,reason});expect(sent[0]?.entityRefs).toEqual([]);
    expect(sent[0]?.approvalRef).toBeNull();expect(sent[0]?.manifestRef).toBeNull();
    const marker=await safeMarker(page);expect(marker).toMatchObject({requestKey:sent[0]!.idempotencyKey,version:sent[0]!.expectedVersion,planRef:sent[0]!.payload.planRef});
    const saved=w.server.store.database.prepare("SELECT body FROM approval_manifests").get()!;
    const manifest=JSON.parse(String(saved.body)) as {approvalRef:string;draft:{sourceBasisRef:string;payloadRef:string;bounds:{maxSpendMinor:number;maxUnits:number};actionKind:string}};
    expect(manifest.draft.actionKind).toBe(kind==="returnTask"?"fulfillment.returnTask":"fulfillment.shippingDecision");
    expect(manifest.draft.payloadRef).toBe(manifest.draft.sourceBasisRef);expect(manifest.draft.bounds).toMatchObject({maxSpendMinor:3499,maxUnits:0});
    // A test-only authenticated reviewer request must reach the duplicate-plan fence, not fail the browser CSRF boundary first.
    const repeated=await page.request.post("/v1/action",{headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN},data:{...sent[0]!,requestId:"fresh-key-negative",idempotencyKey:"another-browser-key"}});
    expect(repeated.status()).toBe(409);expect((await repeated.json()).code).toBe("FULFILLMENT_PLAN_ALREADY_PROPOSED");expect(w.count()).toBe(1);
    await screenReaderCheckpoint(page, `${kind}-canonical-approval-handoff`, approval, ["Review exact approval manifest"]);
    await approval.click();await expect(page.getByRole("table",{name:"Exact approved manifest",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Queue selected approved items",exact:true})).toBeDisabled();
    expect(w.f.state.effects).toBe(0);
    await info.attach(`${kind}-provenance`,{contentType:"application/json",body:JSON.stringify({evidenceStage:"synthetic-native-source",transport:"actual HTTP",approvalStore:"canonical J04 SQLite",manifests:w.count(),intents:w.intentCount(),providerEffects:w.f.state.effects})});
  });

  test(`${kind} recovers a lost acknowledgement after reload using only the original key and current permission`,async({page},info)=>{
    const w=await setup(page,kind),sent:FulfillmentPreviewAction[]=[];
    await page.route("**/v1/action",async route=>{
      const input=fulfillmentPreviewAction.parse(route.request().postDataJSON());sent.push(input);
      const response=await route.fetch();expect(response.status()).toBe(200);
      // The canonical service committed. Lose only its browser acknowledgement, never replace its response with mock data.
      await route.abort("failed");
    });
    await page.goto(pathFor(kind));const dialog=await choosePlan(page,kind);
    await dialog.getByRole("button",{name:"Preview exact source plan",exact:true}).click();
    await expect.poll(w.count).toBe(1);await expect.poll(()=>sent.length).toBe(1);const marker=await safeMarker(page),ownerReads=w.f.state.ownerReads;
    w.f.state.version="fictional-source-next-revision";
    await page.reload();const recovered=await openPlan(page,kind);
    await expect(recovered.getByRole("status").filter({hasText:"Original request: recorded."})).toBeVisible();
    await expect(recovered.getByRole("link",{name:"Review exact approval manifest",exact:true})).toBeVisible();
    await expect(recovered.getByRole("button",{name:/Preview exact source plan|Retry original preview/})).toHaveCount(0);
    expect(await safeMarker(page)).toEqual(marker);expect(sent).toHaveLength(1);expect(w.count()).toBe(1);expect(w.intentCount()).toBe(1);
    expect(w.f.state.ownerReads).toBe(ownerReads);expect(w.f.state.effects).toBe(0);
    await capture(page,info,`${kind}-original-recovered`);
    await screenReaderCheckpoint(page, `${kind}-original-recovery-control`, recovered.getByRole("button", {name:"Check original request",exact:true}), ["Check original request"]);
    w.f.state.denied=true;
    await recovered.getByRole("button",{name:"Check original request",exact:true}).click();
    await expect(page.getByRole("link",{name:"Review exact approval manifest",exact:true})).toHaveCount(0);
    await expect(page.getByText("Remaining refundable",{exact:true})).toHaveCount(0);
    const denied=await page.request.post("/v1/read",{data:{schemaVersion:sent[0]!.schemaVersion,operation:"readView",requestId:"fictional-denied-recovery",requestedScope:sent[0]!.requestedScope,
      viewKey:"fulfillmentProposal",filters:{...w.f.filters,requestKey:marker.requestKey},period:null,sort:[],page:{cursor:null,limit:50}}});
    expect(denied.status()).toBe(403);expect(await denied.json()).not.toHaveProperty("data");
    expect(sent).toHaveLength(1);expect(w.count()).toBe(1);expect(w.f.state.effects).toBe(0);
  });
}
