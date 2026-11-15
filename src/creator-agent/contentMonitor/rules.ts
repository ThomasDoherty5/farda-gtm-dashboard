import { digest } from "../config.ts";
import type { FunnelEvent } from "../funnelContract.ts";
import { projectFunnel } from "../funnelProjection.ts";
import type { J08FardaEvidence, J08Network } from "./contract.ts";

export type FardaAssignment = { state: "attributed" | "review" | "unrelated"; campaignId: string | null; reason: string; receipts: string[] };

/**
 * J08-04. A post is Farda campaign content only when reviewed, campaign-specific evidence names exactly one campaign in which the
 * creator is currently enrolled. Creator identity alone, unreviewed evidence, brand-only evidence and several named campaigns
 * all stay in review. A post with no Farda evidence is unrelated. Neither inflates Farda activity.
 */
export function fardaAssignment(evidence: J08FardaEvidence[], enrolledCampaigns: readonly string[]): FardaAssignment {
  const receipts = [...new Set(evidence.map(e => e.receiptRef))].sort();
  if (!evidence.length) return { state: "unrelated", campaignId: null, reason: "NO_FARDA_EVIDENCE", receipts };
  const reviewed = evidence.filter(e => e.reviewed);
  if (!reviewed.length) return { state: "review", campaignId: null, reason: "FARDA_EVIDENCE_UNREVIEWED", receipts };
  const named = [...new Set(reviewed.flatMap(e => e.campaignId === null ? [] : [e.campaignId]))].sort();
  if (named.length > 1) return { state: "review", campaignId: null, reason: "MULTIPLE_CAMPAIGNS_EVIDENCED", receipts };
  if (!named.length) return { state: "review", campaignId: null, reason: enrolledCampaigns.length > 1 ? "BRAND_ONLY_CONCURRENT_CAMPAIGNS" : "BRAND_ONLY_EVIDENCE", receipts };
  if (!enrolledCampaigns.includes(named[0]!)) return { state: "review", campaignId: null, reason: "CAMPAIGN_NOT_ENROLLED", receipts };
  return { state: "attributed", campaignId: named[0]!, reason: "REVIEWED_CAMPAIGN_EVIDENCE",
    receipts: [...new Set(reviewed.filter(e => e.campaignId === named[0]).map(e => e.receiptRef))].sort() };
}

/**
 * Comparable post-age checkpoints. An observation captures only the highest configured checkpoint it has reached that is above every
 * checkpoint already captured; it is labeled with its actual age. A later fetch never backfills an earlier checkpoint.
 */
export function checkpointCapture(publishedAt: string | null, observedAt: string, hours: readonly number[], captured: readonly number[]) {
  if (!publishedAt) return null;
  const age = (Date.parse(observedAt) - Date.parse(publishedAt)) / 3_600_000;
  const floor = captured.length ? Math.max(...captured) : 0;
  const reached = hours.filter(h => h <= age && h > floor);
  if (!reached.length) return null;
  return { hours: Math.max(...reached), actualAgeHours: Math.round(age * 10) / 10 };
}

const sourceIdOf = (ref: { canonicalId: string | null; sourceId: string | null } | null | undefined) => ref?.canonicalId ?? ref?.sourceId ?? null;
export type OrderAttribution = {
  level: "post" | "creator" | "campaign" | "unknown"; receipt: string; window: string; version: string; complete: boolean;
  orders: number | null; net: { minorUnits: number; currency: string } | null; gmv: null; gmvDefinition: null;
};

/**
 * J08-06. Joins the canonical funnel order ledger (retained orders and refunds keyed by canonical order ID, so an order imported from
 * TikTok Shop into Shopify is one order) at the best proven level. Orders without a post assignment are creator-wide: they never
 * prove post-level sales. Missing evidence is unknown, never zero.
 */
export function orderAttribution(content: { network: J08Network; postId: string; creatorId: string; campaignId: string },
  events: FunnelEvent[], asOf: string): { attribution: OrderAttribution | null; reason: string } {
  const cohort = events.filter(e => (e.eventType === "retainedOrder" || e.eventType === "refund") &&
    sourceIdOf(e.creatorRef) === content.creatorId && sourceIdOf(e.campaignCohortRef) === content.campaignId);
  if (!cohort.length) return { attribution: null, reason: "NO_AUTHORITATIVE_ORDER_EVIDENCE" };
  const windows = new Set(cohort.map(e => e.details.attributionWindow)), versions = new Set(cohort.map(e => e.details.attributionVersion));
  const currencies = new Set(cohort.map(e => e.details.currency));
  if (windows.size !== 1 || versions.size !== 1 || currencies.size !== 1) return { attribution: null, reason: "ATTRIBUTION_BASIS_MIXED" };
  const postsByOrder = new Map<string, Set<string>>();
  for (const e of cohort) {
    const posts = postsByOrder.get(e.details.orderId!) ?? new Set<string>();
    posts.add(e.details.postId ? JSON.stringify([e.network, e.details.postId]) : "creator-wide");
    postsByOrder.set(e.details.orderId!, posts);
  }
  if ([...postsByOrder.values()].some(posts => posts.size > 1)) return { attribution: null, reason: "ORDER_ASSIGNMENT_CONFLICT" };
  const complete = cohort.every(e => e.evidenceRef.access === "verified" && !e.details.blockers.length && e.details.retainedMinor != null &&
    e.maturationAt !== null && Date.parse(e.maturationAt) <= Date.parse(asOf));
  const creatorWide = cohort.some(e => !e.details.postId);
  const linked = creatorWide ? cohort : cohort.filter(e => e.network === content.network && e.details.postId === content.postId);
  const base = { receipt: `funnel-${digest(cohort.map(e => e.evidenceRef.provenanceRef).sort())}`, window: [...windows][0]!,
    version: [...versions][0]!, gmv: null, gmvDefinition: null, complete };
  const currency = [...currencies][0]!;
  if (!complete) return { attribution: { ...base, level: creatorWide ? "creator" : "post", orders: null, net: null }, reason: "ORDER_EVIDENCE_IMMATURE_OR_BLOCKED" };
  if (!linked.length) return { attribution: { ...base, level: "post", orders: 0, net: { minorUnits: 0, currency } }, reason: "NO_ORDER_ASSIGNED_TO_POST" };
  const outcomes = projectFunnel(linked, {}, asOf).outcomes;
  const orders = outcomes.find(m => m.name === "Attributed orders")?.value ?? null, net = outcomes.find(m => m.name === "Attributed net sales")?.value ?? null;
  return { attribution: { ...base, level: creatorWide ? "creator" : "post", orders, net: net === null ? null : { minorUnits: net, currency } },
    reason: creatorWide ? "CREATOR_WIDE_ORDER_EVIDENCE" : "POST_ASSIGNED_ORDER_EVIDENCE" };
}
