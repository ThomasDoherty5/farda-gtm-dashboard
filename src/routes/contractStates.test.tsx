import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { allDemoRoutes } from "@/test/demoRoutes";
import { faultAdapter, type Fault } from "@/test/faultAdapter";
import { renderRoute } from "@/test/renderWithAdapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";

/**
 * The contract states on every route (fixtures FX-01 to FX-15 and the state rows of the control contract): each screen is
 * driven with a loading, unauthenticated (401), forbidden (403), empty, partial, stale and integration-pending read, and
 * must say so in words, show no data it can't stand behind, and never turn an unknown into a number.
 *
 * Checks are the same for every route, so a new screen can't skip them. What a route legitimately doesn't read (static
 * indexes, the state gallery) is listed in STATIC with the reason.
 */
const STATIC: Record<string, string> = {
  "/design-system/states": "A development gallery of the recovery states. It reads nothing.",
};

/** Containers a screen uses for protected data. When a read fails or hasn't answered, none of these may be on the page. */
const DATA = "table, dl, [data-testid^='metric-'], [role='img'], svg";
const dataIn = (root: HTMLElement) => [...root.querySelectorAll(DATA)].filter((el) => !el.closest("nav, header, [aria-label='Primary']"));
const main = () => document.getElementById("main") ?? document.body;

const isLoading = () => [...main().querySelectorAll("[role=status]")].some((e) => /^\s*Loading/.test(e.textContent ?? ""));
const settle = async ({ loaded = true }: { loaded?: boolean } = {}) => {
  // Wait for the first read to resolve one way or the other. Lazy routes first show their own "Loading page…" status, so the
  // page is not settled until no loading status is left (otherwise a state is judged before the route has rendered anything).
  await waitFor(() => expect(main().textContent?.trim().length).toBeGreaterThan(0), { timeout: 3000 });
  if (loaded) await waitFor(() => expect(isLoading()).toBe(false), { timeout: 6000 }).catch(() => undefined);
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
};
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
/** The visible words, with a space where elements meet (textContent runs them together). */
const text = () => words(main().innerHTML);

/**
 * The state region: the places a screen says what happened to its read. An alert, a status line, a read-state notice (view-stale,
 * view-partial) or an empty/denied/error state. The assertions below read only this, never the whole page, so a word in a table
 * header or a paragraph elsewhere (a "missing" in running copy, a "behind" in a label) can't satisfy a state it doesn't state.
 */
const REGION = "[role=alert], [role=status], [data-testid^='view-'], [data-empty-state]";
const region = () => [...main().querySelectorAll(REGION)].map((e) => words(e.innerHTML)).filter(Boolean).join(" | ");

type Stated = "unauthenticated" | "forbidden" | "integration-pending" | "empty" | "partial" | "stale";
/** What the state region must say. Tight on purpose: each phrase is the screen's own wording for that state. Empty is the explicit marker instead (see `stated`). */
const SAYS: Record<Exclude<Stated, "empty">, RegExp> = {
  unauthenticated: /sign in again/i,
  forbidden: /no access to this account/i,
  "integration-pending": /not connected yet/i,
  partial: /(\b(is|are) missing\b|\bpartial\b|incomplete|covers? only|not all|only these|weren't read)/i,
  stale: /(out of date|\bstale\b|\bbehind\b|not current|last successful)/i,
};
const STATES = ["unauthenticated", "forbidden", "integration-pending", "empty", "partial", "stale"] as const satisfies readonly Stated[];
/** True when the state region states `state`. Empty is the EmptyState marker, not a phrase. */
const stated = (state: Stated): boolean => state === "empty" ? main().querySelector("[data-empty-state='Empty']") !== null : SAYS[state].test(region());

/**
 * Demo pages that already state a fault with no fault injected, with the reason. For these the control must say it (so this list
 * cannot rot), and the injected fault must change what the region says (so the assertion still depends on the fault).
 */
const DEMO_ALREADY_STATES: Partial<Record<Stated, Record<string, string>>> = {
  partial: {
    "/customers/activation": "The demo activation cohort is itself a partial export, and the page says so.",
    "/settings/connections": "The demo connection list is itself partial (some health observations were not read), and the page says so.",
  },
};

/** Standalone zero-looking values and unknown words in the visible text. */
const zeros = () => (text().match(/(^|\s)[$]?0([.,]0+)?%?(?=\s|$)/g) ?? []).length;

const routes = allDemoRoutes().filter((r) => !(r.split("?")[0]! in STATIC));

vi.setConfig({ testTimeout: 20_000 });

describe.each(routes)("%s", (route) => {
  afterEach(() => cleanup());
  const render = (fault: Fault) => renderRoute(route, faultAdapter(fault));

  it("never prints NaN, undefined or null as a value, with data or without", async () => {
    renderRoute(route, createDemoAdapter());
    await settle();
    await waitFor(() => expect(main().querySelector("[role=status]")?.textContent ?? "").not.toMatch(/^Loading/), { timeout: 3000 }).catch(() => undefined);
    expect(text()).not.toMatch(/\b(NaN|undefined|Infinity|null)\b|\[object Object\]/);
  });

  // The control. An assertion that the page states a fault only means something if the same page, with no fault, does not already
  // state it. So before any state is checked, the un-faulted page is read and each state's words must be absent from its region
  // (or the route is listed in DEMO_ALREADY_STATES with the reason, and must really say it).
  it("control: the page with no fault injected states none of the faults the checks below look for", async () => {
    renderRoute(route, createDemoAdapter());
    await settle();
    expect(isLoading(), "the demo page is still loading, so it was not judged").toBe(false);
    const already = STATES.filter(stated);
    const allowed = STATES.filter((st) => route.split("?")[0]! in (DEMO_ALREADY_STATES[st] ?? {}) || route in (DEMO_ALREADY_STATES[st] ?? {}));
    expect(already, `the demo page already states ${already.join(", ")}, so those checks could pass without the fault. Region: ${region().slice(0, 300)}`).toEqual(allowed);
  });

  it("while loading, says so and shows no data", async () => {
    render("loading");
    // The source read is intentionally unresolved: wait for the real page module, not for its loading state to disappear.
    await settle({ loaded: false });
    await waitFor(() => expect(screen.queryByTestId("page-loading")).not.toBeInTheDocument(), { timeout: 6000 });
    expect(screen.getAllByRole("status").some((el) => /loading/i.test(el.textContent ?? ""))).toBe(true);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(dataIn(main())).toHaveLength(0);
  });

  it("offline (FX-07), before any data arrived, says the service can't be reached and offers a retry, with no data", async () => {
    render("offline");
    await waitFor(() => expect(screen.queryAllByRole("alert").length).toBeGreaterThan(0), { timeout: 3000 });
    expect(text()).toMatch(/(could not be reached|unavailable|couldn't|could not be loaded)/i);
    expect(dataIn(main())).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /try again/i }) ?? screen.queryByRole("button", { name: /retry/i }), "no way to retry").not.toBeNull();
  });

  it.each(["unauthenticated", "forbidden", "integration-pending"] as const)("on %s, says so in words and clears protected data", async (fault) => {
    render(fault);
    await waitFor(() => expect(screen.queryAllByRole("alert").length).toBeGreaterThan(0), { timeout: 3000 });
    expect(stated(fault), `${fault} isn't stated in the state region. Region: ${region().slice(0, 400)}`).toBe(true);
    expect(dataIn(main())).toHaveLength(0);
    expect(document.querySelector("[data-testid='demo-banner']") === null).toBe(fault === "integration-pending");
  });

  it.each(["empty", "partial", "stale"] as const)("on a %s read, says so in the state region and never invents a number", async (fault) => {
    renderRoute(route, createDemoAdapter());
    await settle();
    const before = region();
    const alreadySays = stated(fault);
    cleanup();
    render(fault);
    await settle();
    expect(stated(fault), `a ${fault} read isn't stated in the state region. Region: ${region().slice(0, 500)}`).toBe(true);
    // Where the demo page already states it, the injected fault must still change what the page says.
    if (alreadySays) expect(region(), "the injected fault changed nothing the page says").not.toBe(before);
    expect(text()).not.toMatch(/\b(NaN|undefined|Infinity|null)\b|\[object Object\]/);
  });

  it("is labeled as demo data, with the banner in the shell", async () => {
    renderRoute(route, createDemoAdapter());
    await settle();
    expect(screen.getByTestId("demo-banner")).toHaveTextContent(/demo/i);
  });

  it("an unknown stays unknown: turning every value unknown never adds a zero, and never prints NaN", async () => {
    renderRoute(route, createDemoAdapter());
    await settle();
    const baseline = zeros();
    cleanup();
    render("all-unknown");
    await settle();
    expect(zeros(), `values reported as unknown now read as zero. Page: ${text().slice(0, 500)}`).toBeLessThanOrEqual(baseline);
    expect(text()).not.toMatch(/\b(NaN|undefined|Infinity)\b|\[object Object\]/);
  });

  it("a known zero stays a zero: turning every known number to 0 shows at least as many zeros, and never prints NaN", async () => {
    renderRoute(route, createDemoAdapter());
    await settle();
    const baseline = zeros();
    cleanup();
    render("all-zero");
    await settle();
    // Ratios over a zero denominator are N/A on purpose; what must not happen is a measured zero going missing.
    expect(zeros(), `a measured zero is no longer shown. Page: ${text().slice(0, 500)}`).toBeGreaterThanOrEqual(baseline);
    expect(text()).not.toMatch(/\b(NaN|undefined|Infinity)\b|\[object Object\]/);
  });

  it("plain numbers set to 0 never crash the page or print NaN, and no zero goes missing", async () => {
    renderRoute(route, createDemoAdapter());
    await settle();
    const baseline = zeros();
    cleanup();
    render("all-zero-plain");
    await settle();
    const bad = text().match(/.{0,60}\b(NaN|undefined|Infinity)\b.{0,30}|\[object Object\]/g);
    expect(bad, "printed NaN, undefined or Infinity").toBeNull();
    expect(zeros(), `a measured zero is no longer shown when plain numeric fields are 0. Page: ${text().slice(0, 500)}`).toBeGreaterThanOrEqual(baseline);
  });
});
