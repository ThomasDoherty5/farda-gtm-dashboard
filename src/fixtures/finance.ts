/**
 * Finance fixtures (Figma sources 65:1037, 66:252, 66:447, 9:551) — SYNTHETIC and ILLUSTRATIVE.
 * "COMM-DEMO-*" are local fixture groups, not API identifiers. Amounts are minor units (USD cents). Everything the screens
 * total is derived from the group rows. A paid receipt is immutable: a later reversal is an adjustment, never a rewrite.
 * New acquisition is commission-only; the $150 fee is a historical, accepted obligation. Do not mix with other datasets.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { known, unknown, usd } from "./values";

export type CommissionState = "held" | "disputed" | "awaitingProvider" | "paid";

export type CommissionGroup = {
  id: string;
  grossSales: number;
  netBase: number;
  earned: number;
  reversed: number;
  state: CommissionState;
  /** Provider-side facts for the read-only evidence panel. */
  evidence: { receipt: string | null; note: string };
};

export const netAccrued = (g: CommissionGroup) => g.earned - g.reversed;
export const STATE_LABEL: Record<CommissionState, string> = { held: "Held", disputed: "Disputed", awaitingProvider: "Awaiting provider", paid: "Paid" };

export type CommissionLedger = {
  datasetKey: "finance-demo";
  version: string;
  cohortLabel: string;
  groups: CommissionGroup[];
  economics: { commerceCosts: number; historicalFixedFee: number; samples: number; processingFeePct: number };
  orders: { initial: number; retained: number; refundedBeforeFulfillment: number };
  currency: "USD";
  observedAt: string;
};

export const ledgerDemo = (): CommissionLedger => ({
  datasetKey: "finance-demo",
  version: "led1",
  cohortLabel: "Affiliate pilot · synthetic cohort B",
  groups: [
    { id: "COMM-DEMO-A", grossSales: 80000, netBase: 60000, earned: 12000, reversed: 3000, state: "held", evidence: { receipt: null, note: "A $200 refund reversed $30 of earned commission. The provider holds the balance until its review deadline." } },
    { id: "COMM-DEMO-B", grossSales: 20000, netBase: 20000, earned: 3000, reversed: 0, state: "disputed", evidence: { receipt: null, note: "The provider records a dispute on this group. The amount stays in the accrual until the source resolves it." } },
    { id: "COMM-DEMO-C", grossSales: 40000, netBase: 40000, earned: 6000, reversed: 0, state: "awaitingProvider", evidence: { receipt: null, note: "Eligibility is recorded in the provider. Payout waits for the provider's own schedule." } },
    { id: "COMM-DEMO-D", grossSales: 60000, netBase: 60000, earned: 9000, reversed: 0, state: "paid", evidence: { receipt: "TEST-RCPT-0090", note: "Paid by the provider. The receipt is immutable; any later reversal is recorded as an adjustment." } },
  ],
  economics: { commerceCosts: 81000, historicalFixedFee: 15000, samples: 10000, processingFeePct: 2.9 },
  orders: { initial: 50, retained: 45, refundedBeforeFulfillment: 5 },
  currency: "USD",
  observedAt: "2026-11-02T17:00:00.000Z",
});

/** Every figure the ledger screen shows, derived from the group rows so cards, bar, table and chart can't disagree. */
export function ledgerTotals(l: CommissionLedger) {
  const sum = (f: (g: CommissionGroup) => number) => l.groups.reduce((n, g) => n + f(g), 0);
  const grossSales = sum((g) => g.grossSales);
  const netSales = sum((g) => g.netBase);
  const earned = sum((g) => g.earned);
  const reversed = sum((g) => g.reversed);
  const accrued = earned - reversed;
  const byState = (s: CommissionState) => l.groups.filter((g) => g.state === s).reduce((n, g) => n + netAccrued(g), 0);
  const fee = Math.round((accrued * l.economics.processingFeePct) / 100);
  const contribution = netSales - l.economics.commerceCosts - l.economics.historicalFixedFee - l.economics.samples - accrued - fee;
  return { grossSales, netSales, refunds: grossSales - netSales, earned, reversed, accrued, held: byState("held"), disputed: byState("disputed"), awaiting: byState("awaitingProvider"), paid: byState("paid"), fee, contribution, contributionPct: (100 * contribution) / netSales };
}

export type MatchCandidate = { statementRef: string; groupId: string; amount: Money; period: string; evidence: string; problem: "duplicate" | "conflict" | null };

export type SettlementProvider = "collabs" | "tiktok";
export type SettlementRecord = {
  datasetKey: "finance-demo";
  settlementId: string;
  provider: SettlementProvider;
  version: string;
  group: CommissionGroup;
  retainedOrders: number;
  eligibleMerchandise: number;
  ratePct: number;
  /** "Unmatched" until an authoritative statement is matched. Never inferred. */
  invoiceState: "unmatched" | "matched";
  processingFeePct: number;
  candidates: MatchCandidate[];
  submitted: { state: string; actionRef: string } | null;
  /** TikTok native rates. Unknown until read from the connected source. */
  rates: { lane: "standard" | "shopAds"; active: ProvenanceValue<number>; proposed: "Draft" }[];
};

export const settlementDemo = (settlementId: string): SettlementRecord | null => {
  if (settlementId !== "COMM-DEMO-D" && settlementId !== "TT-NATIVE-DEMO") return null;
  const group = ledgerDemo().groups.find((g) => g.id === "COMM-DEMO-D")!;
  return {
    datasetKey: "finance-demo",
    settlementId,
    provider: settlementId === "TT-NATIVE-DEMO" ? "tiktok" : "collabs",
    version: "st1",
    group,
    retainedOrders: 15,
    eligibleMerchandise: 4000,
    ratePct: 15,
    invoiceState: "unmatched",
    processingFeePct: 2.9,
    candidates: [
      { statementRef: "STMT-DEMO-0001", groupId: "COMM-DEMO-D", amount: usd(9000), period: "Oct 1–31, 2026", evidence: "Provider statement line, paid event TEST-RCPT-0090", problem: null },
      { statementRef: "STMT-DEMO-0002", groupId: "COMM-DEMO-D", amount: usd(9000), period: "Oct 1–31, 2026", evidence: "A second statement line with the same amount and period", problem: "duplicate" },
    ],
    submitted: null,
    rates: [
      { lane: "standard", active: unknown("RATE_NOT_READ"), proposed: "Draft" },
      { lane: "shopAds", active: unknown("RATE_NOT_READ"), proposed: "Draft" },
    ],
  };
};

export type PayableDetail = {
  datasetKey: "finance-demo";
  payableId: string;
  version: string;
  amount: ProvenanceValue<Money>;
  handle: string;
  collaboration: string;
  evidence: string;
  invoiceRef: string;
  budgetCategory: string;
  /** The first step not yet done. Approval, execution and reconciliation are separate steps. */
  stage: "requested" | "founderApproval" | "execution" | "settled" | "posted" | "reconciled";
  providerTransaction: string | null;
  settlementStatus: string;
  quickbooksRef: string | null;
  reconciliation: string;
  approvalRef: string;
};

export const payableDemo = (payableId: string): PayableDetail | null =>
  payableId === "PAY-0012"
    ? { datasetKey: "finance-demo", payableId, version: "pay1", amount: known(usd(15000)), handle: "@routine.with.ella", collaboration: "COL-SC-042", evidence: "Final content accepted", invoiceRef: "INV-0084", budgetCategory: "Creator / UGC", stage: "founderApproval", providerTransaction: null, settlementStatus: "Not paid", quickbooksRef: null, reconciliation: "Waiting for settlement", approvalRef: "demo-approval-042" }
    : null;

export const PAYABLE_STAGES: { key: PayableDetail["stage"]; title: string; note: string }[] = [
  { key: "requested", title: "Requested", note: "Amount + basis captured" },
  { key: "founderApproval", title: "Founder approval", note: "Current step" },
  { key: "execution", title: "Execution", note: "Authorized payment action" },
  { key: "settled", title: "Settled", note: "Provider receipt verified" },
  { key: "posted", title: "Posted", note: "QuickBooks entry linked" },
  { key: "reconciled", title: "Reconciled", note: "Ledger matched" },
];
