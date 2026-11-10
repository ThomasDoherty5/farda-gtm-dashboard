import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { overviewOwnersFixture } from "../src/creator-agent/analytics/overviewOwners.testkit.ts";
import type { NativeOverviewSummary } from "../src/creator-agent/analytics/views.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { screenReaderCheckpoint } from "./support/screen-reader.ts";
import { shippingHubSourceFixture } from "../src/creator-agent/shippingHubRead.testkit.ts";
import { ShippingHubReadError, type ShippingHubSource } from "../src/creator-agent/shippingHubRead.ts";

async function captures(page:Page,info:TestInfo,name:string) {
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const audit=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
    expect(audit.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:info.outputPath(`overview-owners-${name}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
}
const responseFor=(page:Page,key:string)=>page.waitForResponse(r=>r.url().endsWith("/v1/read")&&r.request().postDataJSON()?.viewKey===key&&r.status()===200);

test("overview and actual creator, Operations, Finance and monitoring owners reconcile within the linked source scope",async({page},info)=>{
  test.setTimeout(240000);
  const f=await overviewOwnersFixture({now:Date.now});
  const shippingHubSource:ShippingHubSource={async read(binding){
    const packet=shippingHubSourceFixture(binding,Date.now());
    const source=(f.operations.shipping.shipments as {ref:string;orderRef:string;home:"H1";requestedAt:string;eventAt:string}[])[0]!;
    const row=packet.shipments[0]!;
    Object.assign(row,{id:source.ref,requestedAt:source.requestedAt,lastEventAt:source.eventAt,location:source.home,
      origin:{kind:"order",ref:source.orderRef,channel:"website"}});
    packet.shipments=[row];packet.stock=[];packet.timezone=f.period.timezone;
    packet.coverage={state:"complete",expectedCount:1,observedCount:1,reasonCodes:[]};
    return packet;
  },assertCurrent(){if(!f.operations.allowed)throw new ShippingHubReadError("SOURCE_DENIED",403);}};
  const app=createAgentServer({databasePath:":memory:",...f.serverOptions,shippingHubSource,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN});
  try {
    await f.seed(app.store);
    await new Promise<void>(resolve=>app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",resolve));
    expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+SYNTHETIC_READ_TOKEN}})).ok()).toBe(true);
    const route="/overview?"+new URLSearchParams({"report-start":f.period.startAt,"report-end":f.period.endAt,"report-zone":f.period.timezone});
    const answer=responseFor(page,"overviewSummary");await page.goto(route);
    const d=(await (await answer).json()).data as NativeOverviewSummary;
    expect(Object.values(d.domains!).map(owner=>owner.state)).toEqual(["ready","ready","ready","ready","ready"]);
    const historyLength=await page.evaluate(()=>history.length), originalUrl=page.url();
    await page.getByRole("navigation",{name:"Primary",exact:true}).getByRole("link",{name:"Overview",exact:true}).click();
    expect(page.url()).toBe(originalUrl);expect(await page.evaluate(()=>history.length)).toBe(historyLength);
    await expect(page.getByTestId("metric-Paid orders")).toHaveText("400");await expect(page.getByTestId("metric-Net receipts")).toHaveText("$12,596.00");
    await expect(page.getByTestId("metric-Views")).toHaveText("500");await expect(page.getByTestId("metric-Engagement rate")).toHaveText("3.0%");
    await expect(page.getByTestId("overview-shipping-count")).toHaveText("1");await expect(page.getByTestId("overview-finance-cash")).toHaveText("$1,200.00");
    await expect(page.getByTestId("overview-finance-runway")).toHaveText("3.0 months");
    await captures(page,info,"overview");
    const trigger=page.getByRole("button",{name:"Inspect portfolio review",exact:true});await trigger.focus();await page.keyboard.press("Enter");
    const dialog=page.getByRole("dialog",{name:"Source-owned portfolio review"});await expect(dialog).toBeVisible();
    await screenReaderCheckpoint(page,"overview-portfolio-recommendation-headers",dialog.getByRole("region",{name:"Portfolio recommendations"}),["Portfolio recommendations","Creator","Proposed action","Next review","Open obligations","Uncertainty"]);
    await captures(page,info,"portfolio");await page.keyboard.press("Escape");await expect(trigger).toBeFocused();
    await screenReaderCheckpoint(page,"overview-portfolio-focus-return",trigger,["Inspect portfolio review","button"]);
    const creatorAnswer=responseFor(page,"attribution");await page.getByRole("link",{name:"Review creator attribution and cost definitions"}).click();
    const creators=(await (await creatorAnswer).json()).data;
    const performanceUrl=page.url(), performanceHistory=await page.evaluate(()=>history.length);
    await page.getByRole("navigation",{name:"Overview sections"}).getByRole("link",{name:"Performance",exact:true}).click();
    expect(page.url()).toBe(performanceUrl);expect(await page.evaluate(()=>history.length)).toBe(performanceHistory);
    expect(creators.period).toEqual(d.period);expect(creators.cohortRef).toBe(d.cohortRef);
    const factValue=(v:{state:string;value:unknown;provisional:boolean;reasonCodes:string[]})=>({state:v.state,value:v.value,provisional:v.provisional,reasonCodes:v.reasonCodes});
    expect(factValue(creators.attributedOrders)).toEqual(factValue(d.domains!.creators.data!.attributedOrders));
    expect(creators.creators.map((r:{creatorRef:string;roi:Parameters<typeof factValue>[0]})=>[r.creatorRef,factValue(r.roi)])).toEqual(d.domains!.creators.data!.roi.map(r=>[r.creatorRef,factValue(r.roi)]));
    await expect(page.getByTestId("metric-net-receipts")).toContainText("$12,596.00");
    await page.goto(route);const opsAnswer=responseFor(page,"operationsOverview");await page.getByRole("link",{name:"Review the same Operations scope"}).click();
    const ops=(await (await opsAnswer).json()).data;
    expect(ops.reportingScope).toEqual(d.domains!.operations.data!.scope);expect(ops.summaryBasis).toEqual(d.domains!.operations.data!.summaryBasis);
    expect(ops.all.timeToShipDays).toEqual(d.domains!.operations.data!.timeToShipDays);expect(ops.health.shippingCostPerOrder).toEqual(d.domains!.operations.data!.shippingCostPerOrder);
    await expect(page.getByTestId("metric-Time to ship")).toHaveText("2 days");await captures(page,info,"operations");
    await page.goto(route);const hubAnswer=responseFor(page,"shippingHub");await page.getByRole("link",{name:"Inspect customer and creator shipments →"}).click();
    const hub=(await (await hubAnswer).json()).data;
    const url=new URL(page.url());expect(url.searchParams.get("ship-start")).toBe(f.period.startAt);expect(url.searchParams.get("ship-end")).toBe(f.period.endAt);
    expect(url.searchParams.get("ship-recipient")).toBe("all");expect(url.searchParams.get("ship-purpose")).toBe("all");
    await expect(page.getByTestId("hub-recipients")).toHaveText(String(d.domains!.operations.data!.shipments));
    await expect(page.getByRole("table",{name:"Shared shipment queue"}).getByRole("row")).toHaveCount(2);
    expect(hub.shipments[0].requestedAt).toBe((f.operations.shipping.shipments as {requestedAt:string}[])[0]!.requestedAt);
    await captures(page,info,"shipping");
    await page.goto(route);const financeAnswer=responseFor(page,"financeDashboard");await page.getByRole("link",{name:"Review the same Finance period"}).click();
    const finance=(await (await financeAnswer).json()).data;
    expect(finance.summaryContext).toEqual(d.domains!.finance.data!.context);expect(finance.cash.value).toBe(d.domains!.finance.data!.cash);
    await expect(page.getByTestId("metric-Cash balance")).toHaveText("$1,200");await expect(page.getByTestId("metric-Runway")).toContainText("3.0");
    await captures(page,info,"finance");const periodButton=page.getByRole("button",{name:"Reporting period",exact:true});await periodButton.click();
    await expect(page.getByRole("dialog",{name:"Reporting period",exact:true})).toContainText(f.period.startAt);await page.keyboard.press("Escape");await expect(periodButton).toBeFocused();
    await screenReaderCheckpoint(page,"overview-finance-period-focus",periodButton,["Reporting period","button"]);
    await page.goto(route);const monitorAnswer=responseFor(page,"contentMonitor");await page.getByRole("link",{name:"View content monitor",exact:true}).click();
    const monitor=(await (await monitorAnswer).json()).data;
    expect(monitor.selection).toEqual(d.domains!.activity.data!.selection);expect([monitor.views,monitor.rate,monitor.orders,monitor.net]).toEqual([d.domains!.activity.data!.views,d.domains!.activity.data!.rate,d.domains!.activity.data!.orders,d.domains!.activity.data!.net]);
    await expect(page.getByText("Observed views",{exact:true}).locator("..")).toContainText("500");await captures(page,info,"monitor");
    const proofPath=info.outputPath("overview-owner-reconciliation.json");
    await writeFile(proofPath,JSON.stringify({stage:"Synthetic actual HTTP/readers only",period:d.period,cohort:d.cohortRef,overview:d.domains,creatorTotals:{orders:creators.attributedOrders,net:creators.attributedNetSales},operations:ops.summaryBasis,finance:finance.summaryContext,monitor:{selection:monitor.selection,views:monitor.views,rate:monitor.rate,orders:monitor.orders,net:monitor.net}},null,2));
    await info.attach("overview-owner-reconciliation.json",{path:proofPath,contentType:"application/json"});
  } finally {await app.close();f.close();}
});
