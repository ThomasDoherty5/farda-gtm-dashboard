/**
 * Runtime schemas for the finance view data: commissionLedger, settlementDetail, payableDetail, financeDashboard,
 * periodClose, closePackage, monthsHistory, reportManifest. They validate `ReadResponse.data` only; the envelope is `readResponseSchema(...)` in contract.ts.
 *
 * Choices:
 * - Amounts are whole minor units. Balances, sales and costs reject negatives; figures that can honestly be negative
 *   (cash, burn, year-to-date, contribution per order, a reconciliation difference) use signed integers.
 * - Cash, burn and YTD are provenance values: an unknown YTD or burn is `null` with a reason and is never read as 0,
 *   while a known zero burn (`known(0)`) stays valid.
 * - A paid receipt is immutable and the provider owns payout, so `commissionLedger.currency` is the literal "USD" as in
 *   the fixture type, and `rates[].proposed` is the literal "Draft".
 * - Objects are not `.strict()`: these are read models of ledger figures, not credential-adjacent. The `datasetKey`
 *   literal refuses a payload from another dataset.
 * - The helpers below are repeated in the sibling files on purpose, so each file stands alone.
 */
import { z } from "zod";
import { moneySchema, provenanceValueSchema } from "../contract.ts";

const count = z.number().int().nonnegative();
const signedMinor = z.number().int();
const nonNegativeMoney = moneySchema.extend({ minorUnits: z.number().int().nonnegative() });
const datasetKey = z.literal("finance-demo");

const commissionGroup = z.object({
  id: z.string(),
  grossSales: count,
  netBase: count,
  earned: count,
  reversed: count,
  state: z.enum(["held", "disputed", "awaitingProvider", "paid"]),
  evidence: z.object({ receipt: z.string().nullable(), note: z.string() }),
});

export const commissionLedgerSchema = z.object({
  datasetKey,
  version: z.string(),
  cohortLabel: z.string(),
  groups: z.array(commissionGroup),
  economics: z.object({ commerceCosts: count, historicalFixedFee: count, samples: count, processingFeePct: z.number().finite().nonnegative() }),
  orders: z.object({ initial: count, retained: count, refundedBeforeFulfillment: count }),
  currency: z.literal("USD"),
  observedAt: z.string(),
});

export const settlementDetailSchema = z.object({
  datasetKey,
  settlementId: z.string(),
  provider: z.enum(["collabs", "tiktok"]),
  version: z.string(),
  group: commissionGroup,
  retainedOrders: count,
  eligibleMerchandise: count,
  ratePct: z.number().finite().nonnegative(),
  invoiceState: z.enum(["unmatched", "matched"]),
  processingFeePct: z.number().finite().nonnegative(),
  candidates: z.array(
    z.object({
      statementRef: z.string(),
      groupId: z.string(),
      amount: nonNegativeMoney,
      period: z.string(),
      evidence: z.string(),
      problem: z.enum(["duplicate", "conflict"]).nullable(),
    }),
  ),
  submitted: z.object({ state: z.string(), actionRef: z.string() }).nullable(),
  rates: z.array(z.object({ lane: z.enum(["standard", "shopAds"]), active: provenanceValueSchema(z.number().finite().nonnegative()), proposed: z.literal("Draft") })),
});

export const payableDetailSchema = z.object({
  datasetKey,
  payableId: z.string(),
  version: z.string(),
  amount: provenanceValueSchema(nonNegativeMoney),
  handle: z.string(),
  collaboration: z.string(),
  evidence: z.string(),
  invoiceRef: z.string(),
  budgetCategory: z.string(),
  stage: z.enum(["requested", "founderApproval", "execution", "settled", "posted", "reconciled"]),
  providerTransaction: z.string().nullable(),
  settlementStatus: z.string(),
  quickbooksRef: z.string().nullable(),
  reconciliation: z.string(),
  approvalRef: z.string(),
});

export const financeDashboardSchema = z.object({
  datasetKey,
  version: z.string(),
  period: z.object({ label: z.string(), days: z.literal(30) }),
  pnl: z.object({ revenue: signedMinor, cogs: signedMinor, opex: signedMinor, ytd: provenanceValueSchema(signedMinor) }),
  cash: provenanceValueSchema(signedMinor),
  cashAsOf: z.string(),
  historicalRaised: count,
  burn: provenanceValueSchema(signedMinor),
  burnWindowMonths: count,
  burnHistoryMonths: count,
  inventoryValue: count,
  accountsPayable: count,
  salesTaxPayable: count,
  forecastRevenue: count,
  contributionPerOrder: signedMinor,
  samplesPlanned: count,
  closeSummary: z.object({ period: z.string(), label: z.string(), unmatchedPayouts: count, cpaSignOff: z.string() }),
  cashHistory: z.array(z.object({ month: z.string(), minor: signedMinor })),
  costBreakdown: z.array(z.object({ label: z.string(), minor: count })),
  payouts: z.array(z.object({ channel: z.string(), matched: count, needsReview: count })),
});

const periodStatus = z.enum(["open", "reconciling", "blocked", "awaitingCpa", "readyToExport", "exporting", "failed", "closed", "reopened"]);

export const periodCloseSchema = z.object({
  datasetKey,
  version: z.string(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  label: z.string(),
  checks: z.array(z.object({ check: z.string(), owner: z.string(), state: z.enum(["complete", "unmatched", "waiting", "blocked"]), label: z.string() })),
  closeOwner: z.string(),
  cpaReview: z.string(),
  status: periodStatus,
  exceptions: z.array(z.object({ payout: z.string(), expected: count, difference: signedMinor })),
  reports: z.array(z.object({ name: z.string(), state: z.string() })),
  exportFailed: z.boolean(),
});

const reportStatus = z.enum(["notGenerated", "queued", "exporting", "exported", "failed", "superseded"]);
const difference = z.object({
  payout: z.string(), expected: count, difference: signedMinor, owner: z.string().nullable(), reason: z.string().nullable(), correctionRef: z.string().nullable(), resolvedAt: z.string().nullable(), providerRef: z.string(), qboRef: z.string().nullable(),
});
const splitRow = z.object({
  id: z.string(), provider: z.string(), kind: z.enum(["commission", "historical"]), currency: z.string(), period: z.string(),
  accrual: provenanceValueSchema(signedMinor), reversals: provenanceValueSchema(signedMinor), processingFees: provenanceValueSchema(signedMinor), merchantBilled: provenanceValueSchema(signedMinor),
  merchantPaid: provenanceValueSchema(signedMinor), creatorPayout: provenanceValueSchema(signedMinor), outstanding: provenanceValueSchema(signedMinor),
  unresolved: z.array(z.object({ label: z.string(), amount: count })), note: z.string(),
});

/** The close package. A late adjustment carries a direction, and each version carries its own frozen ledger figures. */
export const closePackageSchema = z.object({
  datasetKey,
  version: z.string(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  label: z.string(),
  scenario: z.string(),
  status: periodStatus,
  blockers: z.array(z.object({ reason: z.string(), text: z.string() })),
  cpa: z.object({ state: z.enum(["notRequested", "requested", "signedOff"]), signedAt: z.string().nullable() }),
  exportState: z.enum(["none", "exporting", "failed", "exported"]),
  commissionCohort: z.object({ label: z.string(), orders: count, note: z.string() }),
  landedCost: z.object({ complete: z.boolean(), missingSkus: z.array(z.string()) }),
  differences: z.array(difference),
  versions: z.array(z.object({
    version: z.string(),
    figures: z.object({ accrual: count, reversals: count, netCommissionExpense: signedMinor, creatorPaid: count, outstandingLiability: count, pendingRecovery: count }),
    frozen: z.boolean(),
    closedAt: z.string().nullable(),
    cpaSignOff: z.string().nullable(),
    reports: z.array(z.object({ name: z.string(), expectedFiles: z.array(z.string()), status: reportStatus, version: z.string().nullable(), exportEvidence: z.string().nullable(), note: z.string().nullable() })),
  })).min(1),
  adjustment: z.object({
    id: z.string(), postedAt: z.string(), amount: nonNegativeMoney, direction: z.enum(["reversal", "addition"]), reason: z.string(), sourceEvidence: z.string(), linkedReceipt: z.string(),
    effect: z.literal("reopened"), priorVersion: z.string(), newVersion: z.string(), cpaSignOff: z.enum(["Requested", "Not requested"]),
  }).nullable(),
  paidReceipts: z.array(z.object({ receipt: z.string(), groupId: z.string(), amount: nonNegativeMoney, immutable: z.literal(true) })),
  commissionSplit: z.array(splitRow),
});

const cpaPolicy = z.object({ reference: z.string().nullable() });
export const monthsHistorySchema = z.object({
  datasetKey: z.literal("finance-months-demo"),
  months: z.array(z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/), label: z.string(), status: z.enum([...periodStatus.options, "revised"]), signedRevision: count.nullable(), signedAt: z.string().nullable(), reopenedAt: z.string().nullable(),
    revisions: z.array(z.object({ n: count, at: z.string(), reason: z.string(), supersedes: count.nullable() })), taxNote: z.string(),
  })),
});
export const reportManifestSchema = z.object({
  datasetKey: z.literal("finance-manifest-demo"),
  manifestId: z.string(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  label: z.string(),
  synthetic: z.literal(true),
  policy: cpaPolicy,
  rows: z.array(z.object({ report: z.string(), period: z.string(), basis: z.string(), source: z.string(), expectedFiles: z.array(z.string()), state: z.literal("Not generated"), generatedAt: z.null(), checksum: z.null(), policyRef: cpaPolicy })),
});

/** View key to the schema of `ReadResponse.data` for that view. */
export const financeViewSchemas: Record<string, z.ZodTypeAny> = {
  commissionLedger: commissionLedgerSchema,
  settlementDetail: settlementDetailSchema,
  payableDetail: payableDetailSchema,
  financeDashboard: financeDashboardSchema,
  periodClose: periodCloseSchema,
  closePackage: closePackageSchema,
  monthsHistory: monthsHistorySchema,
  reportManifest: reportManifestSchema,
};
