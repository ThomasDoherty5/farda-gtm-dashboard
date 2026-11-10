import { screenReaderCheckpoint } from "./support/screen-reader";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync,writeFileSync } from "node:fs";
import { expect,test,type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { digest } from "../src/creator-agent/config.ts";
import { addMonitorReviewEvidence,monitorTestSource,monitorFixture,monitorScope } from "../src/creator-agent/monitor/fixtures.testkit.ts";
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
  test.setTimeout(180_000);
  const s=monitorFixture(Date.now()),dir=process.env.FARDA_MONITOR_PROOF_DIR??testInfo.outputPath("monitor-evidence");mkdirSync(dir,{recursive:true});
  let denied=false;
  const app=createAgentServer({databasePath:":memory:",workspaceId:monitorScope.workspaceId,accountId:monitorScope.accountId,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,monitorSource:monitorTestSource(()=>{if(denied)throw new MonitorError("FORBIDDEN",403);return s;}),intakeAuthority:{route:()=>"Ready",crosswalk:()=>({version:"map-v1",entries:[]}),suppression:()=>({version:"suppression-v1",entries:[]}),
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
      const required:Record<string,string[]>={content:["Content finding its audience.","Keep every creator in view.","Posts worth paying attention to.","New posts. New replies. A clear next step.","Know where a number comes from."],watchlist:["The sheet is the tracking registry","Every signup enters a clear queue","What the agent needs to know"],hourly:["Checkpointed, source by source","Hourly policy","Observed events stay separate from inferred status"],post:["Views gained since publication","Known, sourced and traceable","Sales require an order match","The conversation explains the next step"]};
      for(const title of required[name]??[])await expect(page.getByRole("heading",{name:title,exact:true})).toBeVisible();
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
        // Full-page screenshots preserve a sticky header's current viewport offset.
        // Baseline original-frame comparison must start at the document top.
        await page.evaluate(async()=>{window.scrollTo(0,0);await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
        expect(await page.evaluate(()=>window.scrollY)).toBe(0);
        if(width===1440){
          expect((await page.getByTestId("source-workspace").boundingBox())?.width).toBe(132);
          if(name==="content")expect((await page.getByTestId("coverage-intake-state").boundingBox())?.width).toBe(252);
          if(name.startsWith("post"))expect((await page.getByTestId("post-publication-state").boundingBox())?.width).toBe(200);
        }
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
        const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
        expect(result.violations.map(v=>v.id)).toEqual([]);
        await page.screenshot({path:`${dir}/native-${name}-${width}.png`,fullPage:true});
        const geometry=await page.locator("main").evaluate(main=>Array.from(main.querySelectorAll("h1,h2,h3")).map(el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return {text:el.textContent,box:[b.x,b.y,b.width,b.height],font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,lineHeight:s.lineHeight};}));
        audit.push({name,width,violations:result.violations.map(v=>v.id),geometry});
      }
    };
    await page.goto("/content");
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).toContainText("inaccessible");
    await capture("content","Creator content, without the blind spots.");
    await screenReaderCheckpoint(page,"monitor-table-headers",page.getByRole("region",{name:"Saved campaign posts"}),["Saved campaign posts","Post","Network","Views"],"KP_Enter");
    await page.getByRole("button",{name:"All post networks",exact:true}).click();
    const networkFilter=page.getByRole("dialog",{name:"Filter by post network"});
    await networkFilter.getByRole("radio",{name:"Instagram",exact:true}).check();
    await networkFilter.getByRole("button",{name:"Done",exact:true}).click();
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).not.toContainText("inaccessible");
    await page.goBack();await expect(page.getByRole("button",{name:"All post networks",exact:true})).toBeVisible();await expect(page.getByRole("region",{name:"Saved campaign posts"})).toContainText("inaccessible");
    await page.goForward();await expect(page.getByRole("button",{name:"Instagram",exact:true})).toBeVisible();await expect(page.getByRole("region",{name:"Saved campaign posts"})).not.toContainText("inaccessible");
    await page.getByRole("link",{name:"View hourly runs"}).focus();await page.keyboard.press("Enter");
    await page.getByText("Inspect profile check receipts",{exact:true}).click();
    await expect(page.getByRole("region",{name:"Read-only run trace"})).toContainText("loginRequired");
    await page.getByText("Inspect profile check receipts",{exact:true}).click();
    await expect(page.getByRole("button",{name:"Retry failed profile"})).toHaveAttribute("aria-disabled","true");
    await capture("hourly","Every hourly check leaves evidence.");
    await screenReaderCheckpoint(page,"monitor-held-retry",page.getByRole("button",{name:"Retry failed profile"}),["Retry failed profile","unavailable"]);
    await page.goto("/creators/watchlist");
    await expect(page.getByRole("region",{name:"Canonical creator and profile evidence"})).toContainText("test.maker");
    await capture("watchlist","Know who the agent is watching.");
    await page.getByRole("button",{name:"Match the correct profile",exact:true}).first().click();
    await expect(page.getByRole("dialog",{name:"Match the correct profile"})).toContainText("Current Sheets enrollment matches");await page.keyboard.press("Escape");
    await screenReaderCheckpoint(page,"watchlist-table-headers",page.getByRole("region",{name:"Canonical creator and profile evidence"}),["Canonical creator and profile evidence","Creator","Monitoring"],"KP_Enter");
    addMonitorReviewEvidence(s);await page.reload();
    await page.getByRole("button",{name:"Review 1 matches",exact:true}).click();await expect(page).toHaveURL(/state=identity-review/);
    await capture("watchlist-review","Know who the agent is watching.");
    const captureDialog=async(name:string)=>{
      const modal=page.getByRole("dialog");
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:900});await modal.evaluate(e=>{e.scrollTop=0;});
        const tables=modal.getByRole("region").filter({has:page.getByRole("table")});
        for(const region of await tables.all())await region.evaluate(e=>{e.scrollLeft=0;});
        const result=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
        expect(result.violations.map(v=>v.id)).toEqual([]);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
        expect(await modal.evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
        const modalBounds=await modal.boundingBox();expect(modalBounds).not.toBeNull();
        expect(Math.abs(modalBounds!.x-(width-modalBounds!.width)/2)).toBeLessThanOrEqual(1);
        for(const paragraph of await modal.locator("p").all())expect(await paragraph.evaluate(e=>e.scrollWidth-e.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({path:`${dir}/native-${name}-${width}-top.png`,fullPage:true});
        for(const [i,region] of (await tables.all()).entries()){
          if(await region.evaluate(e=>e.scrollWidth>e.clientWidth+1)){
            await region.scrollIntoViewIfNeeded();await region.focus();await page.keyboard.press("ArrowRight");
            await expect.poll(()=>region.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);
            await region.evaluate(e=>{e.scrollLeft=e.scrollWidth;});
            const bounds=await region.boundingBox(),last=await region.getByRole("columnheader").last().boundingBox();
            expect(bounds).not.toBeNull();expect(last).not.toBeNull();
            expect(last!.x).toBeGreaterThanOrEqual(bounds!.x-1);
            expect(last!.x+last!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width+1);
            await page.screenshot({path:`${dir}/native-${name}-${width}-table-${i}-right.png`,fullPage:true});
            await region.evaluate(e=>{e.scrollLeft=0;});
          }
        }
        // The return button may already retain focus across viewport changes;
        // focus() alone does not undo the deliberate top-of-dialog scroll.
        await modal.getByRole("button",{name:/Return to (watchlist|run)/}).scrollIntoViewIfNeeded();
        await modal.getByRole("button",{name:/Return to (watchlist|run)/}).focus();
        await expect(modal.getByRole("button",{name:/Return to (watchlist|run)/})).toBeInViewport();
        await page.screenshot({path:`${dir}/native-${name}-${width}-bottom.png`,fullPage:true});
        audit.push({name,width,dialogScrollHeight:await modal.evaluate(e=>e.scrollHeight),violations:0});
      }
    };
    const match=page.getByRole("button",{name:"Match the correct profile",exact:true}).first();
    await match.focus();await page.keyboard.press("Enter");
    let dialog=page.getByRole("dialog",{name:"Match the correct profile"});await expect(dialog.getByRole("table",{name:"Competing identity evidence"})).toBeVisible();
    await expect(dialog).toContainText("quarantined");await expect(dialog).toContainText("identity-evidence-");
    await captureDialog("identity-review");await page.keyboard.press("Escape");await expect(match).toBeFocused();
    const historyButton=page.getByRole("button",{name:"Open intake history",exact:true});await historyButton.focus();await page.keyboard.press("Enter");
    dialog=page.getByRole("dialog",{name:"Intake history",exact:true});await expect(dialog).toContainText("Complete supplied history");await expect(dialog).toContainText("Original / decision receipts");
    await captureDialog("intake-history");await page.keyboard.press("Escape");await expect(historyButton).toBeFocused();
    const messageButton=page.getByRole("button",{name:/Review new message ·/}).first();await messageButton.focus();await page.keyboard.press("Enter");
    dialog=page.getByRole("dialog",{name:"New message evidence"});await expect(dialog).toContainText("conversation-");await expect(dialog).toContainText("message-");await expect(dialog).toContainText("draft");await expect(dialog).toContainText("ready");
    await captureDialog("message-context");await page.keyboard.press("Escape");await expect(messageButton).toBeFocused();
    s.reviewEvidence![0]!.access="denied";s.runs[0]!.inbox[0]!.context!.access="denied";await page.reload();
    await page.getByRole("button",{name:/Review new message ·/}).first().click();dialog=page.getByRole("dialog",{name:"New message evidence"});
    await expect(dialog).toContainText("Message context denied");await expect(dialog.getByText("Exact conversation",{exact:true})).toHaveCount(0);
    await captureDialog("message-denied");await page.keyboard.press("Escape");
    await historyButton.click();await expect(page.getByRole("dialog",{name:"Intake history",exact:true})).toContainText("Intake evidence denied");await page.keyboard.press("Escape");
    s.reviewEvidence![0]!.access="authorized";s.runs[0]!.inbox[0]!.context!.access="authorized";
    await page.goto("/content");await page.getByRole("link",{name:"View hourly runs"}).click();
    const suggestion=page.getByRole("button",{name:"Review status suggestion"});await suggestion.focus();await page.keyboard.press("Enter");
    dialog=page.getByRole("dialog",{name:"Source observation evidence"});await expect(dialog).toContainText("Expected source version");await expect(dialog).toContainText("draft");await expect(dialog).toContainText("ready");
    await captureDialog("status-suggestion");await page.keyboard.press("Escape");await expect(suggestion).toBeFocused();
    await page.goto("/content?network=tiktok");const table=page.getByRole("region",{name:"Saved campaign posts"});
    await table.getByRole("link").first().click();
    await page.getByText("View attribution evidence",{exact:true}).click();
    await expect(page.getByText("creator-level outcomes",{exact:true})).toBeVisible();
    await expect(page.getByText(/No share is assigned/)).toBeVisible();
    await expect(page.getByRole("button",{name:"Open source post"})).toHaveAttribute("aria-disabled","true");
    await page.getByText("View attribution evidence",{exact:true}).click();
    await capture("post","One post. Its evidence and impact.");
    await page.getByText("Inspect publication observation history",{exact:true}).click();
    await screenReaderCheckpoint(page,"post-publication-alternative",page.getByRole("region",{name:"Publication observation history"}),["Publication observation history","State","Observation time","Native receipt"],"KP_Enter");
    await page.reload();await page.getByText("View attribution evidence",{exact:true}).click();await expect(page.getByText(/No share is assigned/)).toBeVisible();
    // The inaccessible post proves an honest empty chart. Also render real
    // application deltas from explicitly fictional, comparable source receipts.
    const measured=s.posts[0]!,basis=measured.measurements[0]!;
    measured.measurements=[
      {...basis,at:measured.publishedAt!,receipt:"synthetic-metric-baseline",views:0},
      {...basis,at:new Date(Date.parse(measured.publishedAt!)+12*3600_000).toISOString(),receipt:"synthetic-metric-middle",views:100},
      {...basis,receipt:"synthetic-metric-latest",views:150}
    ];
    await page.goto("/content?network=instagram");await page.getByRole("region",{name:"Saved campaign posts"}).getByRole("link").first().click();
    const chart=page.getByRole("img",{name:/100 views;.*50 views/});
    await expect(chart).toBeVisible();await expect(chart).toHaveAttribute("aria-label",/100 views;.*50 views/);
    await expect(chart).toContainText("100");await expect(chart).toContainText("50");
    await expect(page.getByRole("link",{name:"Open source post",exact:true})).toHaveAttribute("href",measured.originalUrl!);
    await capture("post-measured","One post. Its evidence and impact.");
    await page.clock.setFixedTime(new Date(Date.now()+16*60_000));
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert").filter({hasText:"Source access has expired"})).toBeVisible();
    await expect(chart).toHaveCount(0);await expect(page.getByRole("link",{name:"Open source post",exact:true})).toHaveCount(0);
    await page.clock.setFixedTime(new Date());
    denied=true;await page.goto("/content");
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).toHaveCount(0);
    await expect(page.getByRole("alert").first()).toBeVisible();
    denied=false;s.coverage="partial";
    await screenReaderCheckpoint(page,"monitor-partial-recovery",page.getByRole("button",{name:"All post networks",exact:true}),["Partial source coverage"],"Down",async()=>{
      await page.reload();await expect(page.getByRole("status").filter({hasText:"Partial source coverage"})).toBeVisible();
    });
    await expect(page.getByRole("status").filter({hasText:"Partial source coverage"})).toBeVisible();
    await expect(page.getByRole("region",{name:"Saved campaign posts"})).toContainText("inaccessible");
    s.coverage="complete";s.posts=[];await page.reload();
    await expect(page.getByText("No matching saved campaign posts. Provider-wide post count is unknown.")).toBeVisible();
    writeFileSync(dir+"/native-browser-proof.json",JSON.stringify({audit,source:"Actual local agent service and SQLite with scoped synthetic J01/J08 authority",externalActions:0},null,2));
  }finally{await app.close();}
});
