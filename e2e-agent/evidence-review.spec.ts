import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect,test } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { assessCreator } from "../src/creator-agent/policy.ts";
import { SYNTHETIC_READ_TOKEN,SYNTHETIC_REVIEW_TOKEN,SYNTHETIC_SCOPE,syntheticBinding,syntheticPacket } from "../src/creator-agent/testFixtures.ts";

test("a reviewer annotates exact source evidence, preserves a disagreement, and reads superseded evidence without activating it",async({page})=>{
  const binding=syntheticBinding();
  const app=createAgentServer({databasePath:":memory:", workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!,
    readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,bindings:[binding]});
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve);});
  try {
    const packet=syntheticPacket(), post=packet.posts[0]!;
    post.review={...post.review,visualMethod:"continuous",sampledPoints:[],watchedIntervals:[{startSec:0,endSec:8}],
      reviewerRef:"synthetic-source-reviewer", reviewedAt:post.observedAt};
    post.accessObservation={state:"permitted",observedAt:post.observedAt,sourceRef:"synthetic:permitted-read"};
    const first=app.store.save(packet,assessCreator(packet,binding),0,"first");
    expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN}})).ok()).toBe(true);
    const path=`/creators/${packet.creatorId}/evidence/${post.postId}`;
    await page.goto(path);
    await expect(page.getByText("Original access permitted when checked")).toBeVisible();
    await expect(page.getByRole("link",{name:`Open the original ${post.network} post`})).toHaveAttribute("href",post.sourceUrl);
    await expect(page.getByRole("region",{name:"Time-coded review evidence"})).toContainText("0:00–0:08");
    const output=".handoff/review-288"; mkdirSync(output,{recursive:true});
    const measurements=[];
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(()=>document.fonts.ready);
      const scroll=await page.evaluate(()=>document.documentElement.scrollWidth);
      expect(scroll).toBe(width);
      const axe=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
      expect(axe.violations.map(v=>v.id)).toEqual([]);
      await page.screenshot({path:`${output}/bound-${width}.png`,fullPage:true});
      measurements.push({width,scroll,axeViolations:axe.violations.map(v=>v.id)});
    }
    await page.getByRole("button",{name:"Add time-coded observation"}).focus();
    await page.keyboard.press("Enter");
    const observation=page.getByRole("dialog",{name:"Add time-coded observation"});
    await observation.getByLabel("Start (m:ss)").fill("0:01");
    await observation.getByLabel("End (m:ss)").fill("0:03");
    await observation.getByLabel("Observed evidence").fill("The fictional case opens during the recorded interval.");
    await observation.getByRole("button",{name:"Save reviewer entry"}).click();
    await expect(observation.getByRole("status")).toContainText("Saved reviewer entry 1");
    await observation.getByRole("button",{name:"Close",exact:true}).last().click();
    await page.getByRole("button",{name:"Record disagreement"}).click();
    const dispute=page.getByRole("dialog",{name:"Record disagreement"});
    await dispute.getByLabel("Reason").fill("The sampled action does not establish the proposed interpretation.");
    await page.keyboard.press("Escape");
    await expect(dispute.getByText("Discard the unsaved reviewer entry?")).toBeVisible();
    await dispute.getByRole("button",{name:"Keep editing"}).click();
    const submitted:string[]=[];
    await page.route("**/v1/save",async route=>{
      submitted.push(route.request().postDataJSON().idempotencyKey);
      if(submitted.length === 1) return route.fulfill({status:200,json:{invalid:"unknown-result"}});
      const upstream=await route.fetch();
      const receipt=await upstream.json();
      await route.fulfill({status:200,json:{...receipt,resourceVersion:"invalid-ack"}});
    });
    await dispute.getByRole("button",{name:"Save reviewer entry"}).click();
    await expect(dispute.getByRole("button",{name:"Check saved history"})).toBeVisible();
    await dispute.getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("button",{name:"Inspect pending reviewer entry"}).click();
    await page.route("**/v1/read",route=>route.fulfill({status:503,json:{code:"SOURCE_UNAVAILABLE",
      message:"Synthetic read failure",requestId:route.request().postDataJSON().requestId,retryable:false,correlationId:null,retryAfterMs:null}}));
    await dispute.getByRole("button",{name:"Check saved history"}).click();
    await expect(dispute.getByText("Saved history could not be verified. The pending request is retained.")).toBeVisible();
    await expect(dispute.getByRole("button",{name:"Retry the exact request"})).toHaveCount(0);
    await page.unroute("**/v1/read");
    await dispute.getByRole("button",{name:"Check saved history"}).click();
    await dispute.getByRole("button",{name:"Retry the exact request"}).click();
    await expect(dispute.getByText("The response could not confirm this exact entry. Inspect saved history before retrying.")).toBeVisible();
    expect(submitted).toHaveLength(2);expect(submitted[0]).toBe(submitted[1]);
    await page.unroute("**/v1/save");
    await dispute.getByRole("button",{name:"Check saved history"}).click();
    await expect(dispute.getByRole("status")).toContainText("Confirmed reviewer entry 2 in saved history.");
    await dispute.getByRole("button",{name:"Close",exact:true}).last().click();
    await page.reload();
    await expect(page.getByText("This assessment has disputed evidence. Review is required before dependent work can proceed.")).toBeVisible();
    await expect(page.getByRole("list",{name:"Immutable annotation history"}).getByRole("listitem")).toHaveCount(2);
    const revised=structuredClone(packet);revised.evidenceRevision="synthetic-revised";revised.termsRevision="synthetic-terms-2";
    revised.posts[0]!.accessObservation={state:"deleted",observedAt:"2026-11-05T12:00:00.000Z",sourceRef:"synthetic:deleted"};
    const second=app.store.save(revised,assessCreator(revised,binding),1,"second");
    await page.reload();
    await expect(page.getByText("Original deleted",{exact:true})).toBeVisible();
    await expect(page.getByRole("link",{name:`Open the original ${post.network} post`})).toHaveCount(0);
    await page.screenshot({path:output+"/deleted-390.png",fullPage:true});
    await page.getByRole("link",{name:"Previous saved evidence"}).click();
    await expect(page).toHaveURL(new RegExp("run="+first.runId));
    await expect(page.getByText("Historical evidence. A later creator assessment superseded this run.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Record disagreement"})).toHaveAttribute("aria-disabled","true");
    await expect(page.getByRole("list",{name:"Immutable annotation history"}).getByRole("listitem")).toHaveCount(2);
    writeFileSync(output+"/browser-proof.json",JSON.stringify({fixture:"seeded reviewed synthetic media",reportedPlayback:"external original only",
      runs:[first.runId,second.runId],measurements,sourceReceipt:post.review.sourceRef,annotations:2,productionActions:0},null,2));
  } finally {await app.close();}
});
