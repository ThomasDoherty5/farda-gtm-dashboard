import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Runs axe with the project's tag set. No rule is disabled and nothing is excluded. */
export async function axeViolations(page: Page, label: string): Promise<string[]> {
  // Cast: @axe-core/playwright resolves its own playwright-core, so the Page types differ by version.
  const results = await new AxeBuilder({ page: page as never }).withTags(WCAG_TAGS).analyze();
  return results.violations.map((v) => `${label}  ${v.id} (${v.impact}): ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}${v.nodes.length > 4 ? ` +${v.nodes.length - 4} more` : ""}`);
}

/** Splits a list into `n` roughly equal groups, so the sweep runs on several workers. */
export function chunk<T>(items: T[], n: number): T[][] {
  const size = Math.ceil(items.length / n);
  return Array.from({ length: n }, (_, i) => items.slice(i * size, (i + 1) * size)).filter((c) => c.length > 0);
}
