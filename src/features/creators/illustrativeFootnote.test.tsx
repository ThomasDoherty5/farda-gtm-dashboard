import { cleanup, screen, waitFor } from "@testing-library/react";
import type { FardaAdapter } from "@/adapter/adapter";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

/**
 * "Illustrative" says the figures are made-up demo content, so it may only appear when the adapter is the demo. Here a non-demo
 * environment answers with the same rows (as a sandbox that returned data would): the footnote must be gone while the data stays.
 */
const nonDemo = (): FardaAdapter => {
  const base = createDemoAdapter();
  const readView = async (request: Parameters<FardaAdapter["readView"]>[0], options?: { signal?: AbortSignal }) => {
    const res = await base.readView({ ...request, requestedScope: { ...request.requestedScope, environment: "demo" } }, options);
    return { ...res, scope: { ...res.scope, environment: "sandbox" as const } };
  };
  return { ...base, environment: "sandbox", readView: readView as FardaAdapter["readView"] };
};
const BOARDS = [
  { route: "/creators/social-cat?view=board", footnote: /Illustrative creator handles and counts/ },
  { route: "/creators/tiktok?view=board", footnote: /Illustrative funnel/ },
];

describe.each(BOARDS)("$route", ({ route, footnote }) => {
  afterEach(() => cleanup());
  it("shows its Illustrative footnote on the demo adapter", async () => {
    renderRoute(route, createDemoAdapter());
    expect(await screen.findByText(footnote)).toBeInTheDocument();
  });
  it("does not show it when the environment is not demo, even with data on the page", async () => {
    renderRoute(route, nonDemo());
    await screen.findByText(/^Loading the/); // the read has started...
    await waitFor(() => expect(screen.queryByText(/^Loading the/)).toBeNull(), { timeout: 4000 }); // ...and has been answered
    expect(screen.queryAllByRole("alert"), "the read failed, so there is no data on the page to carry the footnote").toHaveLength(0);
    expect(screen.queryByText(footnote)).toBeNull();
  });
});
