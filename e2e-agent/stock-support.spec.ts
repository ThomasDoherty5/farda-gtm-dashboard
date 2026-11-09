import { screenReaderCheckpoint } from "./support/screen-reader";
import { expect,test,type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync,writeFileSync } from "node:fs";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { SYNTHETIC_SCOPE,SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { stockSupportTestSource,inventorySourceFixture,supportSourceFixture,stockTestTime } from "../src/creator-agent/stockSupportFixtures.ts";

const scope={workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!,environment:"sandbox" as const};
let clock=Date.parse(stockTestTime);
let app:ReturnType<typeof createAgentServer>,stock=inventorySourceFixture(scope),support=supportSourceFixture(scope);
test.beforeEach(async({page})=>{
  clock=Date.parse(stockTestTime);await page.clock.setFixedTime(new Date(clock));stock=inventorySourceFixture(scope);support=supportSourceFixture(scope);
  app=createAgentServer({databasePath:":memory:",workspaceId:scope.workspaceId,accountId:scope.accountId,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
    operations:{now:()=>clock},stockSupportSource:stockSupportTestSource({readInventory:()=>stock,readSupport:()=>support},()=>clock)});
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve);});
});
test.afterEach(async()=>{await app.close();});
async function login(page:Page,reviewer=true){expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN)}})).ok()).toBe(true);}
test("resuming after read authority expires clears stock rows and its open evidence dialog",async({page})=>{
  await login(page);await page.goto("/inventory");
  await expect(page.getByRole("table",{name:"Inventory by location"})).toBeVisible();
  await page.getByRole("button",{name:"Open source for Home H1 / FARDA-GRAPHITE"}).click();
  await expect(page.getByRole("dialog",{name:"Position evidence"})).toBeVisible();
  await page.clock.setFixedTime(new Date(clock+15*60_000+1));
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert").filter({hasText:"Source access has expired"})).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);await expect(page.getByRole("dialog")).toHaveCount(0);
});
const stockFilter=(page:Page)=>page.getByRole("button",{name:/^(All homes|Home H[123])$/});
async function openInventory(page:Page){await page.getByRole("button",{name:"Open inventory",exact:true}).click();return page.getByRole("dialog",{name:"Inventory evidence",exact:true});}
async function fill(page:Page){
  await openInventory(page);await page.getByRole("button",{name:"Request transfer",exact:true}).click();
  const form=page.getByRole("dialog",{name:"Request transfer"});await form.getByLabel("From",{exact:true}).selectOption("H1");await form.getByLabel("To",{exact:true}).selectOption("H2");
  await form.getByLabel("Units").fill("8");await form.getByLabel("Reason").selectOption("rebalance");return form;
}
test("bounded stock drilldown, report filters and exact approval-only receipt through the native adapter",async({page})=>{
  test.setTimeout(120_000);
  await login(page);await page.goto("/inventory");const table=page.getByRole("table",{name:"Inventory by location"});
  await expect(table).toContainText("FARDA-GRAPHITE");await expect(page.getByText("Destination receipt is overdue.",{exact:false})).toBeVisible();
  await screenReaderCheckpoint(page,"stock-table-headers",page.getByRole("region",{name:"Inventory by location"}),["Inventory by location","On hand","Reserved","Available"],"KP_Enter");
  const nav=page.getByRole("navigation",{name:"Operations sections"});await expect(nav.getByRole("link",{name:"Stock",exact:true})).toHaveAttribute("aria-current","page");
  await expect(nav.getByRole("link",{name:"Support",exact:true})).toHaveAttribute("href","/support/cases/queue");await expect(nav.getByRole("link")).toHaveCount(5);
  await stockFilter(page).focus();await page.keyboard.press("Enter");
  let dlg=page.getByRole("dialog",{name:"Stock filters"});await dlg.getByLabel("Home").selectOption("H1");await dlg.getByLabel("SKU").selectOption("FARDA-GRAPHITE");await dlg.getByRole("button",{name:"Apply filters"}).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  const filtered=page.url(),history=await page.evaluate(()=>window.history.length);await nav.getByRole("link",{name:"Stock",exact:true}).click();
  expect(page.url()).toBe(filtered);expect(await page.evaluate(()=>window.history.length)).toBe(history);
  await page.getByRole("button",{name:"Open source for Home H1 / FARDA-GRAPHITE"}).click();dlg=page.getByRole("dialog",{name:"Position evidence"});
  await expect(dlg).toContainText("TEST-SH-1042");await expect(dlg).toContainText("TEST-BAL-H1");await expect(dlg.getByRole("link",{name:"Shipping hub",exact:true})).toHaveAttribute("href","/operations?view=hub");await page.keyboard.press("Escape");
  const inspect=page.getByRole("button",{name:"Open source for Home H1 / FARDA-GRAPHITE"});await expect(inspect).toBeFocused();
  await screenReaderCheckpoint(page,"stock-evidence-focus-return",inspect,["Open source","H1","button"]);
  const f=await fill(page);await f.getByLabel("Units").fill("999");
  const transfer=page.getByRole("button",{name:"Request transfer",exact:true});
  const inactiveTransfer=page.getByRole("button",{name:"Request transfer",exact:true,includeHidden:true});
  await expect(inactiveTransfer).not.toHaveAttribute("aria-describedby");
  await screenReaderCheckpoint(page,"stock-form-error",f.getByRole("button",{name:"Save proposal for review"}),["Units exceed available stock"],"KP_Enter",async()=>{
    await f.getByRole("button",{name:"Save proposal for review"}).click();await expect(f.getByRole("alert")).toHaveText("Units exceed available stock.");
  });
  await f.getByLabel("Units").fill("8");
  await screenReaderCheckpoint(page,"stock-proposal-status",transfer,["recorded for human review","No source action was executed"],"KP_Enter",async()=>{
    await f.getByRole("button",{name:"Save proposal for review"}).focus();await page.keyboard.press("Enter");
    const receipt=page.getByRole("status").filter({hasText:"recorded for human review"});
    await expect(receipt).toBeVisible();await expect(receipt).toHaveAttribute("aria-atomic","true");
    await expect(transfer).toHaveAttribute("aria-describedby",(await receipt.getAttribute("id"))!);
    await expect(transfer).toHaveAccessibleDescription((await receipt.textContent())!);
  });
  await expect(page.getByRole("status").filter({hasText:"recorded for human review"})).toBeVisible();await expect(page.getByText("Transfer proposals awaiting review")).toBeVisible();
  await expect(page.getByRole("dialog",{name:"Request transfer",exact:true})).not.toBeVisible();
  await expect(page.getByRole("button",{name:"Request transfer",exact:true})).toBeFocused();
  await transfer.click();await expect(f).toBeVisible();
  await expect(inactiveTransfer).not.toHaveAttribute("aria-describedby");
  await expect(page.getByRole("status").filter({hasText:"recorded for human review"})).toHaveCount(0);
  await f.getByRole("button",{name:"Return to record",exact:true}).click();
  await page.getByRole("button",{name:"Close evidence",exact:true}).click();await expect(page.getByRole("button",{name:"Open inventory",exact:true})).toBeFocused();
  await expect(table).toContainText("100");expect(app.store.database.prepare("SELECT count(*) n FROM stock_support_reviews WHERE status='recorded'").get()?.n).toBe(1);
  await stockFilter(page).click();dlg=page.getByRole("dialog",{name:"Stock filters"});await dlg.getByLabel("Reporting period").selectOption("prior");await dlg.getByRole("button",{name:"Apply filters"}).click();await expect(table).toContainText("FARDA-GRAPHITE-2");await expect(table).toContainText("Unknown");
});
test("safe support case, cohort denominator, reader hold and reviewer handoff without a refund or source write",async({page})=>{
  test.setTimeout(90_000);
  await login(page,false);await page.goto("/support/cases/TEST-ISS-021");await page.getByRole("button",{name:"Open source case",exact:true}).click();await expect(page.getByRole("button",{name:"Request human handoff"})).toBeDisabled();await page.getByRole("button",{name:"Close handoff",exact:true}).click();
  await expect(page.getByText("60.0%",{exact:true})).toBeVisible();await expect(page.getByText("6.0%",{exact:true})).toBeVisible();
  await screenReaderCheckpoint(page,"support-table-headers",page.getByRole("region",{name:"Handoffs that need an owner"}),["Handoffs that need an owner","Issue","Type","State","Owner"],"KP_Enter");
  await page.getByRole("button",{name:"14-day cohort"}).click();await expect(page.getByRole("dialog")).toContainText("TEST-COHORT-1");await page.keyboard.press("Escape");
  await expect(page.getByRole("button",{name:"14-day cohort"})).toBeFocused();
  await screenReaderCheckpoint(page,"support-cohort-focus-return",page.getByRole("button",{name:"14-day cohort"}),["14","cohort","button"]);
  await login(page);await page.reload();await page.getByRole("button",{name:"Open source case",exact:true}).click();await page.getByRole("button",{name:"Request human handoff"}).click();const f=page.getByRole("dialog",{name:"Request human handoff"});await f.getByLabel("Reason").selectOption("refund-review");await f.getByRole("button",{name:"Save proposal for review"}).click();
  await expect(page.getByRole("status").filter({hasText:"No source action was executed"})).toBeVisible();
  await expect(page.getByText("Local handoff proposals")).toBeVisible();expect(support.cases[0]!.state).toBe("Open");
  await page.getByRole("button",{name:"Close handoff",exact:true}).click();
  await page.getByRole("link",{name:/TEST-ISS-018/}).click();await page.getByRole("button",{name:"Open source case",exact:true}).click();await expect(page.getByText("TEST-RET-028",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Close handoff",exact:true}).click();
  const selected=page.url();await page.getByRole("navigation",{name:"Operations sections"}).getByRole("link",{name:"Support",exact:true}).click();expect(page.url()).toBe(selected);
});
test("lost post response survives reload; exact read reconciles without sending a second request",async({page})=>{
  await login(page);await page.goto("/inventory");let writes=0;
  await page.route("**/v1/action",async route=>{writes++;const applied=await route.fetch();expect(applied.status()).toBe(200);await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",executionCertainty:"uncertain"})});});
  const f=await fill(page);
  const fault=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/v1/action"&&r.status()===502);
  await f.getByRole("button",{name:"Save proposal for review"}).click();await fault;
  await expect(page.getByText("Proposal outcome unverified. Reconcile the exact request before continuing.")).toBeVisible();
  await f.getByRole("button",{name:"Return to record",exact:true}).click();await page.getByRole("button",{name:"Close evidence",exact:true}).click();
  await expect(page.getByRole("button",{name:"Reconcile exact request",exact:true})).toBeVisible();
  await expect(page.getByText("Proposal outcome unverified. Reconcile the exact request before continuing.")).toBeVisible();
  await page.reload();await openInventory(page);await expect(page.getByRole("button",{name:"Request transfer",exact:true})).toBeDisabled();await page.getByRole("button",{name:"Close evidence",exact:true}).click();await page.getByRole("button",{name:"Reconcile exact request"}).click();
  await expect(page.getByRole("status").filter({hasText:"recorded for human review"})).toBeVisible();expect(writes).toBe(1);
});
test("native stock and support desktop and mobile layout, keyboard, accessible names and complete source evidence",async({page},testInfo)=>{
  await login(page);const results=[];
  const proofDir=process.env.FARDA_STOCK_PROOF_DIR??testInfo.outputPath("stock-support-evidence");mkdirSync(proofDir,{recursive:true});
  for(const [name,path] of [["stock","/inventory"],["support","/support/cases/TEST-ISS-021"]] as const){
   for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    await page.goto(path);await expect(page.getByRole("heading",{name:name==="stock"?"Every movement leaves a trace":"Handoffs that need an owner"})).toBeVisible();
    await page.evaluate(()=>document.fonts.ready);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);expect(overflow).toBeLessThanOrEqual(0);
    const violations=(await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]).analyze()).violations;
    expect(violations.map(v=>[v.id,v.nodes.map(n=>n.target)])).toEqual([]);
    writeFileSync(proofDir+"/"+name+"-"+width+"-accessibility-tree.txt",await page.locator("main").ariaSnapshot());await page.screenshot({path:proofDir+"/"+name+"-"+width+".png",fullPage:true});
    const geometry=await page.locator("main").evaluate(main=>Array.from(main.querySelectorAll("h1,h2,h3")).map(el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return {text:el.textContent,box:[b.x,b.y,b.width,b.height],font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,lineHeight:s.lineHeight};}));
    results.push({name,width,overflow,axeViolations:violations.length,geometry});
    const b=name==="stock"?stockFilter(page):page.getByRole("button",{name:"14-day cohort"});await b.focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Escape");await expect(b).toBeFocused();
   }
  }
  writeFileSync(proofDir+"/accessibility.json",JSON.stringify(results,null,2));
});
test("dropped before service: verified absence unlocks only an exact retry and source denial clears protected data",async({page})=>{
  await login(page);await page.goto("/inventory");
  const writes:{idempotencyKey:string;expectedVersion:string;payload:unknown}[]=[];
  await page.route("**/v1/action",async route=>{
    writes.push(route.request().postDataJSON());
    if(writes.length===1){await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",executionCertainty:"uncertain"})});return;}
    await route.continue();
  });
  const f=await fill(page);const dropped=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/v1/action"&&r.status()===502);
  await f.getByRole("button",{name:"Save proposal for review"}).click();await dropped;await expect(page.getByText("Proposal outcome unverified. Reconcile the exact request before continuing.")).toBeVisible();
  expect(app.store.database.prepare("SELECT count(*) n FROM stock_support_reviews").get()?.n).toBe(0);
  await page.reload();
  // A new display filter must not hide or rebase the uncertain request's original parameters.
  await stockFilter(page).click();const changedScope=page.getByRole("dialog",{name:"Stock filters"});
  await changedScope.getByLabel("Home").selectOption("H2");await changedScope.getByRole("button",{name:"Apply filters"}).click();
  await expect(stockFilter(page)).toHaveText("Home H2");await expect(page.getByRole("table",{name:"Inventory by location"}).getByRole("row")).toHaveCount(2);
  await openInventory(page);await expect(page.getByRole("button",{name:"Request transfer",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Close evidence",exact:true}).click();await expect(page.getByRole("button",{name:"Reconcile exact request",exact:true})).toBeVisible();expect(writes).toHaveLength(1);
  stock.coverage="partial";await page.getByRole("button",{name:"Reconcile exact request"}).click();await expect(page.getByText("The exact request receipt could not be verified. Further proposals are held.")).toBeVisible();
  stock.coverage="complete";await page.getByRole("button",{name:"Reconcile exact request"}).click();await page.getByRole("button",{name:"Review original request"}).click();
  const retry=page.getByRole("dialog",{name:"Request transfer"});
  await expect(retry.getByLabel("From",{exact:true})).toHaveValue("H1");
  await expect(retry.getByLabel("From",{exact:true}).locator('option[value="H1"]')).toHaveText("H1");
  await expect(retry.getByLabel("Units")).toHaveValue("8");await expect(retry.getByLabel("To",{exact:true})).toHaveValue("H2");
  expect(writes).toHaveLength(1);
  await retry.getByLabel("From",{exact:true}).selectOption("H1");await retry.getByLabel("To",{exact:true}).selectOption("H2");await retry.getByLabel("Units").fill("7");await retry.getByLabel("Reason").selectOption("rebalance");
  await retry.getByRole("button",{name:"Save proposal for review"}).click();await expect(retry.getByRole("alert")).toContainText("original request parameters");expect(writes).toHaveLength(1);
  await retry.getByLabel("Units").fill("8");await retry.getByRole("button",{name:"Save proposal for review"}).click();await expect(page.getByRole("status").filter({hasText:"recorded for human review"})).toBeVisible();
  expect(writes).toHaveLength(2);expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);expect(writes[1]?.expectedVersion).toBe(writes[0]?.expectedVersion);expect(writes[1]?.payload).toEqual(writes[0]?.payload);
  // Once the original request is resolved, a new proposal remains restricted to the current home.
  await openInventory(page);await page.getByRole("button",{name:"Request transfer",exact:true}).click();
  const fresh=page.getByRole("dialog",{name:"Request transfer",exact:true});await expect(fresh.getByLabel("From",{exact:true})).toHaveValue("H2");
  await expect(fresh.getByLabel("From",{exact:true}).locator('option[value="H1"]')).toHaveCount(0);expect(writes).toHaveLength(2);
  stock.scope={...scope,accountId:"elsewhere"};await page.reload();await expect(page.getByRole("table",{name:"Inventory by location"})).toHaveCount(0);await expect(page.getByRole("dialog",{name:"Request transfer",exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"Reconcile exact request",exact:true})).toHaveCount(0);await expect(page.getByRole("alert").first()).toBeVisible();
});

test("a lost request for a now-historical period gets a sealed stale no-op before an intentional rebase",async({page})=>{
  await login(page);await page.goto("/inventory?windowRef=current");
  const writes:{idempotencyKey:string;expectedVersion:string;payload:unknown}[]=[];
  await page.route("**/v1/action",async route=>{
    writes.push(route.request().postDataJSON());
    if(writes.length===1){await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",executionCertainty:"uncertain"})});return;}
    await route.continue();
  });
  const form=await fill(page);const dropped=page.waitForResponse(r=>r.request().method()==="POST"&&new URL(r.url()).pathname==="/v1/action"&&r.status()===502);
  await form.getByRole("button",{name:"Save proposal for review"}).click();await dropped;await expect(page.getByText("Proposal outcome unverified. Reconcile the exact request before continuing.")).toBeVisible();
  clock=Date.parse("2026-11-05T17:00:00Z");await page.clock.setFixedTime(new Date(clock));stock.observedAt=new Date(clock).toISOString();stock.revision="stock-synthetic-2";stock.currentWindow="next";
  stock.periods.push({...structuredClone(stock.periods[0]!),window:{ref:"next",start:"2026-10-23",end:"2026-11-05"}});
  await page.reload();await page.getByRole("button",{name:"Reconcile exact request"}).click();await page.getByRole("button",{name:"Review original request"}).click();
  const retry=page.getByRole("dialog",{name:"Request transfer"});
  await expect(retry.getByLabel("Units")).toHaveValue("8");await expect(retry.getByLabel("From",{exact:true})).toHaveValue("H1");await expect(retry.getByLabel("To",{exact:true})).toHaveValue("H2");await expect(retry.getByLabel("Reason")).toHaveValue("rebalance");
  await retry.getByRole("button",{name:"Save proposal for review"}).click();
  await expect(page.getByRole("status").filter({hasText:"This exact request was rejected because its source version changed."})).toBeVisible();
  expect(writes).toHaveLength(2);expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);expect(writes[1]?.expectedVersion).toBe(writes[0]?.expectedVersion);expect(writes[1]?.payload).toEqual(writes[0]?.payload);
  expect(app.store.database.prepare("SELECT status FROM stock_support_reviews").all()).toMatchObject([{status:"rejected"}]);
  await openInventory(page);await expect(page.getByRole("button",{name:"Request transfer",exact:true})).toBeDisabled();
  await page.goto("/inventory?windowRef=next");await openInventory(page);await expect(page.getByRole("button",{name:"Request transfer",exact:true})).toBeEnabled();
});
