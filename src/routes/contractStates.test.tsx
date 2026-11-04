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

const settle = async () => {
  // Wait for the first read to resolve one way or the other.
  await waitFor(() => expect(main().textContent?.trim().length).toBeGreaterThan(0), { timeout: 3000 });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
};
/** The visible words, with a space where elements meet (textContent runs them together). */
const text = () => main().innerHTML.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");

const SAYS: Record<Exclude<Fault, "loading" | "all-unknown" | "all-zero" | "offline">, RegExp> = {
  unauthenticated: /sign in/i,
  forbidden: /(no access|permission|denied|can't|cannot)/i,
  "integration-pending": /(not connected|unavailable|isn't connected|not yet)/i,
  empty: /(nothing|\bempty\b|\bno\b[^.]{0,40}(data|record|row|result|match)|not found)/i,
  partial: /(missing|\bpartial\b|incomplete|covers? only|showing \d+ of|not all|only these)/i,
  stale: /(out of date|\bstale\b|\bbehind\b|not current|last successful)/i,
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

  it("while loading, says so and shows no data", async () => {
    render("loading");
    await settle();
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
    expect(SAYS[fault].test(text()), `${fault} isn't stated. It says: ${text().replace(/\s+/g, " ").slice(0, 400)}`).toBe(true);
    expect(dataIn(main())).toHaveLength(0);
    expect(document.querySelector("[data-testid='demo-banner']") === null).toBe(fault === "integration-pending");
  });

  it.each(["empty", "partial", "stale"] as const)("on a %s read, says so and never invents a number", async (fault) => {
    render(fault);
    await settle();
    expect(SAYS[fault].test(text()), `a ${fault} read isn't stated on the page. It says: ${text().replace(/\s+/g, " ").slice(0, 700)}`).toBe(true);
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
});
