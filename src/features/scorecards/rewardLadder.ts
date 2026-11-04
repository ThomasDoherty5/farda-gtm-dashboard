import {
  CEO_V1_COMMISSION_PCT,
  COST_PCT_OF_NET,
  EXAMPLE_NET_ORDER_MINOR,
  PROCESSING_PCT_OF_COMMISSION,
  REWARD_LADDER,
  type RewardScenario,
  type RevenueBatch,
  type RewardTier,
  type TierId,
} from "@/fixtures/rewards";

/** A known amount, or unknown with the reason. Unknown is never rendered or summed as zero. */
export type Amount = { state: "known"; minor: number } | { state: "unknown"; reason: string };
export const known = (minor: number): Amount => ({ state: "known", minor });
export const unknown = (reason: string): Amount => ({ state: "unknown", reason });

export type TierStatus = {
  tier: RewardTier;
  /** Matured revenue reached the threshold, or the milestone was claimed or redeemed. An earned obligation is preserved: a later refund never takes it back. */
  earned: boolean;
  /** Earned, but matured revenue is now under the threshold because of a refund after the claim. */
  belowThreshold: boolean;
  /** How far under the threshold matured revenue sits when `belowThreshold`, else 0. A separate adjustment, never deducted from earned or outstanding. */
  shortfallMinor: number;
  /** First unlock event for the milestone, if any. A replay never adds a second claim. */
  claimedAt: string | null;
  replays: number;
  selection: "selected" | "notSelected" | "locked";
  selectedItem: string | null;
  redeemed: Amount | null;
};

export type RewardSummary = {
  maturedMinor: number;
  grossMaturedMinor: number;
  /** Refunds beyond the matured revenue they apply to. Matured revenue is clamped at $0 and the excess is reported here. */
  refundExcessMinor: number;
  /** Claimed or redeemed milestones whose threshold a later refund pushed matured revenue back under. */
  refundAdjustments: { tier: TierId; shortfallMinor: number }[];
  refundedMinor: number;
  pendingMinor: number;
  pendingOrders: number;
  excludedMinor: number;
  duplicateRowIds: string[];
  tiers: TierStatus[];
  next: { tier: RewardTier; remainingMinor: number; progressPct: number } | null;
  earnedMinor: number;
  redeemed: Amount;
  outstanding: Amount;
  creatorCommissionMinor: number;
  fardaContribution: Amount;
  orderEquivalents: Record<TierId, number>;
};

const cents = (n: number) => Math.round(n);

/** Canonical matured revenue: matured batches net of refunds, each canonical id once, pending and excluded batches left out. */
export function summarize(s: RewardScenario): RewardSummary {
  const duplicateRowIds: string[] = [];
  let gross = 0;
  let refunded = 0;
  let pending = 0;
  let pendingOrders = 0;
  let excluded = 0;
  for (const batch of resolveCanonical(s.batches, duplicateRowIds)) {
    if (batch.status === "matured") {
      gross += batch.netMinor;
      refunded += batch.refundedMinor;
    } else if (batch.status === "pending") {
      pending += batch.netMinor;
      pendingOrders += batch.orders;
    } else excluded += batch.netMinor;
  }
  const net = gross - refunded;
  const matured = Math.max(0, net);
  const refundExcessMinor = net < 0 ? -net : 0;

  const tiers: TierStatus[] = REWARD_LADDER.map((tier) => {
    const events = s.events.filter((e) => e.tier === tier.id);
    const distinct = new Set(events.map((e) => e.eventId));
    const sel = s.selections.find((x) => x.tier === tier.id);
    const red = s.redemptions.find((x) => x.tier === tier.id);
    const reached = matured >= tier.thresholdMinor;
    // A claim or a redemption is the record that the obligation exists. Only an unclaimed milestone can be lost to a refund.
    const earned = reached || events.length > 0 || red !== undefined;
    const claimedAt = earned && events.length ? [...events].sort((x, y) => x.at.localeCompare(y.at))[0]!.at : null;
    return {
      tier,
      earned,
      belowThreshold: earned && !reached,
      shortfallMinor: earned && !reached ? tier.thresholdMinor - matured : 0,
      claimedAt,
      replays: events.length - distinct.size,
      selection: !earned ? "locked" : sel?.state === "selected" || red !== undefined ? "selected" : "notSelected",
      selectedItem: sel?.item ?? null,
      redeemed: red ? (red.amountMinor === null ? unknown("Provider quote and landed cost are missing") : known(red.amountMinor)) : null,
    };
  });

  const earnedMinor = tiers.filter((t) => t.earned).reduce((sum, t) => sum + t.tier.additionalMinor, 0);
  const redemptions = tiers.flatMap((t) => (t.redeemed ? [t.redeemed] : []));
  const unknownRedemption = redemptions.find((r) => r.state === "unknown");
  const redeemedKnown = redemptions.reduce((sum, r) => sum + (r.state === "known" ? r.minor : 0), 0);
  const redeemed: Amount = unknownRedemption ? unknown("A redemption has no cost evidence") : known(redeemedKnown);
  const outstanding: Amount = redeemed.state === "known" ? known(Math.max(0, earnedMinor - redeemed.minor)) : unknown("Outstanding depends on an unknown redemption");

  const nextTier = tiers.find((t) => !t.earned)?.tier ?? null;
  const next = nextTier ? { tier: nextTier, remainingMinor: nextTier.thresholdMinor - matured, progressPct: Math.max(0, Math.min(100, (100 * matured) / nextTier.thresholdMinor)) } : null;

  const commission = cents((matured * CEO_V1_COMMISSION_PCT) / 100);
  const fardaContribution: Amount =
    s.costEvidence === "incomplete"
      ? unknown("Provider and cost evidence is incomplete")
      : known(cents(matured - (matured * COST_PCT_OF_NET) / 100 - commission - (commission * PROCESSING_PCT_OF_COMMISSION) / 100 - earnedMinor));

  return {
    maturedMinor: matured,
    grossMaturedMinor: gross,
    refundExcessMinor,
    refundAdjustments: tiers.filter((t) => t.belowThreshold).map((t) => ({ tier: t.tier.id, shortfallMinor: t.shortfallMinor })),
    refundedMinor: refunded,
    pendingMinor: pending,
    pendingOrders,
    excludedMinor: excluded,
    duplicateRowIds,
    tiers,
    next,
    earnedMinor,
    redeemed,
    outstanding,
    creatorCommissionMinor: commission,
    fardaContribution,
    orderEquivalents: Object.fromEntries(REWARD_LADDER.map((t) => [t.id, Math.ceil(t.thresholdMinor / EXAMPLE_NET_ORDER_MINOR)])) as Record<TierId, number>,
  };
}

const STATUS_RANK: Record<RevenueBatch["status"], number> = { excluded: 0, pending: 1, matured: 2 };

/**
 * One batch per canonical id, chosen without regard to input order: a source row beats a mirror, then the more conservative
 * status wins (excluded, then pending, then matured), then the lower row id. A mirror never promotes orders the source has
 * not matured. The rows not chosen are appended to `ignored`, sorted.
 */
function resolveCanonical(batches: RevenueBatch[], ignored: string[]): RevenueBatch[] {
  const better = (a: RevenueBatch, b: RevenueBatch) => {
    const mirror = Number(a.source === "shopify-mirror") - Number(b.source === "shopify-mirror");
    if (mirror) return mirror < 0;
    if (a.status !== b.status) return STATUS_RANK[a.status] < STATUS_RANK[b.status];
    return a.rowId.localeCompare(b.rowId) < 0;
  };
  const chosen = new Map<string, RevenueBatch>();
  for (const batch of batches) {
    const held = chosen.get(batch.canonicalId);
    if (!held) chosen.set(batch.canonicalId, batch);
    else if (better(batch, held)) {
      ignored.push(held.rowId);
      chosen.set(batch.canonicalId, batch);
    } else ignored.push(batch.rowId);
  }
  ignored.sort();
  return [...chosen.values()];
}

/** The status line for one ladder row. Redeemed outranks "not selected": a redeemed tier may have no selection record. */
export function tierStatusText(t: TierStatus, money: (minor: number) => string): string {
  if (!t.earned) return "";
  if (t.redeemed) return t.redeemed.state === "known" ? `Redeemed ${money(t.redeemed.minor)}` : "Redeemed · cost unknown";
  return t.selection === "notSelected" ? "Reward not selected yet" : "Selected, not redeemed";
}
