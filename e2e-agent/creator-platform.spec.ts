import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";
import { platformEnvelope, platformEvent } from "../src/creator-agent/creatorPlatformFixtures.testkit.ts";
import { digest } from "../src/creator-agent/config.ts";
import type { FunnelEvent } from "../src/creator-agent/funnelContract.ts";

const port = Number(process.env.E2E_AGENT_SERVER_PORT);
const service = "http://127.0.0.1:"+port;
const scope = {workspaceId:SYNTHETIC_SCOPE.workspaceId,accountId:SYNTHETIC_SCOPE.accountIds[0]!};
const proofs = new Map<string,string>();
let app: ReturnType<typeof createAgentServer>;
async function save(event: FunnelEvent) {
  proofs.set(event.evidenceRef.provenanceRef,digest(event));
  const response = await fetch(service+"/v1/funnel/events",{method:"POST",headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN,"content-type":"application/json"},body:JSON.stringify(platformEnvelope(event))});
  expect(response.status).toBe(200);
}
async function signIn(page: Page) {
  expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+SYNTHETIC_READ_TOKEN}})).ok()).toBe(true);
}
test.beforeEach(async()=>{
  proofs.clear();
  app=createAgentServer({databasePath:":memory:",...scope,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,
    funnelAuthority:{resolve:async(_scope,_job,ref)=>proofs.has(ref)?{...scope,eventHash:proofs.get(ref)!}:null}});
  await new Promise<void>((resolve,reject)=>{app.server.once("error",reject);app.server.listen(port,"127.0.0.1",resolve);});
});
test.afterEach(async()=>{if(app) await app.close();});

test("all four original routes read the trusted ledger, preserve source dimensions and open exact evidence",async({page})=>{
  const account=scope.accountId;
  await save(platformEvent(account,"synthetic-sc-match","matched","social",{patch:{network:"tiktok",checkout:"website"},details:{owner:"Founder"}}));
  await save(platformEvent(account,"synthetic-sc-pub","published","social",{day:7,patch:{network:"tiktok",checkout:"website"},details:{postId:"native-private-post",deliverableId:"native-private-file",payoutOwner:"external-affiliate"}}));
  await save(platformEvent(account,"synthetic-sc-native","postMetrics","social",{producer:"tiktok",day:8,patch:{network:"tiktok",checkout:"website"},details:{postId:"native-private-post",views:100,engagements:5}}));
  await save(platformEvent(account,"synthetic-order","retainedOrder","social",{details:{orderId:"native-private-order",retainedMinor:1250,currency:"USD",attributionVersion:"v1",attributionWindow:"30d"}}));
  await save(platformEvent(account,"synthetic-tt","terms","shop",{acquisition:"tiktok-shop",patch:{network:"instagram",checkout:"tiktok-shop"}}));
  await signIn(page);
  await page.goto("/creators/social-cat?view=board");
  await expect(page.getByRole("heading",{name:"Platform work board"})).toBeVisible();
  const trigger=page.getByRole("button",{name:"Inspect opportunity"});
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog=page.getByRole("dialog",{name:"Opportunity evidence"});
  await expect(dialog).toContainText("no saved acceptance");
  await expect(dialog).toContainText("external-affiliate");
  await expect(dialog).not.toContainText("native-private");
  await expect(dialog.getByRole("link",{name:"Content and publication"})).toHaveAttribute("href",/^\/collaborations\/collab1-[\w-]+\?tab=content$/);
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await page.getByRole("link",{name:"Social Cat dashboard",exact:true}).click();
  await expect(page.getByText("$12.50",{exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Native post insights and coverage"})).toContainText("100");
  await expect(page.locator("main")).not.toContainText("Demo");
  await page.screenshot({path:".handoff/figma/creator-platform-native-dashboard.png",fullPage:true});
  await page.getByRole("link",{name:"TikTok board",exact:true}).click();
  await expect(page.getByRole("region",{name:"Current saved opportunities"})).toContainText("Terms");
  await page.getByRole("link",{name:"TikTok dashboard",exact:true}).click();
  await expect(page.getByRole("region",{name:"Recorded checkout and payout lanes"})).toContainText("tiktok-shop");
  await expect(page.getByRole("region",{name:"Recorded checkout and payout lanes"})).toContainText("unknown");
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze()).violations.map(v=>v.id)).toEqual([]);
  await page.screenshot({path:".handoff/figma/creator-platform-native-mobile.png",fullPage:true});
});
test("fixed membership pages survive filter changes and session loss clears previously saved creator work",async({page,context})=>{
  for(let i=0;i<26;i++) await save(platformEvent(scope.accountId,"synthetic-"+i,"qualified","source-"+String(i).padStart(2,"0"),{details:{owner:"Founder"}}));
  await signIn(page); await page.goto("/creators/social-cat?view=board&layout=list");
  await expect(page.getByText("Showing 25 of 26 saved opportunities.")).toBeVisible();
  const more=page.getByRole("button",{name:"Load more opportunities"});
  await more.click(); await expect(page.getByText("Showing 26 of 26 saved opportunities.")).toBeVisible();
  await page.getByLabel("Owner",{exact:true}).fill("No such owner"); await expect(page.getByText(/No opportunities match these filters/)).toBeVisible();
  await page.getByLabel("Owner",{exact:true}).fill("Founder"); await expect(page.getByText("Showing 25 of 26 saved opportunities.")).toBeVisible();
  const prior=await page.getByRole("region",{name:"Current saved opportunities"}).getByRole("rowheader").first().innerText();
  await context.clearCookies(); await more.click();
  await expect(page.getByRole("heading",{name:"Sign in again"})).toBeVisible();
  await expect(page.locator("main")).not.toContainText(prior);
  await expect(page.getByRole("button",{name:"Inspect opportunity"})).toHaveCount(0);
});
