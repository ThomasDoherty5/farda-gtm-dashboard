/**
 * Creator Offer Economics v1 reward ladder: a recommendation pending owner approval, not a live commercial activation.
 * Every figure is synthetic demo data. Amounts are minor units (cents) in USD. Nothing here purchases, reserves or pays out.
 */
import { DEMO_OFFER_DRAFT_ID } from "./scorecards";

export const REWARD_CURRENCY = "USD" as const;
/** CEO-v1 recommended creator commission. The offer draft's own rate is a separate illustration. */
export const CEO_V1_COMMISSION_PCT = 20;

export type TierId = "tech" | "phone" | "vacation";
export type RewardTier = {
  id: TierId;
  label: string;
  /** Canonical matured revenue that unlocks this milestone. */
  thresholdMinor: number;
  /** The allowance added at this milestone. */
  additionalMinor: number;
  /** Cumulative allowance after this milestone. */
  cumulativeCapMinor: number;
};

/** AirPods/tech $300 at $6,000; phone $1,200 additional at $30,000; vacation $5,000 additional at $130,000. Caps $300/$1,500/$6,500. */
export const REWARD_LADDER: readonly RewardTier[] = [
  { id: "tech", label: "AirPods / tech", thresholdMinor: 600_000, additionalMinor: 30_000, cumulativeCapMinor: 30_000 },
  { id: "phone", label: "Phone", thresholdMinor: 3_000_000, additionalMinor: 120_000, cumulativeCapMinor: 150_000 },
  { id: "vacation", label: "Vacation", thresholdMinor: 13_000_000, additionalMinor: 500_000, cumulativeCapMinor: 650_000 },
];
/** The draft's illustrative average net order, used only to translate thresholds into approximate order counts. */
export const EXAMPLE_NET_ORDER_MINOR = 4000;

/** Share of matured revenue the draft treats as commerce cost, with processing on commission. Taken from the offer draft's assumptions. */
export const COST_PCT_OF_NET = 45;
export const PROCESSING_PCT_OF_COMMISSION = 2.9;

export type BatchStatus = "matured" | "pending" | "excluded";
/** A group of orders from one source. `canonicalId` is shared by mirrors of the same orders, so they count once. */
export type RevenueBatch = {
  /** Source row id; differs between a source and its mirror. */
  rowId: string;
  /** The canonical id that carries the batch across providers. */
  canonicalId: string;
  source: "shopify" | "tiktok-shop" | "shopify-mirror";
  orders: number;
  netMinor: number;
  refundedMinor: number;
  status: BatchStatus;
  /** Why a batch is excluded, when it is. */
  exclusionReason?: string;
};

/** A milestone event. A replayed delivery carries the same eventId and never claims twice. */
export type MilestoneEvent = { eventId: string; tier: TierId; at: string };
export type Redemption = { tier: TierId; amountMinor: number; at: string };
export type Selection = { tier: TierId; state: "selected" | "notSelected"; item: string | null; selectedAt: string | null };

export type RewardScenarioId =
  | "zero-sales"
  | "pending-qualification"
  | "partial-refund"
  | "refund-after-claim"
  | "milestone-unlock"
  | "replay"
  | "existing-redemption"
  | "source-mirror-duplicate"
  | "delayed-selection"
  | "incomplete-evidence";

export type RewardScenario = {
  scenarioId: RewardScenarioId;
  label: string;
  description: string;
  batches: RevenueBatch[];
  events: MilestoneEvent[];
  selections: Selection[];
  /** Null amounts are unknown, not zero. */
  redemptions: { tier: TierId; amountMinor: number | null; at: string }[];
  /** Provider and cost evidence for the reward purchase. Incomplete evidence keeps contribution unknown. */
  costEvidence: "complete" | "incomplete";
  /** New reward commitments are paused; earned obligations remain. */
  newCommitmentsPaused: boolean;
};

export type RewardsRecord = {
  offerId: string;
  version: string;
  scenario: RewardScenario;
  scenarios: { scenarioId: RewardScenarioId; label: string }[];
  /** Always true in this build: nothing is approved by the owner and nothing is purchased. */
  ownerApproval: "pending";
};

const b = (rowId: string, canonicalId: string, source: RevenueBatch["source"], orders: number, netMinor: number, refundedMinor: number, status: BatchStatus, exclusionReason?: string): RevenueBatch => ({ rowId, canonicalId, source, orders, netMinor, refundedMinor, status, ...(exclusionReason ? { exclusionReason } : {}) });
const notSelected = (tier: TierId): Selection => ({ tier, state: "notSelected", item: null, selectedAt: null });

export const REWARD_SCENARIOS: readonly RewardScenario[] = [
  {
    scenarioId: "zero-sales",
    label: "Zero sales",
    description: "No orders have been attributed yet. Matured revenue is a known $0, not unknown.",
    batches: [],
    events: [],
    selections: [],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "pending-qualification",
    label: "Pending qualification",
    description: "Orders exist but none has passed the return window, so none counts toward a milestone.",
    batches: [b("TEST-BATCH-P1", "TEST-CAN-P1", "shopify", 90, 360_000, 0, "pending"), b("TEST-BATCH-P2", "TEST-CAN-P2", "tiktok-shop", 40, 160_000, 0, "pending")],
    events: [],
    selections: [],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "partial-refund",
    label: "Partial refund",
    description: "Gross matured sales pass $6,000, but refunds bring the canonical total back under the threshold.",
    batches: [b("TEST-BATCH-R1", "TEST-CAN-R1", "shopify", 160, 640_000, 60_000, "matured")],
    events: [],
    selections: [],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "refund-after-claim",
    label: "Refund after a claim",
    description: "The first milestone was claimed, then a refund brought matured revenue back under $6,000. The earned allowance is preserved and the refund is shown as a separate adjustment.",
    batches: [b("TEST-BATCH-RC1", "TEST-CAN-RC1", "shopify", 160, 640_000, 60_000, "matured")],
    events: [{ eventId: "TEST-EVT-RC1", tier: "tech", at: "2026-10-30T16:00:00Z" }],
    selections: [notSelected("tech")],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "milestone-unlock",
    label: "Milestone unlock",
    description: "Canonical matured revenue passes $6,000, so the first milestone is earned and the $300 allowance is outstanding.",
    batches: [b("TEST-BATCH-U1", "TEST-CAN-U1", "shopify", 120, 480_000, 0, "matured"), b("TEST-BATCH-U2", "TEST-CAN-U2", "tiktok-shop", 40, 160_000, 0, "matured")],
    events: [{ eventId: "TEST-EVT-U1", tier: "tech", at: "2026-10-30T16:00:00Z" }],
    selections: [notSelected("tech")],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "replay",
    label: "Replayed milestone event",
    description: "The same unlock event was delivered three times. The milestone is claimed once.",
    batches: [b("TEST-BATCH-U1", "TEST-CAN-U1", "shopify", 160, 640_000, 0, "matured")],
    events: [
      { eventId: "TEST-EVT-U1", tier: "tech", at: "2026-10-30T16:00:00Z" },
      { eventId: "TEST-EVT-U1", tier: "tech", at: "2026-10-30T16:00:00Z" },
      { eventId: "TEST-EVT-U1", tier: "tech", at: "2026-10-31T09:12:00Z" },
    ],
    selections: [{ tier: "tech", state: "selected", item: "AirPods (example)", selectedAt: "2026-10-31T10:00:00Z" }],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "existing-redemption",
    label: "Existing redemption",
    description: "The first reward was redeemed. The second milestone is earned; new reward commitments are paused but earned obligations stay.",
    batches: [b("TEST-BATCH-X1", "TEST-CAN-X1", "shopify", 600, 2_400_000, 90_000, "matured"), b("TEST-BATCH-X2", "TEST-CAN-X2", "tiktok-shop", 180, 720_000, 0, "matured")],
    events: [{ eventId: "TEST-EVT-X1", tier: "tech", at: "2026-08-12T16:00:00Z" }, { eventId: "TEST-EVT-X2", tier: "phone", at: "2026-10-20T16:00:00Z" }],
    selections: [{ tier: "tech", state: "selected", item: "AirPods (example)", selectedAt: "2026-08-14T10:00:00Z" }, notSelected("phone")],
    redemptions: [{ tier: "tech", amountMinor: 30_000, at: "2026-08-20T10:00:00Z" }],
    costEvidence: "complete",
    newCommitmentsPaused: true,
  },
  {
    scenarioId: "source-mirror-duplicate",
    label: "Source mirror duplicate",
    description: "A mirror row repeats the same canonical orders. Revenue counts once, so the total stays under $6,000.",
    batches: [b("TEST-BATCH-M1", "TEST-CAN-M1", "shopify", 120, 480_000, 0, "matured"), b("TEST-BATCH-M1-MIRROR", "TEST-CAN-M1", "shopify-mirror", 120, 480_000, 0, "matured")],
    events: [],
    selections: [],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "delayed-selection",
    label: "Delayed selection",
    description: "The milestone was earned weeks ago and the creator has not picked a reward. The obligation stays outstanding and is not forgotten.",
    batches: [b("TEST-BATCH-D1", "TEST-CAN-D1", "shopify", 170, 680_000, 0, "matured"), b("TEST-BATCH-D2", "TEST-CAN-D2", "shopify", 30, 120_000, 0, "excluded", "Test orders removed from qualification")],
    events: [{ eventId: "TEST-EVT-D1", tier: "tech", at: "2026-09-28T16:00:00Z" }],
    selections: [notSelected("tech")],
    redemptions: [],
    costEvidence: "complete",
    newCommitmentsPaused: false,
  },
  {
    scenarioId: "incomplete-evidence",
    label: "Incomplete cost evidence",
    description: "A reward was selected but the provider quote and landed cost are missing. Redeemed amount and Farda contribution are unknown, not $0.",
    batches: [b("TEST-BATCH-C1", "TEST-CAN-C1", "shopify", 180, 720_000, 0, "matured")],
    events: [{ eventId: "TEST-EVT-C1", tier: "tech", at: "2026-10-25T16:00:00Z" }],
    selections: [{ tier: "tech", state: "selected", item: "AirPods (example)", selectedAt: "2026-10-26T10:00:00Z" }],
    redemptions: [{ tier: "tech", amountMinor: null, at: "2026-10-27T10:00:00Z" }],
    costEvidence: "incomplete",
    newCommitmentsPaused: false,
  },
];

export const rewardScenario = (id: string) => REWARD_SCENARIOS.find((s) => s.scenarioId === id) ?? null;
export const DEFAULT_REWARD_SCENARIO: RewardScenarioId = "milestone-unlock";

export function rewardsRecord(scenarioId: string): RewardsRecord | null {
  const scenario = rewardScenario(scenarioId);
  if (!scenario) return null;
  return {
    offerId: DEMO_OFFER_DRAFT_ID,
    version: "rewards-v1",
    scenario: structuredClone(scenario),
    scenarios: REWARD_SCENARIOS.map(({ scenarioId: id, label }) => ({ scenarioId: id, label })),
    ownerApproval: "pending",
  };
}
