import { sourceScreens } from "./manifest.generated";

const label = (seg: string) => seg.charAt(0).toUpperCase() + seg.slice(1);

/** Development QA surfaces (handoff section 6). Routable by URL, never in primary navigation. */
const NOT_IN_NAV = new Set(["design-system"]);

/** Top-level sections: one per first path segment in the source manifest, Overview first. */
export const navSections = (() => {
  const segs = [...new Set(sourceScreens.map((s) => s.path.split("/")[1] ?? ""))].filter((seg) => !NOT_IN_NAV.has(seg));
  segs.sort((a, b) => (a === "overview" ? -1 : b === "overview" ? 1 : 0));
  return segs.map((seg) => ({ seg, path: `/${seg}`, label: label(seg) }));
})();
