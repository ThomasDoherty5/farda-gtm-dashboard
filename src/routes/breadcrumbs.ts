import { matchPath } from "react-router-dom";
import { sourceScreens } from "./manifest.generated";
import { primaryNav, sectionOf } from "./nav";

/** One step of the trail. It is text, not a link: see `breadcrumbsFor`. */
export type Crumb = { label: string };

/** "ACQ03 Daily sourcing and invitation plan" reads "Daily sourcing and invitation plan". Design codes are not for readers. */
const clean = (name: string) => name.replace(/^ACQ\d+\s+/, "");

/** The manifest entry for a path: one whose selecting query values all match, else the first that matches the path. */
function screenFor(pathname: string, search: URLSearchParams) {
  const candidates = sourceScreens.filter((s) => matchPath({ path: s.path, end: true }, pathname));
  return candidates.find((s) => Object.entries(s.query).length > 0 && Object.entries(s.query).every(([k, v]) => search.get(k) === v)) ?? candidates.find((s) => Object.keys(s.query).length === 0) ?? candidates[0] ?? null;
}

/**
 * Where the reader is: the primary section, the page, and the record when the address names one. Derived from the route manifest and
 * navigation, so it can't disagree with them. It is an orientation trail, not a set of links: the primary navigation already
 * links every section, and a second link named like a section, tab or page would be a duplicate control (FHC-05).
 */
export function breadcrumbsFor(pathname: string, rawSearch = ""): Crumb[] {
  const search = new URLSearchParams(rawSearch);
  const section = primaryNav.find((item) => (item.sections as readonly string[]).includes(sectionOf(pathname)));
  const screen = screenFor(pathname, search);
  const crumbs: Crumb[] = [];
  if (section) crumbs.push({ label: section.label });
  if (screen) {
    const params = matchPath({ path: screen.path, end: true }, pathname)?.params ?? {};
    const record = Object.values(params).filter((v): v is string => Boolean(v)).at(-1) ?? null;
    const registeredRun = screen.path === "/runs/:runId" && record?.startsWith("rt-run-");
    crumbs.push({ label: registeredRun ? "Registered source run" : clean(screen.screen) });
    if (record) crumbs.push({ label: record });
  }
  return crumbs.length ? crumbs : [{ label: "Page not found" }];
}
