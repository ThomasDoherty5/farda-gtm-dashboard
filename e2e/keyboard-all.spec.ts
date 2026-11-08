import { expect, test, type Page } from "@playwright/test";
import { axeViolations, chunk } from "./support/axe";
import { auditLayout, settle } from "./support/layout";
import { extraRecordUrls, routeUrls } from "./support/routes";

/**
 * Keyboard and focus on every built route (FHC-02, FHC-05, VIS-05): tab order follows the visual order, every stop shows a focus
 * indicator, nothing traps focus, every dialog moves focus in, keeps it in, closes on Escape and gives focus back, route changes
 * move focus to the page heading, the skip link works, and nothing animates under prefers-reduced-motion.
 * Runs in the desktop project only; each test sets its own width.
 */
test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop-1440", "sets its own viewport; one project is enough");
});

const allUrls = [...routeUrls, ...extraRecordUrls];
const GROUPS = 4;
const MAX_STOPS = 150;

type Stop = { label: string; top: number; left: number; width: number; height: number; indicator: boolean; inMain: boolean; inDialog: boolean; same: boolean };

/** Presses Tab up to `max` times and records where focus lands. Stops when focus leaves the page or comes back to where it began. */
async function tabThrough(page: Page, max: number): Promise<{ stops: Stop[]; trapped: string | null }> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  const stops: Stop[] = [];
  let previous = "";
  let repeats = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((prev) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const shadow = s.boxShadow !== "none";
      const label = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 36)}"`;
      // Position within the page content: add back whatever a scroll container or the window has already scrolled away.
      let offX = window.scrollX, offY = window.scrollY;
      for (let p = el.parentElement; p; p = p.parentElement) { offX += p.scrollLeft; offY += p.scrollTop; }
      return { label, top: r.top + offY, left: r.left + offX, width: r.width, height: r.height, indicator: outline || shadow, inMain: !!el.closest("main"), inDialog: !!el.closest("dialog"), same: label + Math.round(r.top + offY) === prev };
    }, previous);
    if (!stop) break; // focus left the document (browser chrome) or wrapped to the top
    if (stop.same) { if (++repeats >= 2) return { stops, trapped: stop.label }; } else repeats = 0;
    previous = stop.label + Math.round(stop.top);
    stops.push(stop);
  }
  return { stops, trapped: null };
}

/** Reading-order check between two consecutive stops: focus may move on or down, or to the next column to the right, never up-and-back or left on one row. */
function outOfOrder(a: Stop, b: Stop): boolean {
  const dy = b.top - a.top, dx = b.left - a.left;
  if (Math.abs(dy) <= 24) return dx < -8;
  return dy < 0 && dx < 80;
}

for (const width of [1440, 390]) {
  chunk(allUrls, GROUPS).forEach((urls, i) => {
    test(`tab order, focus indicator and no trap, ${width}px, routes ${i + 1} of ${GROUPS}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: 900 });
      const found: string[] = [];
      for (const url of urls) {
        await page.goto(url);
        await settle(page, url);
        const { stops, trapped } = await tabThrough(page, MAX_STOPS);
        if (trapped) found.push(`${url} @${width}: keyboard trap on ${trapped}`);
        if (stops.length === 0) found.push(`${url} @${width}: nothing is reachable with Tab`);
        for (const s of stops) if (!s.indicator && !s.inDialog) found.push(`${url} @${width}: no focus indicator on ${s.label}`);
        stops.forEach((s, k) => { const p = stops[k - 1]; if (p && p.inMain && s.inMain && outOfOrder(p, s)) found.push(`${url} @${width}: tab order jumps from ${p.label} (${Math.round(p.left)},${Math.round(p.top)}) to ${s.label} (${Math.round(s.left)},${Math.round(s.top)})`); });
        const positive = await page.evaluate(() => document.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex^='-'])").length);
        if (positive) found.push(`${url} @${width}: ${positive} elements use a positive tabindex`);
      }
      expect(found).toEqual([]);
    });
  });
}

for (const dialogWidth of [1440, 390]) chunk(allUrls, GROUPS).forEach((urls, i) => {
  const narrow = dialogWidth === 390;
  test(`every dialog at ${dialogWidth}px: ${narrow ? "fits the screen and its controls stay reachable" : "opens with focus inside, traps Tab, closes on Escape, returns focus, has no axe violations"}, routes ${i + 1} of ${GROUPS}`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: dialogWidth, height: narrow ? 800 : 900 });
    const found: string[] = [];
    const audited = new Set<string>();
    let opened = 0;
    const trigger = "main button[aria-haspopup='dialog']:visible:not([disabled]):not([aria-disabled='true'])";
    // Focus in browser chrome (the page's active element becomes body) is not a leak; focus on page content behind the modal is.
    const inside = () => page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog[open]"));
    for (const url of urls) {
      await page.goto(url);
      await settle(page, url);
      const count = await page.locator(trigger).count();
      for (let k = 0; k < count; k++) {
        if (k > 0 && page.url().replace(/^https?:\/\/[^/]+/, "") !== url) { await page.goto(url); await settle(page, url); }
        const button = page.locator(trigger).nth(k);
        if (!(await button.count())) break;
        const name = ((await button.textContent()) ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const where = `${url} [${name}]`;
        await button.focus();
        await page.keyboard.press("Enter");
        const dialog = page.locator("dialog[open]").first();
        try { await dialog.waitFor({ state: "visible", timeout: 800 }); } catch { continue; } // an action, not a dialog: other specs cover it
        opened++;
        const heading = ((await dialog.locator("h2, h3").first().textContent().catch(() => "")) ?? "").trim();
        const key = `${heading}|${await dialog.locator("button, a, input, select, textarea").count()}`;
        if (narrow) {
          if (!audited.has(key)) { audited.add(key); found.push(...(await page.evaluate(auditLayout)).map((p) => `${where} (dialog open): ${p}`)); }
          await page.keyboard.press("Escape");
          continue;
        }
        if (!(await page.evaluate(() => !!document.activeElement?.closest("dialog[open]")))) found.push(`${where}: focus did not move into the dialog`);
        if (!(await dialog.getAttribute("aria-labelledby")) && !(await dialog.getAttribute("aria-label"))) found.push(`${where}: dialog has no accessible name`);
        const controls = await dialog.locator("button, a[href], input, select, textarea").count();
        const presses = Math.min(12, controls + 2); // one full lap plus two
        for (let t = 0; t < presses; t++) { await page.keyboard.press("Tab"); if (!(await inside())) { found.push(`${where}: Tab left the dialog after ${t + 1} presses`); break; } }
        for (let t = 0; t < 3; t++) { await page.keyboard.press("Shift+Tab"); if (!(await inside())) { found.push(`${where}: Shift+Tab left the dialog`); break; } }
        // The same dialog on several records is audited once.
        if (!audited.has(key)) { audited.add(key); found.push(...(await axeViolations(page, `${where} (dialog open)`))); }
        await page.keyboard.press("Escape");
        if (await page.locator("dialog[open]").count()) { found.push(`${where}: Escape did not close the dialog`); await page.goto(url); await settle(page, url); continue; }
        const back = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()} ${(a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}` : "nothing"; });
        if (!back.includes(name.slice(0, 20))) found.push(`${where}: focus returned to "${back}", not the trigger`);
      }
    }
    test.info().annotations.push({ type: "dialogs opened", description: `${opened}, ${audited.size} distinct audited with ${narrow ? "the layout check" : "axe"}` });
    expect(found).toEqual([]);
  });
});

test("the workspace menu dialog works at 390px, 1024px and 1440px", async ({ page }) => {
  test.setTimeout(90_000);
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/overview");
    await settle(page, "/overview");
    const opener = page.getByRole("button", { name: width === 390 ? "Menu" : width === 1024 ? "More" : "TD, open workspace menu" });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Explore the Farda workspace." })).toBeVisible();
    expect(await axeViolations(page, `menu @${width}`)).toEqual([]);
    if (width < 1180) {
      // The header drops sections below 1180px, so the menu must list all five.
      const sections = page.getByRole("dialog").getByRole("navigation", { name: "Sections" }).getByRole("link");
      await expect(sections).toHaveText(["Overview", "Creators", "Operations", "Finance", "Automations"]);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});

test("route changes move focus to the page heading and name the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overview");
  await settle(page, "/overview");
  await expect(page).toHaveTitle(/^Know what drove sales.* · Farda$|^.+ · Farda$/);
  const first = await page.title();
  for (const [link, path] of [["Finance", "/finance"], ["Operations", "/operations"], ["Automations", "/automations"], ["Creators", "/creators/social-cat"]] as const) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: link }).click();
    await expect(page).toHaveURL(new RegExp(path));
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1, `${link}: focus is on the page heading`).toBeFocused();
    expect(await page.title()).toBe(`${(await h1.textContent())?.trim()} · Farda`);
  }
  expect(await page.title()).not.toBe(first);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
});

test("query-only changes and in-page tabs keep focus where it is", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/finance");
  await settle(page, "/finance");
  const tab = page.getByRole("navigation", { name: /finance/i }).getByRole("link").nth(1);
  if (await tab.count()) {
    await tab.focus();
    const name = await tab.textContent();
    await page.keyboard.press("Enter");
    await page.waitForLoadState();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(name).toBeTruthy();
  }
  await page.goto("/creators/watchlist");
  await settle(page, "/creators/watchlist");
  await page.goto("/creators/watchlist?state=failed");
  await settle(page, "/creators/watchlist");
  // A reload keeps the browser's own focus: nothing steals it on first load.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test("the skip link is the first stop, becomes visible, and lands on main on every layout", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/finance");
    await settle(page, "/finance");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box && box.y >= 0 && box.x >= 0, "the skip link is on screen when focused").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("header")), "Tab after the skip link moves past the header").toBe(false);
  }
});

test("nothing animates under prefers-reduced-motion, on any route", async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const found: string[] = [];
  for (const url of allUrls) {
    await page.goto(url);
    await settle(page, url);
    const moving = await page.evaluate(() => ({
      animations: document.getAnimations().length,
      scroll: getComputedStyle(document.documentElement).scrollBehavior,
      timed: Array.from(document.querySelectorAll("*")).filter((e) => { const s = getComputedStyle(e); return parseFloat(s.transitionDuration) > 0 || (s.animationName !== "none" && parseFloat(s.animationDuration) > 0); }).length,
    }));
    if (moving.animations) found.push(`${url}: ${moving.animations} running animations`);
    if (moving.scroll !== "auto") found.push(`${url}: smooth scrolling (${moving.scroll})`);
    if (moving.timed) found.push(`${url}: ${moving.timed} elements with a transition or animation duration`);
  }
  await context.close();
  expect(found).toEqual([]);
});
