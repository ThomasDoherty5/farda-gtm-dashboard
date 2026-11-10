import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { renderRoute } from "@/test/renderWithAdapter";

afterEach(cleanup);
it.each([
  ["/overview?report-start=2026-10-01T00%3A00%3A00Z&report-end=2026-11-01T00%3A00%3A00Z&report-zone=UTC#metrics", "Primary", "Overview"],
  ["/analytics/attribution?report-start=2026-10-01T00%3A00%3A00Z&report-end=2026-11-01T00%3A00%3A00Z&report-zone=UTC", "Overview sections", "Performance"],
  ["/launch?view=control&readinessRequestKey=fictional-original-key", "Overview sections", "Launch control"],
])("reselecting the current %s preserves scope and the existing history entry", async (path, navigation, label) => {
  const router = renderRoute(path, createDemoAdapter()), user = userEvent.setup();
  const nav = await screen.findByRole("navigation", { name: navigation });
  const link = await within(nav).findByRole("link", { name: label, exact: true });
  expect(link).toHaveAttribute("aria-current", "page");
  expect(link).toHaveAttribute("href", path);
  const original = router.state.location;
  await user.click(link);
  expect(router.state.location).toEqual(original);
  expect(router.state.historyAction).toBe("POP");
  link.focus(); await user.keyboard("{Enter}");
  expect(router.state.location).toEqual(original);
  await user.click(screen.getByRole("button", { name: "TD, open workspace menu" }));
  const menu = (await screen.findByRole("heading", { name: "Explore the Farda workspace.", hidden: true })).closest("dialog")!;
  const current = within(menu).getByRole("link", { name: label === "Performance" ? "Analytics workspace" : label, exact: true, hidden: true });
  expect(current).toHaveAttribute("href", path);
  await user.click(current);
  expect(router.state.location).toEqual(original);
});
