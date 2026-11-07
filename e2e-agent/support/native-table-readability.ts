import { expect, type Page } from "@playwright/test";

/** Real browser geometry: opaque identifiers may wrap, ordinary words and currency must remain readable. */
export async function assertNativeTableReadability(page: Page, kind: "approval" | "run", viewport: number, options: { keyboardProof?: "probe" | "fullTraversalFollows" } = {}) {
  const caption = kind === "approval" ? "Exact approved manifest" : "Finite run item outcomes";
  const region = page.locator(`[role="region"][aria-label="${caption}"][tabindex="0"]`);
  const table = region.getByRole("table", { name: caption });
  const minima = kind === "approval" ? [192, 192, 192, 64, 112, 256] : [192, 192, 224, 160, 256];
  const headers = table.locator("thead th");
  for (let index = 0; index < minima.length; index++) {
    expect(await headers.nth(index).evaluate(element => element.getBoundingClientRect().width), `${caption} column ${index + 1}`).toBeGreaterThanOrEqual(minima[index]!);
  }
  const ordinary = kind === "approval" ? "thead th:nth-child(4), thead th:nth-child(5), tbody td:nth-child(4), tbody td:nth-child(5)"
    : "thead th:nth-child(2), thead th:nth-child(4), tbody td:nth-child(2), tbody td:nth-child(4)";
  const brokenWords = await table.locator(ordinary).evaluateAll(cells => cells.flatMap(cell => {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT), broken: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (const match of text.matchAll(/\$[\d,]+\.\d{2}|[A-Za-z]+/g)) {
        const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        const lines = new Set(Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0).map(r => Math.round(r.top)));
        if (lines.size > 1) broken.push(match[0]);
      }
    }
    return broken;
  }));
  expect(brokenWords, `${caption}: ordinary words/currency must not split across lines`).toEqual([]);
  const overflow = await region.evaluate(element => element.scrollWidth > element.clientWidth);
  // A caller that immediately traverses to the final column owns the full
  // keyboard proof. Avoid starting and then cancelling an extra native scroll
  // animation before that traversal; geometry/readability checks still run.
  if (overflow && options.keyboardProof !== "fullTraversalFollows") {
    await region.scrollIntoViewIfNeeded(); await region.focus(); await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await region.evaluate(element => { element.scrollLeft = 0; });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  return { overflow, caption, viewport };
}

/** Move by keyboard to the final column; screenshot callers capture the whole page in this position. */
export async function scrollNativeTableToEnd(page: Page, caption: string) {
  const region = page.locator(`[role="region"][aria-label="${caption}"][tabindex="0"]`);
  // Full-page captures restore window scroll while retaining focus. Refocusing alone
  // will not bring that already-focused region back into the visible viewport.
  await region.scrollIntoViewIfNeeded(); await region.focus();
  for (let count = 0; count < 80; count++) {
    const state = await region.evaluate(element => {
      const bounds=element.getBoundingClientRect(),last=element.querySelector("thead th:last-child")!.getBoundingClientRect();
      return {left:element.scrollLeft,visible:last.left>=bounds.left-1&&last.right<=bounds.right+1};
    });
    if (state.visible) break;
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(state.left).catch(async error => {
      const geometry = await region.evaluate(element => ({left:element.scrollLeft,end:element.scrollWidth-element.clientWidth,width:element.clientWidth,focused:document.activeElement===element,rect:element.getBoundingClientRect().toJSON(),last:element.querySelector("thead th:last-child")?.getBoundingClientRect().toJSON()}));
      throw new Error(`Keyboard table scrolling stalled: ${JSON.stringify(geometry)}`,{cause:error});
    });
  }
  const finalCell = region.locator("thead th").last();
  expect(await finalCell.evaluate(element => element.getBoundingClientRect().left)).toBeGreaterThanOrEqual(await region.evaluate(element => element.getBoundingClientRect().left) - 1);
  expect(await finalCell.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(await region.evaluate(element => element.getBoundingClientRect().right) + 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
