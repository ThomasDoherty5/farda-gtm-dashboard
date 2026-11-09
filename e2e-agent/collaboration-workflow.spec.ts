import { expect,test,type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {mkdirSync,writeFileSync} from "node:fs";
import {createAgentServer} from "../src/creator-agent/server.ts";
import {SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN,SYNTHETIC_SCOPE} from "../src/creator-agent/testFixtures.ts";
import {collaborationTestSource,collaborationSnapshot,collabTestAt,collabTestId} from "../src/creator-agent/collaborationWorkflowFixtures.ts";

const port=Number(process.env.E2E_AGENT_SERVER_PORT);
let app:ReturnType<typeof createAgentServer>, source=collaborationSnapshot();
test.beforeEach(async({page})=>{
  await page.clock.setFixedTime(new Date(collabTestAt));
  source=collaborationSnapshot();source.scope={workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!,environment:"sandbox"};
  app=createAgentServer({databasePath:":memory:",workspaceId:source.scope.workspaceId,accountId:source.scope.accountId,readToken:SYNTHETIC_READ_TOKEN,
    reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:()=>Date.parse(collabTestAt)},collaborationSourceReader:collaborationTestSource(id=>id===collabTestId?source:null)});
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(port,"127.0.0.1",resolve);});
});
test.afterEach(async()=>{if(app)await app.close();});
async function signIn(page:Page,reviewer=true){expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN)}})).ok()).toBe(true);}
test("resuming after read authority expires clears collaboration content and the unsent draft",async({page})=>{
  await signIn(page);await page.goto("/collaborations/"+collabTestId+"?tab=content");
  await page.getByRole("button",{name:"Request revision"}).click();
  const form=page.getByRole("dialog",{name:"Request revision"});await form.getByLabel("Reason").fill("Fictional unsent revision");
  await page.clock.setFixedTime(new Date(Date.parse(collabTestAt)+15*60_000+1));
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert").filter({hasText:"Source access has expired"})).toBeVisible();
  await expect(page.getByRole("region",{name:"Content review"})).toHaveCount(0);await expect(form).toHaveCount(0);
  expect(app.store.database.prepare("SELECT COUNT(*) AS n FROM collaboration_review_requests").get()?.n).toBe(0);
});
test("source-owned content and separate rights/publication gates, immutable reviewer proposal and reload",async({page})=>{
  await signIn(page);await page.goto("/collaborations/"+collabTestId+"?tab=content");
  const content=page.getByRole("region",{name:"Content review"});
  await expect(content).toContainText("submission-v2");await expect(content).toContainText("No grant receipt");await expect(content).toContainText("Native-confirmed slot");
  await expect(page.getByRole("button",{name:/^publish$/i})).toHaveCount(0);
  await page.getByRole("button",{name:"Request revision"}).click();
  const dialog=page.getByRole("dialog",{name:"Request revision"});await dialog.getByLabel("Reason").fill("Revise the source caption");
  await dialog.getByRole("button",{name:"Return to source record"}).click();await page.getByRole("dialog",{name:"Discard proposal edits?"}).getByRole("button",{name:"Keep editing"}).click();
  await expect(dialog.getByLabel("Reason")).toHaveValue("Revise the source caption");
  await dialog.getByRole("button",{name:"Save proposal for approval"}).focus();await page.keyboard.press("Enter");
  
  await expect(page.getByRole("status").filter({hasText:"is recorded for human approval"})).toBeVisible();
  await page.reload();const proposals=page.getByRole("region",{name:"Proposals awaiting approval"});
  await expect(proposals).toContainText("1 of 1");await proposals.locator("summary").click();
  await expect(proposals).toContainText("Revise the source caption");await expect(proposals).toContainText("agent-reviewer");
  await expect(content).toContainText("No grant receipt");await expect(content).toContainText("Unverified");
});
function storedProposalCounts() {
  return app.store.database.prepare(`SELECT
    (SELECT COUNT(*) FROM collaboration_review_proposals) AS proposals,
    (SELECT COUNT(*) FROM collaboration_review_requests) AS receipts`).get();
}
async function submitAndWaitForUncertainResponse(page:Page) {
  // The pending marker is persisted before CSRF or the POST. Wait for the injected fault and for the client to settle.
  const [fault] = await Promise.all([
    page.waitForResponse(response => response.request().method()==="POST" && new URL(response.url()).pathname==="/v1/action" && response.status()===502),
    page.getByRole("dialog",{name:"Request revision"}).getByRole("button",{name:"Save proposal for approval"}).click(),
  ]);
  expect(await fault.json()).toMatchObject({code:"OUTCOME_UNCERTAIN",executionCertainty:"uncertain"});
  await expect(page.getByText("Proposal outcome unverified. Read the exact request receipt again before continuing.")).toBeVisible();
}
test("uncertain proposal outcome survives dialog close, full reload and failed reread; native source confirmation releases the hold",async({page})=>{
  await signIn(page);await page.goto("/collaborations/"+collabTestId+"?tab=content");
  let actionCount=0;
  await page.route("**/v1/action",async route=>{
    actionCount++;const actual=await route.fetch();expect(actual.ok()).toBe(true);
    await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",message:"Unconfirmed test response",executionCertainty:"uncertain"})});
  });
  await page.getByRole("button",{name:"Request revision"}).click();
  const dialog=page.getByRole("dialog",{name:"Request revision"});await dialog.getByLabel("Reason").fill("Check the exact revision");
  await submitAndWaitForUncertainResponse(page);
  expect(actionCount).toBe(1);
  expect(storedProposalCounts()).toMatchObject({proposals:1,receipts:1});
  await expect(page.getByText("An unresolved proposal is holding new requests for this collaboration.")).toBeVisible();
  await dialog.getByRole("button",{name:"Return to source record"}).click();
  await expect(page.getByRole("button",{name:"Request revision"})).toBeDisabled();await page.reload();
  await expect(page.getByRole("button",{name:"Request revision"})).toBeDisabled();
  await page.route("**/v1/read",async route=>{
    const body=route.request().postDataJSON();
    if(body.viewKey==="collaborationDetail"){await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({code:"INTEGRATION_PENDING",message:"Test source unavailable",retryable:false})});}
    else await route.continue();
  });
  await page.getByRole("button",{name:"Reconcile saved proposal"}).click();
  await expect(page.getByRole("button",{name:"Request revision"})).toBeDisabled();expect(actionCount).toBe(1);
  await page.unroute("**/v1/read");await page.reload();await page.getByRole("button",{name:"Reconcile saved proposal"}).click();
  await expect(page.getByRole("status").filter({hasText:"is recorded for human approval"})).toBeVisible();expect(actionCount).toBe(1);
  expect(storedProposalCounts()).toMatchObject({proposals:1,receipts:1});
});
test("an absent exact receipt permits only the original key and payload after reload",async({page})=>{
  await signIn(page);await page.goto("/collaborations/"+collabTestId+"?tab=content");
  const writes:{idempotencyKey:string;expectedVersion:string;payload:unknown}[]=[];
  await page.route("**/v1/action",async route=>{
    writes.push(route.request().postDataJSON());
    if(writes.length===1){await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({code:"OUTCOME_UNCERTAIN",message:"Dropped before service",executionCertainty:"uncertain"})});return;}
    await route.continue();
  });
  await page.getByRole("button",{name:"Request revision"}).click();
  const dialog=page.getByRole("dialog",{name:"Request revision"});await dialog.getByLabel("Reason").fill("Keep this exact caption");
  await submitAndWaitForUncertainResponse(page);
  expect(writes).toHaveLength(1);
  expect(storedProposalCounts()).toMatchObject({proposals:0,receipts:0});
  await expect(page.getByText("An unresolved proposal is holding new requests for this collaboration.")).toBeVisible();await page.reload();
  await page.getByRole("button",{name:"Reconcile saved proposal"}).click();
  const original=page.getByLabel("Original proposal reason");await expect(original).toBeVisible();
  await original.fill("A different caption");await page.getByRole("button",{name:"Retry original request"}).click();
  await expect(page.getByText("Enter the original proposal reason to retry this exact request.")).toBeVisible();expect(writes).toHaveLength(1);
  await original.fill("Keep this exact caption");await page.getByRole("button",{name:"Retry original request"}).click();
  await expect(page.getByRole("status").filter({hasText:"is recorded for human approval"})).toBeVisible();
  expect(storedProposalCounts()).toMatchObject({proposals:1,receipts:1});
  expect(writes).toHaveLength(2);expect(writes[1]).toMatchObject({idempotencyKey:writes[0]!.idempotencyKey,expectedVersion:writes[0]!.expectedVersion,payload:writes[0]!.payload});
});
test("reader-only, voluntary and empty states; native desktop/mobile accessibility and geometry",async({page})=>{
  source.terms={...source.terms,posting:"voluntary",due:null,graceDays:null,observationUntil:"2026-11-10"};
  source.suppression={state:"suppressed",sourceRef:"synthetic-opt-out"};
  await signIn(page,false);await page.goto("/collaborations/"+collabTestId);
  await expect(page.getByText("Voluntary posting has no deadline.",{exact:false})).toBeVisible();
  await expect(page.getByRole("button",{name:"Request human review"})).toBeDisabled();await expect(page.getByRole("button",{name:"Propose posting reminder"})).toHaveCount(0);
  const dir=".handoff/figma/collaboration-review";mkdirSync(dir,{recursive:true});const checks=[];
  for(const tab of ["overview","content"]){await page.goto("/collaborations/"+collabTestId+"?tab="+tab);
    for(const [width,height]of [[1440,1000],[375,812]] as const){await page.setViewportSize({width,height});await page.evaluate(()=>document.fonts.ready);
      const geometry=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      expect(geometry.document).toBe(geometry.viewport);
      const audit=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]).analyze();
      expect(audit.violations.map(x=>x.id)).toEqual([]);await page.screenshot({path:dir+"/native-"+tab+"-"+width+".png",fullPage:true});
      checks.push({tab,width,height,geometry,violations:audit.violations.map(x=>x.id)});
    }
  }writeFileSync(dir+"/native-accessibility.json",JSON.stringify(checks,null,2));
  await page.goto("/collaborations/not-recorded");await expect(page.getByRole("heading",{name:"Record not found"})).toBeVisible();await expect(page.locator("main")).not.toContainText("Synthetic creator agreement");
});
