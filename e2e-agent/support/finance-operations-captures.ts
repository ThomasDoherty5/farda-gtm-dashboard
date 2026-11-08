import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

/** Synthetic rendered evidence only. Original design images stay in private local storage. */
const frames = {
  "9:551": [1440, 1506], "65:1037": [1440, 2185], "66:252": [1440, 2111], "66:447": [1440, 2194],
  "4:6": [1440, 1452], "4:171": [1440, 1331], "4:317": [1440, 1119], "12:292": [1440, 1423],
  "12:431": [1440, 846], "12:808": [1440, 1287], "12:653": [390, 1366], "12:708": [1024, 1078],
} as const;
export type FinanceOperationsFrame = keyof typeof frames;
export async function captureFinanceOperations(page: Page, nodeId: FinanceOperationsFrame) {
  const [width, height] = frames[nodeId];
  await page.setViewportSize({ width, height });
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  await expect(page.getByRole("main")).toBeVisible();
  const geometry = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    content: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    fontsLoaded: document.fonts.status === "loaded",
    headings: Array.from(document.querySelectorAll("main h1, main h2, main h3")).map(el => ({ text: el.textContent, top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height })),
    tables: Array.from(document.querySelectorAll("main table")).map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
  }));
  expect(geometry.fontsLoaded).toBe(true);
  expect(geometry.content.width, "Only labeled table regions may scroll horizontally").toBeLessThanOrEqual(width);
  const dir = "test-results/agent/finance-operations", image = `${nodeId.replace(":", "-")}-full.png`;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${image}`, fullPage: true, animations: "disabled" });
  const file = `${dir}/capture-manifest.json`;
  let prior: { nodeId: string }[] = [];
  try { prior = JSON.parse(await readFile(file, "utf8")) as { nodeId: string }[]; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(file, JSON.stringify([...prior.filter(row => row.nodeId !== nodeId), { nodeId, image, sourceFrame: { width, height }, geometry, accessibility: await page.getByRole("main").ariaSnapshot(), evidenceStage: "synthetic-native-source", fullPage: true }], null, 2));
}
