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
 * Comparable post-age checkpoints. An observation captures a checkpoint only inside that checkpoint's versioned tolerance. A fetch
 * past the tolerance is a late observation, labeled with its actual age; it never fills the checkpoint and is labeled once.
 */
export function checkpointCapture(publishedAt: string | null, observedAt: string, slots: readonly { hours: number; toleranceHours: number }[],
  recorded: readonly number[]): { state: "captured" | "late"; hours: number; actualAgeHours: number } | null {
  if (!publishedAt) return null;
  const age = (Date.parse(observedAt) - Date.parse(publishedAt)) / 3_600_000, actualAgeHours = Math.round(age * 10) / 10;
  const open = slots.find(s => s.hours <= age && age <= s.hours + s.toleranceHours && !recorded.includes(s.hours));
  if (open) return { state: "captured", hours: open.hours, actualAgeHours };
  const missed = slots.filter(s => s.hours + s.toleranceHours < age).at(-1);
  if (missed && !recorded.includes(missed.hours)) return { state: "late", hours: missed.hours, actualAgeHours };
  return null;
}

const sourceIdOf = (ref: { canonicalId: string | null; sourceId: string | null } | null | undefined) => ref?.canonicalId ?? ref?.sourceId ?? null;
export type OrderAttribution = {
  level: "post" | "creator" | "campaign" | "unknown"; receipt: string; window: string; version: string; complete: boolean;
  orders: number | null; net: { minorUnits: number; currency: string } | null; gmv: null; gmvDefinition: null;
};

/**
 * J08-06. Joins the canonical funnel order ledger (retained orders and refunds keyed by canonical order ID, so an order imported from
 * TikTok Shop into Shopify is one order) at the best proven level. A refund inherits its order's post assignment; only differing explicit
 * post IDs conflict. Orders without a post assignment are creator-wide and never prove post-level sales. A post-level result, including a
 * zero, needs complete evidence and that post's own matured attribution window. Missing evidence is unknown, never zero.
 */
export function orderAttribution(content: { network: J08Network; postId: string; creatorId: string; campaignId: string; publishedAt: string | null },
  events: FunnelEvent[], asOf: string, windows: readonly { attributionVersion: string; hours: number }[]): { attribution: OrderAttribution | null; reason: string } {
  const cohort = events.filter(e => (e.eventType === "retainedOrder" || e.eventType === "refund") &&
    sourceIdOf(e.creatorRef) === content.creatorId && sourceIdOf(e.campaignCohortRef) === content.campaignId);
  if (!cohort.length) return { attribution: null, reason: "NO_AUTHORITATIVE_ORDER_EVIDENCE" };
  const windowsSeen = new Set(cohort.map(e => e.details.attributionWindow)), versions = new Set(cohort.map(e => e.details.attributionVersion));
  const currencies = new Set(cohort.map(e => e.details.currency));
  if (windowsSeen.size !== 1 || versions.size !== 1 || currencies.size !== 1) return { attribution: null, reason: "ATTRIBUTION_BASIS_MIXED" };
  const assignment = new Map<string, Set<string>>();
  for (const e of cohort) {
    const posts = assignment.get(e.details.orderId!) ?? new Set<string>();
    if (e.details.postId) posts.add(JSON.stringify([e.network, e.details.postId]));
    assignment.set(e.details.orderId!, posts);
  }
  if ([...assignment.values()].some(posts => posts.size > 1)) return { attribution: null, reason: "ORDER_ASSIGNMENT_CONFLICT" };
  const evidenceComplete = cohort.every(e => e.evidenceRef.access === "verified" && !e.details.blockers.length && e.details.retainedMinor != null &&
    e.maturationAt !== null && Date.parse(e.maturationAt) <= Date.parse(asOf));
  const version = [...versions][0]!, currency = [...currencies][0]!;
  const base = { receipt: `funnel-${digest(cohort.map(e => e.evidenceRef.provenanceRef).sort())}`, window: [...windowsSeen][0]!, version, gmv: null, gmvDefinition: null };
  const totals = (rows: FunnelEvent[]) => {
    const outcomes = projectFunnel(rows, {}, asOf).outcomes;
    const net = outcomes.find(m => m.name === "Attributed net sales")?.value ?? null;
    return { orders: outcomes.find(m => m.name === "Attributed orders")?.value ?? null, net: net === null ? null : { minorUnits: net, currency } };
  };
  if ([...assignment.values()].some(posts => posts.size === 0))
    return { attribution: { ...base, level: "creator", complete: evidenceComplete, ...(evidenceComplete ? totals(cohort) : { orders: null, net: null }) },
      reason: "CREATOR_WIDE_ORDER_EVIDENCE" };
  const hours = windows.find(w => w.attributionVersion === version)?.hours;
  if (hours === undefined) return { attribution: { ...base, level: "post", complete: false, orders: null, net: null }, reason: "ATTRIBUTION_WINDOW_UNCONFIGURED" };
  const matured = content.publishedAt !== null && Date.parse(content.publishedAt) + hours * 3_600_000 <= Date.parse(asOf);
  if (!matured || !evidenceComplete) return { attribution: { ...base, level: "post", complete: false, orders: null, net: null },
    reason: matured ? "ORDER_EVIDENCE_IMMATURE_OR_BLOCKED" : "POST_ATTRIBUTION_WINDOW_OPEN" };
  const self = JSON.stringify([content.network, content.postId]);
  const linked = cohort.filter(e => assignment.get(e.details.orderId!)!.has(self));
  if (!linked.length) return { attribution: { ...base, level: "post", complete: true, orders: 0, net: { minorUnits: 0, currency } }, reason: "MATURED_NO_ORDER_ASSIGNED_TO_POST" };
  return { attribution: { ...base, level: "post", complete: true, ...totals(linked) }, reason: "POST_ASSIGNED_ORDER_EVIDENCE" };
}
