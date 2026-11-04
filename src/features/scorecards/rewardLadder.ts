import {
  CEO_V1_COMMISSION_PCT,
  COST_PCT_OF_NET,
  EXAMPLE_NET_ORDER_MINOR,
  PROCESSING_PCT_OF_COMMISSION,
  REWARD_LADDER,
  type RewardScenario,
  type RewardTier,
  type TierId,
} from "@/fixtures/rewards";

/** A known amount, or unknown with the reason. Unknown is never rendered or summed as zero. */
export type Amount = { state: "known"; minor: number } | { state: "unknown"; reason: string };
export const known = (minor: number): Amount => ({ state: "known", minor });
export const unknown = (reason: string): Amount => ({ state: "unknown", reason });

export type TierStatus = {
  tier: RewardTier;
  /** Canonical matured revenue has reached the threshold. */
  earned: boolean;
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
  const seen = new Set<string>();
  const duplicateRowIds: string[] = [];
  let gross = 0;
  let refunded = 0;
  let pending = 0;
  let pendingOrders = 0;
  let excluded = 0;
  for (const batch of s.batches) {
    if (seen.has(batch.canonicalId)) {
      duplicateRowIds.push(batch.rowId);
      continue;
    }
    seen.add(batch.canonicalId);
    if (batch.status === "matured") {
      gross += batch.netMinor;
      refunded += batch.refundedMinor;
    } else if (batch.status === "pending") {
      pending += batch.netMinor;
      pendingOrders += batch.orders;
    } else excluded += batch.netMinor;
  }
  const matured = gross - refunded;

  const tiers: TierStatus[] = REWARD_LADDER.map((tier) => {
    const earned = matured >= tier.thresholdMinor;
    const events = s.events.filter((e) => e.tier === tier.id);
    const distinct = new Set(events.map((e) => e.eventId));
    const claimedAt = earned && events.length ? [...events].sort((x, y) => x.at.localeCompare(y.at))[0]!.at : null;
    const sel = s.selections.find((x) => x.tier === tier.id);
    const red = s.redemptions.find((x) => x.tier === tier.id);
    return {
      tier,
      earned,
      claimedAt,
      replays: events.length - distinct.size,
      selection: !earned ? "locked" : sel?.state === "selected" ? "selected" : "notSelected",
      selectedItem: sel?.item ?? null,
      redeemed: red ? (red.amountMinor === null ? unknown("Provider quote and landed cost are missing") : known(red.amountMinor)) : null,
    };
  });

  const earnedMinor = tiers.filter((t) => t.earned).reduce((sum, t) => sum + t.tier.additionalMinor, 0);
  const redemptions = tiers.flatMap((t) => (t.redeemed ? [t.redeemed] : []));
  const unknownRedemption = redemptions.find((r) => r.state === "unknown");
  const redeemedKnown = redemptions.reduce((sum, r) => sum + (r.state === "known" ? r.minor : 0), 0);
  const redeemed: Amount = unknownRedemption ? unknown("A redemption has no cost evidence") : known(redeemedKnown);
  const outstanding: Amount = redeemed.state === "known" ? known(earnedMinor - redeemed.minor) : unknown("Outstanding depends on an unknown redemption");

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
