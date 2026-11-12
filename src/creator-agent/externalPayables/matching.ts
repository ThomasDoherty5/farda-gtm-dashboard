import type { Statement, SettlementReceipt } from "./contract.ts";

export type LineDisposition =
  | { lineRef: string; disposition: "matched"; receiptRef: string }
  | { lineRef: string; disposition: "alreadyMatched" | "notExternalPayable" | "amountMismatch" | "currencyMismatch" | "duplicateLine"; receiptRef: string | null };

/**
 * J12-09 statement matching, pure. A line matches a settled receipt only by its exact receipt reference, same currency and same amount
 * as an outflow. A receipt matches at most once. Lines that name no external receipt (for example native-provider payouts) are left alone.
 * Matching moves no money and never asks the provider for anything.
 */
export function matchStatementLines(statement: Statement, receipts: ReadonlyMap<string, SettlementReceipt>, matched: ReadonlySet<string>, seenLines: ReadonlySet<string>): LineDisposition[] {
  const taken = new Set(matched), lines = new Set<string>();
  return statement.lines.map(line => {
    if (seenLines.has(line.lineRef) || lines.has(line.lineRef)) return { lineRef: line.lineRef, disposition: "duplicateLine", receiptRef: null };
    lines.add(line.lineRef);
    const receipt = line.reference ? receipts.get(line.reference) : undefined;
    if (!receipt || line.direction !== "outflow") return { lineRef: line.lineRef, disposition: "notExternalPayable", receiptRef: null };
    if (taken.has(receipt.receiptRef)) return { lineRef: line.lineRef, disposition: "alreadyMatched", receiptRef: receipt.receiptRef };
    if (receipt.amount.currency !== line.amount.currency) return { lineRef: line.lineRef, disposition: "currencyMismatch", receiptRef: receipt.receiptRef };
    if (receipt.amount.minorUnits !== line.amount.minorUnits) return { lineRef: line.lineRef, disposition: "amountMismatch", receiptRef: receipt.receiptRef };
    taken.add(receipt.receiptRef);
    return { lineRef: line.lineRef, disposition: "matched", receiptRef: receipt.receiptRef };
  });
}
