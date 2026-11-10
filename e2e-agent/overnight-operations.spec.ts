import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";
import { POLICY_VERSION } from "../src/creator-agent/assessmentSchema.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";

const port=Number(process.env.E2E_AGENT_SERVER_PORT);
const scope={workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!,environment:"sandbox" as const};
let app:ReturnType<typeof createAgentServer>, now:number;
test.beforeEach(async()=>{
  now=Date.parse("2027-03-13T12:00:00Z");
  app=createAgentServer({databasePath:":memory:",...scope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:()=>now}});
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(port,"127.0.0.1",resolve);});
});
test.afterEach(async()=>{if(app)await app.close();});
async function signIn(page:Page, reviewer=false) {
  expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN)}})).ok()).toBe(true);
}
function seedJob() {
  const job={jobId:"sample-private-job",version:1,ownerRef:"synthetic-owner",mode:"observe",handler:"record-reference.v1",eventType:"sample-event",
    inputSchemaVersion:"job-reference-batch.v1",outputSchemaVersion:"job-local-result.v1",policyVersion:POLICY_VERSION,modelVersion:null,offerVersion:null,capabilityBinding:null,
    budgets:{maxItems:1,maxSteps:2,maxAttempts:1,maxRunMs:60000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0}} as const;
  app.operations.jobs.register(job,0); return job;
}
test("loads the next real ledger page, resets a filtered scan, recovers an expired cursor and clears records on auth loss",async({page,context})=>{
  const job=seedJob();
  for(let i=0;i<26;i++){now+=1000;app.operations.jobs.ingest({schemaVersion:"job-reference-batch.v1",jobId:job.jobId,jobVersion:1,eventId:"event-"+i,eventAt:null,eventType:job.eventType,
    items:[{itemKey:"item-"+i,subjectRef:"sample",evidenceRef:null}]},"ingress-"+i);}
  await signIn(page); await page.goto("/automations");
  const panel=page.getByTestId("saved-runs");await expect(panel).toContainText("Showing 25 of 26 saved runs");
  const read=await page.request.post("/v1/read",{data:{schemaVersion:SCHEMA_VERSION,operation:"readView",viewKey:"automationRuns",requestId:"paged-test-read",
    requestedScope:SYNTHETIC_SCOPE,filters:{},sort:[],period:null,page:{limit:50,cursor:null}}});
  expect(read.ok()).toBe(true);const target=(await read.json()).data.records[25].id as string;
  await page.getByRole("button",{name:"Load more"}).click();await expect(panel).toContainText("Showing 26 of 26 saved runs");
  await page.getByRole("button",{name:"Inspect run"}).last().click();await expect(page.getByRole("dialog")).toContainText(target);await page.keyboard.press("Escape");
  await page.getByLabel("Search saved runs").fill(target);
  await expect(panel).toContainText("No displayed runs match");await expect(panel).toContainText("Showing 25 of 26");
  now+=16*60000;await page.getByRole("button",{name:"Load more"}).click();await expect(page.getByRole("button",{name:"Restart list"})).toBeVisible();
  await page.getByRole("button",{name:"Restart list"}).click();await expect(page.getByRole("button",{name:"Load more"})).toBeVisible();
  await page.getByRole("button",{name:"Load more"}).click();await expect(panel).toContainText(target);await expect(panel).toContainText("Showing 26 of 26");
  await page.getByRole("button",{name:"Clear filters"}).click();await expect(panel).toContainText("Showing 25 of 26");
  await context.clearCookies(); await page.getByRole("button",{name:"Load more"}).click();
  const denials=page.getByRole("heading",{name:"Sign in again"});
  await expect(denials).toHaveCount(2); // Both independently scoped readers lose their grant.
  await expect(denials.nth(0)).toBeVisible();
  await expect(page.getByRole("region",{name:"Task and recovery controls",exact:true}).getByRole("heading",{name:"Sign in again"})).toBeVisible();
  await expect(panel).toHaveCount(0);
});
test("opens a registered job, saves and reloads its draft, preserves a conflicting edit, and keeps execution disabled",async({page,browser})=>{
  seedJob();await signIn(page,true);await page.goto("/automations?tab=zaps");await page.getByRole("link",{name:/schedule draft/}).click();
  const editor=page.getByTestId("schedule-settings");await expect(editor).toContainText("suggested values have not been saved");
  await page.getByLabel("Local time").fill("02:30");await page.getByRole("button",{name:"Save draft"}).click();
  await expect(page.getByTestId("save-status")).toContainText("Saved draft j1-d1");await page.reload();
  await expect(page.getByLabel("Local time")).toHaveValue("02:30");await expect(page.getByRole("button",{name:"Enable schedule"})).toBeDisabled();
  await page.getByLabel("Local time").fill("05:00");
  const otherContext=await browser.newContext({baseURL:process.env.E2E_AGENT_APP_PORT ? "http://127.0.0.1:"+process.env.E2E_AGENT_APP_PORT:undefined});
  try {
    const second=await otherContext.newPage(); await signIn(second,true); await second.goto(page.url());await second.getByLabel("Local time").fill("06:00");
    await second.getByRole("button",{name:"Save draft"}).click();await expect(second.getByTestId("save-status")).toContainText("Saved draft j1-d2");
    await page.getByRole("button",{name:"Save draft"}).click();await expect(page.getByText("Review your edits against the current saved draft.")).toBeVisible();
    await expect(page.getByLabel("Local time")).toHaveValue("05:00");await expect(editor).toContainText("06:00");
    await page.getByRole("button",{name:"Keep edits on current version"}).click();await page.getByRole("button",{name:"Save draft"}).click();
    await expect(page.getByTestId("save-status")).toContainText("Saved draft j1-d3");await expect(page.locator("main")).not.toContainText("sample-private-job");
  } finally {await otherContext.close();}
});

test("checks keyboard draft save, desktop and mobile viewport overflow, and accessible native schedule controls",async({page})=>{
  seedJob();await signIn(page,true);await page.goto("/automations?tab=zaps");await page.getByRole("link",{name:/schedule draft/}).click();
  await page.getByLabel("Local time").fill("09:15");const save=page.getByRole("button",{name:"Save draft"});await save.focus();
  await expect(save).toBeFocused();await page.keyboard.press("Enter");await expect(page.getByTestId("save-status")).toContainText("j1-d1");
  const directory=".handoff/figma/overnight-ops";mkdirSync(directory,{recursive:true});
  const checks = [];
  for(const [width,height] of [[1440,1000],[375,812]] as const){
    await page.setViewportSize({width,height});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>window.scrollTo(0,0));
    const rendered=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
    expect(rendered.document).toBe(rendered.viewport);
    const audit=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]).analyze();
    expect(audit.violations.map(v=>v.id)).toEqual([]);
    await page.screenshot({path:directory+"/native-schedule-"+width+"x"+height+".png"});
    checks.push({width,height,rendered,violations:audit.violations.map(v=>v.id)});
  }
  writeFileSync(directory+"/native-schedule-accessibility.json",JSON.stringify(checks,null,2));
});
