import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Menu and More retain the selected home, view and record identity", async ({ page }) => {
  const width = page.viewportSize()!.width < 768 ? 390 : 1024;
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/operations?scenario=normal");
  const trigger = page.getByRole("button", { name: width === 390 ? "Menu" : "More", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  const scope = dialog.getByRole("navigation", { name: "Operations home and health" });
  const h2 = scope.getByRole("link", { name: "Home H2" });
  await h2.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).searchParams.get("home")).toBe("H2");
  expect(new URL(page.url()).searchParams.get("scenario")).toBe("normal");
  await expect(page.getByTestId("metric-To ship")).toHaveText("6");
  await expect(page.getByText("TEST-SH-1044", { exact: true })).toBeVisible();
  if (width === 390) {
    await page.getByRole("link", { name: "To ship", exact: true }).click();
    expect(new URL(page.url()).searchParams.get("view")).toBe("orders");
    expect(new URL(page.url()).searchParams.get("home")).toBe("H2");
    const card = page.getByRole("listitem").filter({ hasText: "TEST-SH-1044" });
    await card.getByRole("link", { name: "View source record" }).click();
    await expect(page).toHaveURL(url => url.pathname === "/orders/TEST-SH-1044" && url.searchParams.get("home") === "H2");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TEST-SH-1044");
    await page.goBack();
    expect(new URL(page.url()).searchParams.get("home")).toBe("H2");
  }
});

test("Chrome's 200% text preference doubles text and keeps the scoped record and recovery controls reachable", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "This check uses Chromium's actual default font-size preference.");
  test.slow();
  const cdp = await page.context().newCDPSession(page);
  for (const width of page.viewportSize()!.width < 768 ? [320, 390, 768] : [1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const standard of [16, 32]) {
      await cdp.send("Page.setFontSizes", { fontSizes: { standard } });
      for (const route of ["/operations?home=H2", "/design-system/states"]) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (route.startsWith("/operations")) {
          await expect(page.getByTestId("metric-To ship")).toHaveText("6");
          await expect(page.getByText("TEST-SH-1044", { exact: true })).toBeVisible();
        } else {
          const keep = page.getByRole("button", { name: "Keep task" });
          await keep.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByTestId("kept-status")).toBeVisible();
        }
        const layout = await page.evaluate(() => ({
          body: parseFloat(getComputedStyle(document.body).fontSize),
          heading: parseFloat(getComputedStyle(document.querySelector("h1")!).fontSize),
          width: document.documentElement.scrollWidth,
        }));
        expect(layout, `${route} at ${width}px with ${standard}px browser text`).toEqual({ body: standard * 0.875, heading: standard * 1.875, width });
      }
    }
  }
});

test("uncertain recovery remains read-only and the accessible tree presents the source step before any retry", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/design-system/states");
  const recovery = page.getByTestId("state-uncertain");
  const tree = await recovery.ariaSnapshot();
  expect(tree).toContain("Confirm the send before retrying");
  expect(tree).toContain("Retry disabled");
  expect(tree).toContain("Reconcile in source");
  const retry = recovery.getByRole("button", { name: "Retry disabled" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/design-system\/states$/);
  await recovery.getByRole("link", { name: "Reconcile in source" }).click();
  await expect(page).toHaveURL(/\/runs\/demo-run-uncertain/);
  const violations = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.violations.map(v => v.id)).toEqual([]);
});

test("field borders, focus rings and selected tabs have sufficient contrast in the rendered app", async ({ page }) => {
  await page.goto("/automations/zap-12/schedule");
  const field = page.getByRole("textbox", { name: "Local time" });
  await expect(field).toBeVisible();
  const contrasts = async (selector: "border" | "outline", expected: number) => {
    const ratio = await field.evaluate((node, kind) => {
      const style = getComputedStyle(node);
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(v => Number(v) / 255);
        return rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
      };
      const foreground = luminance(kind === "border" ? style.borderColor : style.outlineColor);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    }, selector);
    expect(ratio).toBeGreaterThanOrEqual(expected);
  };
  await contrasts("border", 3);
  await field.focus();
  await expect(field).toBeFocused();
  await expect(field).toHaveCSS("outline-style", "solid");
  await contrasts("outline", 3);
  await page.goto("/settings/capabilities");
  const current = page.getByRole("navigation", { name: "Capability sections" }).getByRole("link", { name: "Capabilities", exact: true });
  await expect(current).toHaveAttribute("aria-current", "page");
  await current.focus();
  await expect(current).toHaveCSS("outline-style", "solid");
  await expect(current).toHaveCSS("color", "rgb(101, 71, 245)");
  await expect(current).toHaveCSS("background-color", "rgb(240, 236, 255)");
});
