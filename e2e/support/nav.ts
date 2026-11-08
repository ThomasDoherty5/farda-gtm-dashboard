import type { Page } from "@playwright/test";

/** Opens the workspace menu with whichever control the current width shows: the profile button, "More" (1024) or "Menu" (390). */
export async function openWorkspaceMenu(page: Page) {
  await page.getByRole("button", { name: /^(.+, open workspace menu|More|Menu)$/ }).click();
}

/**
 * Goes to a primary section from the header, or, when the header has collapsed it (Figma 12:708 and 12:653), from the menu's Sections list.
 * Keeps one spec valid at every width.
 */
export async function openSection(page: Page, name: string) {
  const inHeader = page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true });
  if (await inHeader.isVisible()) return inHeader.click();
  await openWorkspaceMenu(page);
  await page.getByRole("dialog").getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true }).click();
}
