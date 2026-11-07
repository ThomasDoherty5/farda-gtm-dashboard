import AxeBuilder from "@axe-core/playwright";
import { mkdirSync,writeFileSync } from "node:fs";
import { expect,test,type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { digest } from "../src/creator-agent/config.ts";
import { monitorFixture,monitorScope } from "../src/creator-agent/monitor/fixtures.testkit.ts";
import { MonitorError } from "../src/creator-agent/monitor/reader.ts";
import { intakeInputSchema,type SinkBinding,type SinkReceipt } from "../src/creator-agent/intake/contract.ts";
import type { CanonicalRecord } from "../src/creator-agent/intake/repository.ts";
import { SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

function sink(name:string){
  const records=new Map<string,SinkReceipt>();
  return {upsert:(key:string,_record:CanonicalRecord,binding:SinkBinding)=>{
    const receipt:SinkReceipt={...binding,state:"applied",receiptRef:name+":"+key,observedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600_000).toISOString()};
    records.set(key,receipt);return receipt;
  },read:(key:string,binding:SinkBinding)=>records.get(key)??{...binding,state:"notApplied",terminal:true,receiptRef:"fence:"+binding.attemptId,observedAt:new Date().toISOString()}};
}
async function seedIntake(page:Page){
  const at=new Date().toISOString(),ref={source:"notion",accountId:monitorScope.accountId,sourceId:"campaign-a",url:null,canonicalId:"campaign-a",
    identityState:"resolved",provenanceRef:"synthetic-campaign-proof"};
  const input=intakeInputSchema.parse({campaignRef:ref,briefRef:{ref:"synthetic-brief",version:"v1"},recruitmentSource:"social-cat",trigger:"signup",
    eventId:"synthetic-monitor-signup",sourceCandidate:{...ref,source:"social-cat",accountId:"synthetic-recruit-account",sourceId:"candidate-a",canonicalId:null,
      identityState:"unresolved",provenanceRef:"synthetic-signup-receipt"},profileRefs:[{source:"instagram",accountId:"publishing-a",sourceId:"profile-a",url:null,
        canonicalId:null,identityState:"unresolved",provenanceRef:"synthetic-native-profile",handle:"test.maker",sourceUpdatedAt:at}],occurredAt:at,observedAt:at,
    publishingNetworks:["instagram"],identityMapVersion:"map-v1",suppressionVersion:"suppression-v1",cursor:null});
  const key="synthetic-monitor-intake";
  const answer=await page.request.post("/v1/intake",{headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN,"Idempotency-Key":key},data:{input,
    envelope:{jobId:"J01",jobVersion:"creator-intake.v1",mode:"observe",actor:{id:"synthetic-reviewer",role:"reviewer"},accountRef:{workspaceId:monitorScope.workspaceId,accountId:monitorScope.accountId},
      policyVersion:"commission-only-v1",inputHash:digest(input),idempotencyKey:key,correlationId:"corr-299",requestedAt:at,deadline:null,checkpoint:null}}});
  const body=await answer.json();
  expect(answer.ok(),JSON.stringify(body)).toBe(true);return body;
}
test("all four real monitor reads preserve source scope, zero, identity, restart and attribution without contacting a provider",async({page},testInfo)=>{
  test.setTimeout(95_000);
  const s=monitorFixture(Date.now()),dir=process.env.FARDA_MONITOR_PROOF_DIR??testInfo.outputPath("monitor-evidence");mkdirSync(dir,{recursive:true});
  let denied=false;
  const app=createAgentServer({databasePath:":memory:",workspaceId:monitorScope.workspaceId,accountId:monitorScope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,monitorSource:async()=>{
      if(denied)throw new MonitorError("FORBIDDEN",403);return structuredClone(s);
    },intakeAuthority:{route:()=>"Ready",crosswalk:()=>({version:"map-v1",entries:[]}),suppression:()=>({version:"suppression-v1",entries:[]}),
      sinks:{"notion-creator-crm":sink("synthetic-notion"),"sheets-watchlist":sink("synthetic-sheets")}}});
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve);});
  try{
    const body=await seedIntake(page),record=body.data??body;
    const creator=record.creatorRef?.canonicalId ?? record.creatorRef?.sourceId;
    expect(typeof creator).toBe("string");
    s.members[0]!.creatorId=creator;s.posts[0]!.creatorId=creator;s.runs[0]!.checks[0]!.creatorId=creator;
    const confirmed=record.handoffs as {target:string;receiptRef:string;state:string}[];
    expect(confirmed.every(h=>h.state==="confirmed")).toBe(true);
    s.members[0]!.notionReceipt=confirmed.find(h=>h.target==="notion-creator-crm")!.receiptRef;
    s.members[0]!.sheetsReceipt=confirmed.find(h=>h.target==="sheets-watchlist")!.receiptRef;
    s.members[0]!.verification!.sheetsCanonicalReceipt=s.members[0]!.notionReceipt;
    // The canonical revision comes from the scoped J01 readback, not a lucky fixture version.
    const crm=await page.request.get("/v1/intake/creators/"+encodeURIComponent(creator),{headers:{authorization:"Bearer "+SYNTHETIC_READ_TOKEN}});
    const crmData=await crm.json();s.members[0]!.revision=(crmData.data??crmData).revision;
    expect(s.members[0]!.revision).toBeGreaterThan(0);
    expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+SYNTHETIC_READ_TOKEN}})).ok()).toBe(true);
    const audit:unknown[]=[];
    const capture=async(name:string,heading:string)=>{
      await expect(page.getByRole("heading",{name:heading,level:1})).toBeVisible();
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
        const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
        expect(result.violations.map(v=>v.id)).toEqual([]);
        await page.screenshot({path:`${dir}/native-${name}-${width}.png`,fullPage:true});
        audit.push({name,width,violations:result.violations.map(v=>v.id)});
      }
    };
    await page.goto("/content");
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).toContainText("inaccessible");
    await capture("content","Creator content, without the blind spots.");
    await page.getByLabel("Post network").selectOption("instagram");
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).not.toContainText("inaccessible");
    await page.getByRole("link",{name:"View latest hourly run"}).focus();await page.keyboard.press("Enter");
    await expect(page.getByRole("region",{name:"Read-only run trace"})).toContainText("loginRequired");
    await expect(page.getByRole("button",{name:"Retry failed profile"})).toHaveAttribute("aria-disabled","true");
    await capture("hourly","Every hourly check leaves evidence.");
    await page.goto("/creators/watchlist");
    await expect(page.getByRole("region",{name:"Canonical creator and profile evidence"})).toContainText("test.maker");
    await expect(page.getByRole("region",{name:"Canonical creator and profile evidence"})).toContainText("Current Sheets enrollment matches");
    await capture("watchlist","Know who the agent is watching.");
    await page.goto("/content?network=tiktok");const table=page.getByRole("region",{name:"Saved campaign posts"});
    await table.getByRole("link").first().click();
    await expect(page.getByText("creator-level outcomes",{exact:true})).toBeVisible();
    await expect(page.getByText(/No share is assigned/)).toBeVisible();
    await expect(page.getByRole("button",{name:"Open source post"})).toHaveAttribute("aria-disabled","true");
    await capture("post","One post. Its evidence and impact.");
    await page.reload();await expect(page.getByText(/No share is assigned/)).toBeVisible();
    denied=true;await page.goto("/content");
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).toHaveCount(0);
    await expect(page.getByRole("alert").first()).toBeVisible();
    denied=false;s.coverage="partial";await page.reload();
    await expect(page.getByRole("status").filter({hasText:"Partial source coverage"})).toBeVisible();
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).toContainText("inaccessible");
    s.coverage="complete";s.posts=[];await page.reload();
    await expect(page.getByText("No matching saved campaign posts. Provider-wide post count is unknown.")).toBeVisible();
    writeFileSync(dir+"/native-browser-proof.json",JSON.stringify({audit,source:"Actual local agent service and SQLite with scoped synthetic J01/J08 authority",externalActions:0},null,2));
  }finally{await app.close();}
});
