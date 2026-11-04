import { appendFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { OVERLAY_NAMES } from "./support/prototypeEdges";
import { DIFFERENCES } from "./support/prototypeDifferences";
import { COVERED, frames, overlays, walkOverlay, walkScreen, type Result } from "./support/prototypeWalk";

/**
 * Every edge of the Figma prototype against the built app, one test per frame. An edge must either work, or be listed in
 * support/prototypeDifferences.ts with the kind of difference (docs/design-map.md explains each kind). So a regression
 * (a link removed) fails here, and so does a listed difference that now works (the list must stay true).
 * Run with EDGE_REPORT=/path/report.jsonl to keep the measured data.
 */
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, "The prototype is drawn at desktop width; mobile layout is covered by responsive.spec.ts");

const key = (r: Result) => `${r.frame}|${r.label}>${r.target}`;
const keep = (rs: Result[]) => { if (process.env.EDGE_REPORT) for (const r of rs) appendFileSync(process.env.EDGE_REPORT, JSON.stringify(r) + "\n"); };
function check(rs: Result[]) {
  keep(rs);
  expect(rs.length).toBeGreaterThan(0);
  const unexplained = rs.filter((r) => !COVERED.has(r.status) && !(key(r) in DIFFERENCES)).map((r) => `${key(r)} (${r.status}${r.note ? `: ${r.note}` : ""})`);
  const stale = rs.filter((r) => COVERED.has(r.status) && key(r) in DIFFERENCES).map(key);
  expect(unexplained, "edges that don't work and aren't recorded as a difference").toEqual([]);
  expect(stale, "recorded differences that now work: remove them from prototypeDifferences.ts").toEqual([]);
}

for (const f of frames()) {
  test(`screen ${f}`, async ({ page }) => {
    test.setTimeout(120_000);
    check(await walkScreen(page, f));
  });
}
for (const o of overlays()) {
  test(`overlay ${o} ${OVERLAY_NAMES[o]}`, async ({ page }) => {
    test.setTimeout(120_000);
    check(await walkOverlay(page, o));
  });
}
