import { test } from "@playwright/test";

test("diag close heights", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440");
  await page.goto("/finance/close/2026-10");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("main *").forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.height === 0) return;
      out.push(`${i} ${el.tagName} ${Math.round(r.width * 10) / 10}x${Math.round(r.height * 10) / 10} ${(el.children.length ? "" : el.textContent ?? "").slice(0, 40)}`);
    });
    return out;
  });
  console.log("DIAG-START\n" + rows.join("\n") + "\nDIAG-END");
});
