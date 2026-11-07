import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { assertNativeTableReadability, scrollNativeTableToEnd } from "./support/native-table-readability";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createMediaHttpFixture } from "../src/creator-agent/mediaHttpFixture.testkit.ts";
import { MEDIA_STAGE_ACTION } from "../src/creator-agent/media/canonicalContract.ts";
import { SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";

// Actual HTTP/shared SQLite/J04/worker, fictional source owners and native provider responses only.
// No live account, company policy adoption, payment or external provider write is exercised.
test.setTimeout(120_000);
const cleanups: (() => Promise<void>)[] = [];
test.afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(page:Page) {
  const f=await createMediaHttpFixture(true,150000,{port:Number(process.env.E2E_AGENT_SERVER_PORT)});cleanups.push(f.close);
  await page.clock.install({time:f.a.state.now});
  expect((await page.request.get("/v1/session",{headers:{authorization:`Bearer ${SYNTHETIC_REVIEW_TOKEN}`}})).status()).toBe(200);
  return f;
}
async function compare(page:Page,state:string) {
  const configured=process.env.FARDA_MEDIA_OUTCOME_COMPARE_DIR;if(!configured)return;
  const privateRoot=resolve(".handoff")+sep,directory=resolve(configured);
  if(!directory.startsWith(privateRoot))throw new Error("Original comparisons must stay in the ignored private directory.");
  const map:unknown=JSON.parse(readFileSync(join(directory,"originals.json"),"utf8"));
  const original=map&&typeof map==="object"?(map as Record<string,unknown>)[state]:undefined;
  if(typeof original!=="string"||!resolve(original).startsWith(privateRoot))throw new Error("Missing private full-source comparison mapping.");
  const out=join(directory,state),auth=join(out,"auth-state.json");mkdirSync(out,{recursive:true});
  try {
    writeFileSync(auth,JSON.stringify(await page.context().storageState()),{mode:0o600});const url=new URL(page.url()),environment={...process.env};delete environment.SEGMENTS;
    const result=await promisify(execFile)(process.execPath,["scripts/compare-figma.mjs",url.pathname+url.search,resolve(original)],{
      env:{...environment,BASE_URL:url.origin,FIGMA_COMPARE_BROWSER_CHANNEL:process.env.E2E_AGENT_BROWSER_CHANNEL,FIGMA_COMPARE_STORAGE_STATE:auth,FIGMA_COMPARE_OUTPUT_DIR:out},timeout:60000});
    writeFileSync(join(out,"metrics.json"),JSON.stringify({state,fullFrame:true,crop:null,segments:null,claim:"Native source-state adaptation, not pixel parity; differing dimensions require full-union inspection.",metrics:JSON.parse(result.stdout)},null,2));
  }finally{rmSync(auth,{force:true});}
}
async function capture(page:Page,info:TestInfo,state:string) {
  const out=process.env.FARDA_MEDIA_OUTCOME_PROOF_DIR??info.outputPath("media-outcome-evidence");mkdirSync(out,{recursive:true});const captures=[];
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:width===1440?1000:844});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>window.scrollTo(0,0));
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    const readable=await assertNativeTableReadability(page,state==="media-stage-cap"?"approval":"run",width);
    const ax=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();expect(ax.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
    const file=join(out,`${state}-${width}.png`);await page.screenshot({path:file,fullPage:true});const png=readFileSync(file);
    captures.push({file:basename(file),width:png.readUInt32BE(16),height:png.readUInt32BE(20),sha256:createHash("sha256").update(png).digest("hex")});
    if(readable.overflow){
      await scrollNativeTableToEnd(page,readable.caption);const endFile=join(out,`${state}-table-end-${width}.png`);await page.screenshot({path:endFile,fullPage:true});const endPng=readFileSync(endFile);
      captures.push({file:basename(endFile),width:endPng.readUInt32BE(16),height:endPng.readUInt32BE(20),sha256:createHash("sha256").update(endPng).digest("hex")});
      await page.locator(`[role="region"][aria-label="${readable.caption}"]`).evaluate(element=>{element.scrollLeft=0;});
    }
    if(width===1440)await compare(page,state);
  }
  writeFileSync(join(out,`${state}-provenance.json`),JSON.stringify({state,source:"Actual authenticated HTTP app with shared SQLite/J04/worker and fictional native media source bindings.",realProviderWrites:0,realSpend:0,companyPolicyAdopted:false,sourceMapping:state==="media-stage-cap"?"6:234":"5:13",visualClaim:"Source-state adaptation, not pixel parity; original private Figma media excluded.",captures},null,2));
}

test("the exact media stage approval shows full exposure and zero immediate provider spend",async({page},info)=>{
  const f=await fixture(page),{requested}=await f.request(MEDIA_STAGE_ACTION,"stage:initial");
  await page.goto(`/approvals/${encodeURIComponent(requested.approvalRef!)}`);await expect(page.getByRole("heading",{name:"Media stage authorization"})).toBeVisible();
  await expect(page.getByText("Authorized stage cap",{exact:true}).locator("..")).toContainText("$1,500.00");
  await expect(page.getByText("Immediate provider spend",{exact:true}).locator("..")).toContainText("$0.00");
  await expect(page.getByRole("button",{name:"Approve this version"})).toHaveAttribute("aria-disabled","true");
  await capture(page,info,"media-stage-cap");
  await page.getByRole("button",{name:"Open approval channel",exact:true}).focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();await page.getByRole("button",{name:"Close preview",exact:true}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(f.world.state.calls).toBe(0);expect(f.app.mediaDomain!.controller.read("stage:initial")?.state).toBe("awaiting-approval");
});

test("a rejected provider response remains terminal with its receipt and offers no resend",async({page},info)=>{
  const f=await fixture(page);await f.run(MEDIA_STAGE_ACTION,"stage:initial");const campaign=f.prepare();await f.run("media.createDraft",campaign.campaignId);
  f.world.state.rejected=true;const result=await f.run("media.publish",campaign.campaignId);const original=f.app.mediaDomain!.repository.read(campaign.campaignId);
  const run=await f.app.actionFoundation.service.readRun(result.queued.runRef!,{principalRef:"agent-reviewer"});
  expect(run.providerRejectedCount).toBe(1);expect(run.items[0]!.receiptRef).toBeTruthy();
  await page.goto(`/runs/${encodeURIComponent(result.queued.runRef!)}?tab=approval`);await expect(page.getByTestId("native-run-status")).toHaveText("Provider rejected 1 item");
  await expect(page.getByText("Provider rejected · receipt confirmed",{exact:true})).toBeVisible();await expect(page.getByText(run.items[0]!.receiptRef!,{exact:true})).toBeVisible();
  await expect(page.getByText("Provider-rejected items",{exact:true}).locator("..")).toContainText("1");await expect(page.getByText("All item receipts confirmed",{exact:true})).toHaveCount(0);
  await capture(page,info,"media-provider-rejected");
  await page.getByRole("link",{name:"Recovery",exact:true}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("button",{name:"Continue guarded original work",exact:true})).toHaveAttribute("aria-disabled","true");
  expect(f.world.state.calls).toBe(2);expect(f.app.mediaDomain!.repository.read(campaign.campaignId)).toEqual(original);
  expect(await f.app.actionFoundation.service.readRun(result.queued.runRef!,{principalRef:"agent-reviewer"})).toMatchObject({executionCertainty:"applied",providerRejectedCount:1,items:[{receiptRef:run.items[0]!.receiptRef,providerOutcome:{state:"rejected"}}]});
});
