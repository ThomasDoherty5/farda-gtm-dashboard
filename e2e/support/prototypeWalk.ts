import { expect, type Locator, type Page } from "@playwright/test";
import { sourceScreens } from "../../src/routes/manifest.generated";
import { OVERLAY_NAMES, PROTOTYPE_EDGES } from "./prototypeEdges";

/**
 * Walks the Figma prototype's edges against the built app. For each screen frame it opens the matching route and, for each
 * edge the prototype draws, checks that the app has the same navigation (a link to the target route) or the same overlay
 * (a control that opens a dialog Escape closes). It reports what it finds; it does not decide what a gap means.
 */
export type Status =
  | "navigates" //            a control with the prototype's label goes to the target route
  | "link-to-target" //       the page links to the target route under another label
  | "opens-dialog" //         a control with the prototype's label opens a dialog, and Escape closes it
  | "opens-other" //          the control exists but does something else
  | "overlay-other-label" //  not found by label, but the page has the overlay under another name
  | "closes" //              the overlay closes on Escape
  | "missing" //             nothing on the page does this
  | "unreachable" //         the overlay itself cannot be opened from any screen
  | "viewport-only"; //      the frame is a responsive variant of a route covered elsewhere

export const COVERED = new Set<Status>(["navigates", "link-to-target", "opens-dialog", "closes", "overlay-other-label", "viewport-only"]);

export type Result = { frame: string; label: string; target: string; status: Status; note?: string };

/** A concrete demo URL for each screen frame. Dynamic segments need the demo record the fixtures hold, not a made-up id. */
const ROUTES: Record<string, string> = {
  "41:1781": "/collaborations/demo-collaboration-1?tab=overview",
  "41:1918": "/collaborations/demo-collaboration-1?tab=content",
  "41:1637": "/approvals/demo-approval-042",
  "41:2351": "/runs/demo-run-approval?tab=approval",
  "41:2494": "/runs/demo-run-uncertain?tab=recovery",
  "28:6631": "/runs/demo-run-hourly",
  "41:4026": "/creators/demo-creator-1/assessments/demo-assessment-content",
  "41:4203": "/creators/demo-creator-1/assessments/demo-assessment-tiktok",
  "76:3780": "/creators/demo-creator-1/assessments/demo-assessment-sc-commerce",
  "76:3659": "/offers/demo-offer-1",
  "76:4517": "/batches/demo-batch-tt-024",
  "41:3321": "/content/P-001",
  "41:3677": "/campaigns/demo-campaign-first-wave?tab=funnel",
  "41:2033": "/finance/payables/PAY-0012",
  "76:4102": "/finance/settlements/COMM-DEMO-D",
  "76:4247": "/finance/settlements/TT-NATIVE-DEMO",
  "28:2373": "/finance/close/2026-10",
  "28:1563": "/orders/TEST-SH-1042",
  "28:1709": "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129",
  "28:2966": "/returns/TEST-RET-028",
  "28:3105": "/returns/TEST-RET-028?scenario=resolved",
  "41:2158": "/support/cases/TEST-ISS-021",
  "28:5744": "/automations/zap-12/schedule",
  "28:3557": "/design-system/states",
  "111:7219": "/creators/demo-creator-1/evidence/demo-evidence-1",
};
const concrete = (path: string) => path.replace(/:(\w+)/g, "demo-$1");
export const screenOf = (frame: string) => sourceScreens.find((s) => s.prototypeNodeId === frame);
export function routeOf(frame: string): string | null {
  if (ROUTES[frame]) return ROUTES[frame]!;
  const s = screenOf(frame);
  if (!s) return null;
  const qs = new URLSearchParams(s.query as Record<string, string>).toString();
  return concrete(s.path) + (qs ? `?${qs}` : "");
}

/** Does this URL show the screen the prototype frame is? Shared paths are told apart by the manifest's query, where it has one. */
export function isFrame(url: string, frame: string): boolean {
  const s = screenOf(frame);
  if (!s) return false;
  const u = new URL(url, "http://x");
  const pattern = new RegExp("^" + s.path.replace(/:\w+/g, "[^/]+") + "/?$");
  if (!pattern.test(u.pathname)) return false;
  for (const [k, v] of Object.entries(s.query as Record<string, string>)) if (u.searchParams.get(k) !== v) return false;
  if (frame === "28:6631") return !u.searchParams.get("tab");
  return true;
}

const clean = (label: string) => label.replace(/[→↗]/g, "").replace(/\s+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = (label: string) => new RegExp("^" + escapeRe(clean(label)), "i");

export function control(scope: Page | Locator, label: string): Locator {
  const name = nameRe(label);
  return scope.getByRole("link", { name }).or(scope.getByRole("button", { name })).or(scope.getByRole("tab", { name })).first();
}

async function ready(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("[role=status]")).some((e) => /^Loading/.test(e.textContent ?? "")), undefined, { timeout: 4000 }).catch(() => undefined);
}

const where = (page: Page, route: string) => {
  const u = new URL(page.url());
  const here = u.pathname + u.search;
  return here === route || u.pathname === route.split("?")[0] ? `stays on the page (${here})` : `now at ${here}`;
};

const hrefs = (scope: Page | Locator) => scope.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));

/** Opens every frame's route and classifies each edge. */
export async function walkScreen(page: Page, frame: string): Promise<Result[]> {
  const route = routeOf(frame);
  const edges = PROTOTYPE_EDGES[frame] ?? [];
  const results: Result[] = [];
  const add = (edge: string, status: Status, note?: string) => {
    const i = edge.lastIndexOf(">");
    results.push({ frame, label: edge.slice(0, i), target: edge.slice(i + 1), status, ...(note ? { note } : {}) });
  };
  if (!route || frame === "28:3676" || frame === "28:3731") {
    for (const e of edges) add(e, "viewport-only");
    return results;
  }
  await page.goto(route);
  await ready(page);
  const links = await hrefs(page);
  for (const edge of edges) {
    const i = edge.lastIndexOf(">");
    const label = edge.slice(0, i);
    const target = edge.slice(i + 1);
    if (target === "CLOSE") continue;
    const el = control(page, label);
    const found = (await el.count()) > 0;
    if (target.startsWith("O")) {
      if (!found) { add(edge, "missing", "no control with this label"); continue; }
      await el.click();
      const dialog = page.locator("dialog[open]");
      if (await dialog.count()) {
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        add(edge, "opens-dialog");
      } else add(edge, "opens-other", where(page, route));
      await page.goto(route);
      await ready(page);
      continue;
    }
    const toTarget = links.some((h) => isFrame(h, target));
    if (found) {
      const tag = await el.evaluate((n) => n.tagName);
      await el.click();
      await page.waitForTimeout(60);
      if (isFrame(page.url(), target)) add(edge, "navigates");
      else if (toTarget) add(edge, "link-to-target", `label opens ${tag === "A" ? "a different place" : "a dialog or action"}`);
      else add(edge, "opens-other", where(page, route));
      await page.goto(route);
      await ready(page);
    } else if (toTarget) add(edge, "link-to-target", "different label");
    else add(edge, "missing", "no control with this label and no link to the target");
  }
  return results;
}

/** Overlay frames: find a screen that opens it, open it, and check the overlay's own links and that Escape closes it. */
export async function walkOverlay(page: Page, overlay: string): Promise<Result[]> {
  const edges = PROTOTYPE_EDGES[overlay] ?? [];
  const results: Result[] = [];
  const add = (edge: string, status: Status, note?: string) => {
    const i = edge.lastIndexOf(">");
    results.push({ frame: overlay, label: edge.slice(0, i), target: edge.slice(i + 1), status, ...(note ? { note } : {}) });
  };
  // The first screen-or-overlay edge that opens this overlay, preferring ones whose label is on the built page.
  const openers: { frame: string; label: string }[] = [];
  for (const [f, list] of Object.entries(PROTOTYPE_EDGES)) for (const e of list) if (e.endsWith(">O" + overlay)) openers.push({ frame: f, label: e.slice(0, e.lastIndexOf(">")) });
  const screens = openers.filter((o) => routeOf(o.frame));
  let dialog: Locator | null = null;
  for (const o of screens) {
    const route = routeOf(o.frame)!;
    await page.goto(route);
    await ready(page);
    const el = control(page, o.label);
    if (!(await el.count())) continue;
    await el.click();
    const d = page.locator("dialog[open]").first();
    if (await d.count()) { dialog = d; break; }
  }
  if (!dialog) {
    for (const e of edges) add(e, "unreachable", `no screen opens it (${openers.length} opener${openers.length === 1 ? "" : "s"} in the prototype)`);
    return results;
  }
  const dlinks = await hrefs(dialog);
  // Links are read while the dialog is open; Escape then closes it once for all of the overlay's CLOSE edges.
  const linked = await overlayLinks(overlay, edges, dlinks);
  const closeEdge = edges.find((e) => e.endsWith(">CLOSE"));
  if (closeEdge) {
    await page.keyboard.press("Escape");
    if ((await page.locator("dialog[open]").count()) === 0) add(closeEdge, "closes");
    else add(closeEdge, "missing", "Escape does not close it");
  }
  return results.concat(linked);
}

async function overlayLinks(overlay: string, edges: readonly string[], dlinks: string[]): Promise<Result[]> {
  const out: Result[] = [];
  for (const edge of edges) {
    const i = edge.lastIndexOf(">");
    const target = edge.slice(i + 1);
    if (target === "CLOSE") continue;
    const status: Status = target.startsWith("O") ? "overlay-other-label" : dlinks.some((h) => isFrame(h, target)) ? "link-to-target" : "missing";
    out.push({ frame: overlay, label: edge.slice(0, i), target, status, ...(status === "missing" ? { note: "the dialog has no link to the target" } : {}) });
  }
  return out;
}

export const frames = () => Object.keys(PROTOTYPE_EDGES).filter((f) => !(f in OVERLAY_NAMES));
export const overlays = () => Object.keys(PROTOTYPE_EDGES).filter((f) => f in OVERLAY_NAMES);
