import { sourceScreens } from "./manifest.generated";

const LABELS: Record<string, string> = { "design-system": "Design system", automations: "Automations" };
const label = (seg: string) => LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);

/** Top-level sections: one per first path segment in the source manifest, Overview first. */
export const navSections = (() => {
  const segs = [...new Set(sourceScreens.map((s) => s.path.split("/")[1] ?? ""))];
  segs.sort((a, b) => (a === "overview" ? -1 : b === "overview" ? 1 : 0));
  return segs.map((seg) => ({ seg, path: `/${seg}`, label: label(seg) }));
})();
