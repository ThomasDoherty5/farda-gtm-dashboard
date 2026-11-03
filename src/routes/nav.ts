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

/** Primary navigation from Figma node 10:219, with destinations from the prototype. */
export const primaryNav = [
  { label: "Overview", to: "/overview", width: 122, sections: ["overview", "launch", "analytics"] },
  { label: "Creators", to: "/creators/social-cat?view=dashboard", width: 122, sections: ["creators", "collaborations", "approvals", "offers", "batches", "content", "campaigns"] },
  { label: "Operations", to: "/operations", width: 122, sections: ["operations", "orders", "shipments", "returns", "inventory", "support", "customers"] },
  { label: "Finance", to: "/finance", width: 122, sections: ["finance"] },
  { label: "Automations", to: "/automations", width: 146, sections: ["automations", "settings", "runs"] },
] as const;

/** Workspace menu from Figma overlay 42:1890. Approvals and Runs are added because no other control reaches them yet. */
export const workspaceLinks = [
  { label: "Customer lifecycle", to: "/customers/lifecycle" },
  { label: "Launch control", to: "/launch?view=control" },
  { label: "Analytics workspace", to: "/analytics/attribution" },
  { label: "Team and permissions", to: "/settings/team" },
  { label: "Connections", to: "/settings/connections" },
  { label: "Approvals", to: "/approvals" },
  { label: "Runs", to: "/runs" },
] as const;
