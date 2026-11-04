import { DEFAULT_PIPELINE_FILTERS, type PipelineFilters } from "@/fixtures/pipeline";

export const FACETS = {
  source: [{ value: "both", label: "Both" }, { value: "social-cat", label: "Social Cat" }, { value: "tiktok-shop", label: "TikTok Shop" }],
  route: [{ value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }],
  network: [{ value: "all", label: "All" }, { value: "instagram", label: "Instagram" }, { value: "tiktok", label: "TikTok" }],
  checkout: [{ value: "all", label: "All" }, { value: "website", label: "Website" }, { value: "tiktok-shop", label: "TikTok Shop" }],
  window: [{ value: "sep-oct", label: "Sep 01–Oct 30" }, { value: "sep", label: "Sep 01–Sep 30" }, { value: "oct", label: "Oct 01–Oct 30" }],
  policy: [{ value: "all", label: "All" }, { value: "policy-2026-09", label: "2026-09" }, { value: "policy-2026-10", label: "2026-10" }],
} as const satisfies Record<keyof PipelineFilters, { value: string; label: string }[]>;
export const FACET_NAMES: Record<keyof PipelineFilters, string> = { source: "source", route: "route", policy: "policy version", network: "publishing network", checkout: "checkout destination", window: "cohort window" };

export const allowed = <K extends keyof PipelineFilters>(key: K, raw: string | null): PipelineFilters[K] =>
  (FACETS[key].some((o) => o.value === raw) ? raw : DEFAULT_PIPELINE_FILTERS[key]) as PipelineFilters[K];

/** The non-default filters as a query string, so the branches view and the way back keep the selection. */
export const carriedSearch = (filters: PipelineFilters) => {
  const q = new URLSearchParams();
  for (const k of Object.keys(DEFAULT_PIPELINE_FILTERS) as (keyof PipelineFilters)[]) if (filters[k] !== DEFAULT_PIPELINE_FILTERS[k]) q.set(k, filters[k]);
  return q.toString();
};
export const parseFilters = (search: URLSearchParams): PipelineFilters => ({
  source: allowed("source", search.get("source")),
  route: allowed("route", search.get("route")),
  network: allowed("network", search.get("network")),
  checkout: allowed("checkout", search.get("checkout")),
  window: allowed("window", search.get("window")),
  policy: allowed("policy", search.get("policy")),
});
