import { settlementSourceFixture } from "../../src/creator-agent/settlements/fixtures.testkit.ts";
import type { SettlementRecord, SettlementScope } from "../../src/creator-agent/settlements/contract.ts";

/** Fictional layout cohort only. Values are explicit source facts, never runtime defaults or provider evidence. */
export function originalLayoutFinanceSource(scope: SettlementScope, now: number) {
  const fixture = settlementSourceFixture(scope, now), money = fixture.money;
  const base = fixture.records[0]!, tiktok = fixture.records[1]!, payable = fixture.records[2]!;
  const rows: { ref: string; state: SettlementRecord["state"]; gross: number; eligible: number; earned: number; reversed: number; net: number; paid: number }[] = [
    { ref: "layout-commission-a", state: "held", gross: 80000, eligible: 60000, earned: 12000, reversed: 3000, net: 9000, paid: 0 },
    { ref: "layout-commission-b", state: "disputed", gross: 20000, eligible: 20000, earned: 3000, reversed: 0, net: 3000, paid: 0 },
    { ref: "layout-commission-c", state: "awaitingProvider", gross: 40000, eligible: 40000, earned: 6000, reversed: 0, net: 6000, paid: 0 },
    { ref: "layout-commission-d", state: "creatorPaid", gross: 60000, eligible: 60000, earned: 9000, reversed: 0, net: 9000, paid: 9000 },
  ];
  const commissions = rows.map(row => {
    const record = structuredClone(base);
    record.ref = row.ref; record.componentRef = `${row.ref}-component`; record.orderRef = `${row.ref}-order`; record.state = row.state;
    record.grossSales = money(row.gross); record.eligibleBase = money(row.eligible); record.grossEarned = money(row.earned); record.reversed = money(row.reversed); record.netAccrued = money(row.net);
    record.balances.earned = money(row.earned); record.balances.creatorPaid = money(row.paid); record.balances.outstanding = money(row.net - row.paid);
    record.balances.held = money(row.state === "held" ? row.net : 0); record.balances.disputed = money(row.state === "disputed" ? row.net : 0);
    record.fee = row.paid ? money(261) : fixture.unknown;
    if (row.paid) {
      record.balances.billed = money(9261);
      record.accounting = { state: "unposted", qboRef: null, policyRef: "layout-fictional-accounting-policy", policyVersion: "layout-policy-v1", evidenceRef: "layout-unposted-evidence" };
    }
    record.facts = [{ ref: `${row.ref}-event`, state: row.state, amount: { minorUnits: row.net, currency: "USD" }, eventAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), evidenceRef: `${row.ref}-evidence`, nativeRef: null }];
    record.receipts = row.paid ? [{ ...base.receipts[0]!, ref: `${row.ref}-receipt`, componentRef: record.componentRef }] : [];
    record.candidates = row.paid ? base.candidates.map(candidate => ({ ...candidate, componentRef: record.componentRef })) : [];
    record.crosswalk.orderRef = record.orderRef;
    return record;
  });
  payable.accounting = { state: "unposted", qboRef: null, policyRef: "layout-fictional-accounting-policy", policyVersion: "layout-policy-v1", evidenceRef: "layout-payable-accounting-evidence" };
  payable.facts.unshift({ ref: "layout-payable-request", state: "requested", amount: { minorUnits: 15000, currency: "USD" }, eventAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), evidenceRef: "layout-request-evidence", nativeRef: null });
  payable.collaborationRef = "layout-historical-collaboration";
  payable.budgetCategory = { state: "known", value: "Creator / UGC", evidenceRef: "layout-budget-evidence", observedAt: new Date(now).toISOString(), reasonCode: null };
  fixture.records.splice(0, fixture.records.length, ...commissions, tiktok, payable);
  fixture.source.read = async request => {
    const snapshot = fixture.snapshot(request);
    // Only the explicitly selected Collabs layout cohort carries these aggregate economics.
    if (request.viewKey === "commissionLedger" && request.provider === "collabs") {
      snapshot.stateTotals = { held: money(9000), disputed: money(3000), awaitingProvider: money(6000), paid: money(9000) };
      snapshot.totals = { eligible: money(180000), accrued: money(27000), creatorPaid: money(9000), contribution: money(46217) };
      snapshot.accountingPolicy = { state: "verified", reference: "layout-fictional-accounting-policy" };
      snapshot.economics = { cohortRef: "layout-four-commission-groups", periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z", eligibleOrders: fixture.number(45), grossSales: money(200000), refunds: money(20000), netRevenue: money(180000), creatorCommissions: money(27000), providerFees: money(783), fulfillmentCost: money(81000), sampleCost: money(10000), contribution: money(46217),
        waterfall: { netSales: money(180000), commerceCosts: money(81000), fixedFees: money(15000), samples: money(10000), netCommission: money(27000), feeEstimate: money(783), contribution: money(46217) } };
    }
    return snapshot;
  };
  return fixture;
}
