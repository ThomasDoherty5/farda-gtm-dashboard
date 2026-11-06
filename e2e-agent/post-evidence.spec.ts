import { expect, test } from "@playwright/test";
import { postPerformanceDemo } from "../src/fixtures/monitor";
import { respondWith } from "../src/adapter/demoViews";
import type { ReadRequest } from "../src/adapter/contract";

/** The real sandbox client validates a controlled historical HTTP response on the post route. */
test("an older post response renders missing publication and GMV evidence without inventing sales", async ({ page }) => {
  const scope = { workspaceId: "synthetic-workspace", accountIds: ["synthetic-account"], environment: "sandbox", authorizationScopeVersion: "test-v1" };
  await page.route("**/v1/session", route => route.fulfill({ json: { scope, role: "reader", principal: "synthetic-reader" } }));
  await page.route("**/v1/read", async route => {
    const read = route.request().postDataJSON() as ReadRequest<{ postId: string }>;
    expect(read.viewKey).toBe("postPerformance");
    expect(read.filters.postId).toBe("synthetic-historical");
    const data = { ...postPerformanceDemo, datasetKey: "post-performance", postId: read.filters.postId, orders: 0, netSales: null, gmv: undefined, publicationProof: undefined, attributionWindow: undefined };
    await route.fulfill({ json: respondWith(read, data, { dataVersion: "synthetic-historical-v1" }) });
  });
  await page.goto("/content/synthetic-historical");
  await expect(page.getByTestId("gmv-note")).toContainText("GMV is unknown");
  await expect(page.getByTestId("metric-orders")).toHaveText("0");
  await expect(page.getByTestId("metric-net-sales")).toHaveText("N/A");
  await expect(page.getByText("Publication unverified", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View attribution evidence" }).click();
  await expect(page.getByRole("dialog")).toContainText("Unknown · no attribution window supplied");
});
