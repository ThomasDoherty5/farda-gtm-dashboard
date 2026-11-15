import {expect,test,type Page,type TestInfo} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {createAgentServer} from "../src/creator-agent/server.ts";
import {mirrorTestApproval,mirrorTestBindings,mirrorTestCompletion,mirrorTestSource,mirrorTestScope,mirrorTestNow} from "../src/creator-agent/mirrorFreshnessTestFixtures.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN} from "../src/creator-agent/testFixtures.ts";
import {screenReaderCheckpoint} from "./support/screen-reader.ts";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";

// Actual authenticated service and SQLite. All source records/receipts are fictional.
let app:ReturnType<typeof createAgentServer>,source:ReturnType<typeof mirrorTestSource>,clock:number;
test.beforeEach(async({page})=>{
  clock=mirrorTestNow;source=mirrorTestSource();await page.clock.install({time:clock});
  app=createAgentServer({databasePath:":memory:",...mirrorTestScope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
    operations:{now:()=>clock},mirrorFreshness:{source:source.source,approval:mirrorTestApproval,bindings:mirrorTestBindings}});
  await new Promise<void>((done,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",done);});
  for(const [id,outcome,ago,changed] of [["orders","complete",10,2],["shipments","complete",10,0],["stock","complete",90,1],
    ["support","partial",5,0],["finance","failed",5,0],["content","accessRevoked",5,0]] as const)
    await app.mirrorRuntime!.ingest(source.add(mirrorTestCompletion(id,outcome,clock-ago*60_000,changed)));
  app.mirrorRuntime!.sweep();
  expect((await page.request.get("/v1/session",{headers:{authorization:`Bearer ${SYNTHETIC_READ_TOKEN}`}})).status()).toBe(200);
});
test.afterEach(async()=>{await app?.close();});
async function capture(page:Page,info:TestInfo,state:string){
  const dir=info.outputPath("mirror-freshness-evidence");mkdirSync(dir,{recursive:true});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===1440?1000:844});await page.evaluate(()=>document.fonts.ready);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
    expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:join(dir,`${state}-${width}.png`),fullPage:true});
  }
  writeFileSync(join(dir,`${state}-provenance.json`),JSON.stringify({state,sourceNode:"7:876",synthetic:true,providerEffects:0,originalMediaIncluded:false,scope:"Actual authenticated HTTP, fictional complete-run receipts",comparison:"Native source-state adaptation, no blanket pixel parity claim"},null,2));
}
test("mirror states match inspected coverage, run receipts and actual accessible controls",async({page},info)=>{
  test.setTimeout(150_000);await page.goto("/settings/connections");
  const panel=page.getByTestId("mirror-freshness");await expect(panel).toContainText("Schedule: Unconfigured");
  for(const [id,label] of [["orders","Current"],["shipments","No change"],["stock","Stale"],["support","Partial"],["finance","Error"],["content","Access revoked"],["collaborations","Never synced"]])
    await expect(page.getByTestId(`mirror-state-${id}`)).toHaveText(label);
  await capture(page,info,"all-source-states");
  const inspect=page.getByRole("button",{name:"Inspect Stock freshness",exact:true});
  await screenReaderCheckpoint(page,"mirror-stock-inspection-control",inspect,["Inspect Stock freshness","button"]);
  await inspect.focus();await page.keyboard.press("Enter");
  const dialog=page.getByRole("dialog",{name:"Stock freshness",exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText("90 minutes");
  await dialog.getByRole("button",{name:/Inspect run synthetic-run-stock/}).click();
  await expect(dialog.getByRole("region",{name:"Mirror run trace"})).toContainText("1 of 1");await expect(dialog).toContainText("synthetic-receipt-stock");
  await screenReaderCheckpoint(page,"mirror-source-evidence-dialog",dialog.getByRole("button",{name:"Close",exact:true}),["Close","button"]);
  await capture(page,info,"complete-run-evidence");
  await page.keyboard.press("Escape");await expect(inspect).toBeFocused();
  clock+=60_000;await page.clock.fastForward(60_000);await app.mirrorRuntime!.ingest(source.add(mirrorTestCompletion("stock","complete",clock,0)));
  await page.getByRole("button",{name:"Refresh freshness",exact:true}).click();await expect(page.getByTestId("mirror-state-stock")).toHaveText("No change");
  // Read refresh cannot fake a sweep or clear an incident by itself.
  await inspect.click();await expect(page.getByRole("dialog")).toContainText("Open stale incident");await page.keyboard.press("Escape");
  clock+=900_000;app.mirrorRuntime!.sweep();await page.clock.fastForward(900_000);
  await expect(page.getByTestId("mirror-state-stock")).toHaveText("Unknown");
  await page.getByRole("button",{name:"Refresh freshness",exact:true}).click();await expect(page.getByTestId("mirror-state-stock")).toHaveText("No change");
  await inspect.click();await expect(page.getByRole("dialog")).not.toContainText("Open stale incident");
  await capture(page,info,"complete-recovery");
});
test("expired observations withhold current badges; source read failures and denial never become healthy",async({page},info)=>{
  await page.goto("/settings/connections");await expect(page.getByTestId("mirror-state-orders")).toHaveText("Current");
  await page.clock.fastForward(900_001);await expect(page.getByTestId("mirror-state-orders")).toHaveText("Unknown");
  await page.route("**/v1/read",route=>route.request().postDataJSON().viewKey==="mirrorFreshness"?route.fulfill({status:503,json:{code:"SOURCE_UNCONFIGURED",message:"Synthetic source unavailable",requestId:null,correlationId:null,retryable:false,retryAfterMs:null}}):route.continue());
  await page.getByRole("button",{name:"Refresh freshness",exact:true}).click();await expect(page.getByTestId("mirror-state-orders")).toHaveText("Unknown");
  await capture(page,info,"observation-unavailable");
  await page.unroute("**/v1/read");
  await page.route("**/v1/read",route=>route.request().postDataJSON().viewKey==="mirrorRunDetail"?route.fulfill({status:403,json:{code:"FORBIDDEN",message:"Synthetic access revoked",requestId:null,correlationId:null,retryable:false,retryAfterMs:null}}):route.continue());
  await page.getByRole("button",{name:"Inspect Orders freshness",exact:true}).click();
  await page.getByRole("button",{name:/Inspect run synthetic-run-orders/}).click();
  await expect(page.getByText("synthetic-receipt-orders",{exact:false})).toHaveCount(0);
  await expect(page.getByTestId("mirror-state-orders")).toHaveCount(0);
});
