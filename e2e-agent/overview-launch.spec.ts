import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { nativeAnalyticsFixture } from "../src/creator-agent/analytics/nativeFixtures.testkit.ts";
import { addReservationFixture } from "../src/creator-agent/analytics/reservations.testkit.ts";
import { controlSourceFixture, controlSourceProvider } from "../src/creator-agent/operationsControlsFixtures.ts";
import { approvalFixture, approvalTestScope } from "../src/creator-agent/approvals/fixtures.testkit.ts";
import { actionDomainFixture } from "../src/creator-agent/actions/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";

async function start(app:ReturnType<typeof createAgentServer>, page:Page, reviewer=false) {
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve);});
  expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN)}})).ok()).toBe(true);
}
async function capture(page:Page,info:TestInfo,name:string) {
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
    expect(audit.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:info.outputPath(`overview-launch-${name}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
}

test("launch snapshot reads existing report schedules and cohort reservation provenance without activation",async({page},info)=>{
  test.setTimeout(240000);
  const analytics=nativeAnalyticsFixture({now:Date.now,principalRef:"agent-reader"});
  analytics.state.mutate=s=>{s.validUntil=new Date(Date.now()+600000).toISOString();for(const owner of s.owners)owner.validUntil=s.validUntil;addReservationFixture(s);};
  const report=controlSourceFixture(analytics.scope),at=new Date().toISOString();
  report.observedAt=at;report.roles=[];report.tasks=[];report.comparisons=[];report.conflicts=[];report.attribution=[];
  report.reports[0]!.observedAt=at;
  let allowed=true;
  const source=controlSourceProvider(()=>report,Date.now,()=>allowed);
  const app=createAgentServer({databasePath:":memory:",workspaceId:analytics.scope.workspaceId,accountId:analytics.scope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,analyticsSource:analytics.source,
    operationsControlSource:{...source,async read(binding,signal){const result=await source.read(binding,signal) as {authority:{validUntil:string}};result.authority.validUntil=new Date(Date.now()+600000).toISOString();return result;}}});
  const writes:string[]=[];page.on("request",r=>{if(r.method()==="POST"&&!r.url().endsWith("/v1/read"))writes.push(r.url());});
  try {
    await start(app,page);await page.goto("/launch");
    await expect(page.getByTestId("launch-date")).toHaveText("L is not set");
    const schedule=page.getByRole("region",{name:"Report scheduling",exact:true}).last();
    await expect(schedule.getByRole("table")).toContainText("weekdays");await expect(schedule).toContainText("America/Los_Angeles");
    await expect(schedule).toContainText("draft");await capture(page,info,"snapshot-report");
    const manage=schedule.getByRole("link",{name:"Manage reports with the source owner"});
    await screenReaderCheckpoint(page,"launch-report-owner-link",manage,["Manage reports with the source owner","link"]);
    await manage.click();await expect(page).toHaveURL(/tab=reporting/);await expect(page.getByRole("region",{name:"Report evidence evidence and review controls"})).toContainText("weekdays");
    await page.goto("/campaigns/campaign-current?tab=funnel&cohort=first-wave");
    const trigger=page.getByRole("button",{name:"Review reservations",exact:true});await trigger.click();
    const dialog=page.getByRole("dialog",{name:"Sample reservations",exact:true});await expect(dialog).toContainText("Fictional sample bottle");
    await expect(dialog).toContainText("$30.00");await expect(dialog).toContainText("approved");
    await expect(dialog).toContainText("do not deplete physical stock");await capture(page,info,"reservations");
    await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
    await screenReaderCheckpoint(page,"launch-reservation-focus-return",trigger,["Review reservations","button"]);
    allowed=false;await page.goto("/launch");await expect(page.getByRole("heading",{name:"No access to this account"})).toBeVisible();
    await expect(page.getByRole("table",{name:"Reporting"})).toHaveCount(0);
    allowed=true;await page.reload();await expect(page.getByRole("region",{name:"Report scheduling",exact:true}).last()).toContainText("weekdays");
    expect(writes).toEqual([]);
  } finally {await app.close();}
});

test("launch task evidence and proposed-date inputs retain source identity, keyboard return and unset L",async({page},info)=>{
  test.setTimeout(180000);
  const a=approvalFixture(),d=actionDomainFixture(1),now=Date.now();a.state.now=now;d.tick(now-d.now());
  a.humans.set("agent-reviewer",{...structuredClone(a.humans.get("synthetic:requester")!),principalRef:"agent-reviewer",roles:["founder"],observedAt:a.at(),validUntil:a.until()});
  d.source.scope=approvalTestScope;d.source.observedAt=a.at();d.source.validUntil=a.until();d.source.launchDate=null;d.source.launchDateApproved=false;
  d.source.presentation={evidenceStage:"synthetic",recordRef:d.source.targetRef,recordVersion:d.source.version,recordUrl:null,dateProposalUrl:null,timezone:"America/Los_Angeles",
    sampleAcceptance:{state:"verified",evidenceRef:d.source.evidenceRefs[0]!,version:"fictional-acceptance-v1",observedAt:d.source.observedAt}};
  d.source.gates[0]!.presentation={label:"Product qualification",owner:"Fictional product owner",dueRelative:"L − 7",taskUrl:null,evidenceUrl:null};
  const app=createAgentServer({databasePath:":memory:",workspaceId:approvalTestScope.workspaceId,accountId:approvalTestScope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:()=>a.state.now},
    actionFoundation:{approvals:{sources:a.sources,registry:a.options.registry,currentPolicy:a.options.currentPolicy},readiness:d.readiness,readinessTargetRef:d.source.targetRef}});
  try {
    await start(app,page,true);await page.goto("/launch?view=control");await expect(page.getByText("Launch date is not set",{exact:true})).toBeVisible();
    await expect(page.getByText("Fictional product owner",{exact:true})).toBeVisible();await capture(page,info,"control");
    const trigger=page.getByRole("button",{name:"Inspect evidence for gate 1"});await trigger.click();
    await expect(page.getByRole("dialog",{name:"Launch gate evidence"})).toContainText("Verified source navigation is unavailable");
    await capture(page,info,"gate-proof");await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
    await screenReaderCheckpoint(page,"launch-gate-focus-return",trigger,["Inspect evidence for gate 1","button"]);
    const date=page.getByLabel("Proposed L",{exact:true});await date.fill("2027-02-30");await page.getByRole("button",{name:"Open date proposal"}).click();
    await expect(page.getByText("Enter a real calendar date, or leave it unset.")).toBeVisible();
    await date.fill("2027-03-01");await page.getByLabel("Reason / evidence",{exact:true}).fill("Fictional acceptance review");
    await page.getByRole("button",{name:"Open date proposal"}).click();await expect(page.getByRole("status").filter({hasText:"This local draft has not been submitted"})).toBeVisible();
    await expect(page.getByText("Launch date is not set",{exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"Open verified date-approval workflow"})).toHaveCount(0);
    expect(d.state.writes).toBe(0);
  } finally {await app.close();a.db.close();}
});
