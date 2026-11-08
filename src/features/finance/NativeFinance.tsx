import { createContext, useContext, type ReactNode } from "react";
const SyntheticSource = createContext(true);
import type { ReadResponse } from "@/adapter/contract";
import type { NativeCommissionLedger, NativePayable, NativeSettlement, SettlementRecord } from "@/creator-agent/settlements/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { FactList, PageHeader } from "@/components/Panels";
import { SectionTabs } from "@/components/SectionTabs";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import styles from "./NativeFinance.module.css";

export type NativeFinanceData = NativeCommissionLedger | NativePayable | NativeSettlement;
export type MoneyFact = SettlementRecord["eligibleBase"];
export const stateText: Record<SettlementRecord["state"], string> = { estimated: "Estimated", earned: "Earned", held: "Held", disputed: "Disputed", approved: "Approved", billed: "Billed", awaitingCreator: "Waiting for creator activation", merchantPaid: "Merchant paid", creatorPaid: "Creator paid", failed: "Failed", adjusted: "Adjusted", reconciled: "Reconciled", requested: "Requested", executed: "Executed", reversed: "Reversed", unknown: "Unknown" };
export const reasonText = (reason: string) => reason.toLowerCase().replaceAll("_", " ");
export function exactMoney(value: { minorUnits: number; currency: string }) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency, currencyDisplay: "code" }).format(value.minorUnits / 100);
}
export function moneyFact(fact: MoneyFact): string {
  return fact.state === "known" ? exactMoney(fact.value) : `${fact.state === "notApplicable" ? "N/A" : "Unknown"} · ${reasonText(fact.reasonCode)}`;
}
export const observed = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown";
export const recordPath = (record: SettlementRecord) => record.provider === "externalManual" ? `/finance/payables/${encodeURIComponent(record.ref)}` : `/finance/settlements/${encodeURIComponent(record.ref)}`;

/** A source display grant is distinct from a financial fact or permission to mutate. */
export function FinanceGrant({ data, response, refresh, titleId, title, children }: { data: NativeFinanceData; response: ReadResponse<NativeFinanceData>; refresh: () => void; titleId: string; title: string; children: ReactNode }) {
  const leased = useSourceLease(data.source.validUntil);
  const canDisplay = leased && !["unconfigured", "unavailable"].includes(data.source.state);
  if (!canDisplay) return <><PageHeader id={titleId} title={title} /><div role="alert"><p>Current source access is unavailable or expired. Refresh to verify access before viewing protected financial evidence.</p><Button variant="secondary" onClick={refresh}>Refresh source evidence</Button></div></>;
  return <SyntheticSource.Provider value={data.source.synthetic}><div className={styles.content}>
    {children}
    <div className={styles.source} role="status"><Badge tone={data.source.synthetic ? "violet" : "neutral"}>{data.source.synthetic ? "Synthetic source evidence" : "Source evidence"}</Badge><span>Observed {observed(data.source.observedAt)} · {data.source.state}. {response.dataState === "partial" ? "Some source data is missing. " : ""}No payment is authorized by this view.</span><Button variant="ghost" onClick={refresh}>Refresh source evidence</Button></div>
  </div></SyntheticSource.Provider>;
}

export function NativeFinanceTabs({ current, payout }: { current: "commissions" | "payouts"; payout?: SettlementRecord }) {
  return <SectionTabs label="Commission sections" tabs={[
    { label: "Commissions", to: "/finance/commissions", current: current === "commissions", width: 109 },
    { label: "Payouts", to: payout ? recordPath(payout) : "/finance/commissions#native-ledger-records", current: current === "payouts", width: 100 },
    { label: "Economics", to: "/finance/commissions#contribution", width: 100 },
    { label: "Provider access", to: "/settings/capabilities", width: 137 },
  ]} />;
}

/** The service validates destinations; the browser additionally withdraws an expired link. */
export function FinanceSourceLink({ record, kind, label, current = true, targetRef }: { record: SettlementRecord; kind: SettlementRecord["links"][number]["kind"]; label: string; current?: boolean; targetRef?: string }) {
  const synthetic = useContext(SyntheticSource);
  const matches = record.links.filter(link => link.kind === kind && (targetRef === undefined || link.targetRef === targetRef));
  const link = matches.length === 1 ? matches[0] : undefined;
  const leased = useSourceLease(link?.validUntil);
  const safe = !synthetic && current && leased && link?.state === "verified" && link.url && /^https:\/\//i.test(link.url);
  return safe ? <a className={styles.external} href={link.url!} target="_blank" rel="noopener noreferrer">{label}<span className="visually-hidden"> (external source, opens in a new tab)</span></a>
    : <Button variant="secondary" disabledReason={matches.length > 1 ? "More than one source destination was returned. Ask the source owner to identify the exact record." : "A current verified source link is unavailable. Refresh source evidence or contact the source owner."}>{label}</Button>;
}

export function FinancialEvidenceDialog({ record, onClose }: { record: SettlementRecord | null; onClose: () => void }) {
  return <Dialog open={!!record} title="Financial source evidence" onClose={onClose}>
    {record && <div className={styles.content}>
      <FactList label="Source identity" rows={[["Record", record.ref], ["Provider", record.provider], ["Account", record.accountRef], ["Creator", record.creatorRef], ["Component", record.componentRef], ["Native reference", record.nativeRef ?? "Unknown · not supplied"], ["Current state", stateText[record.state]], ["Version", record.version]]} />
      <h3>Independent source facts</h3>
      {record.facts.length ? <ul className={styles.evidence}>{record.facts.map(fact => <li key={fact.ref}>{stateText[fact.state]} · {fact.amount ? exactMoney(fact.amount) : "Amount unknown"} · event {observed(fact.eventAt)} · observed {observed(fact.observedAt)} · evidence {fact.evidenceRef}</li>)}</ul> : <p>No financial event evidence was returned.</p>}
      <h3>Immutable paid receipts</h3>
      {record.receipts.length ? <ul className={styles.evidence}>{record.receipts.map(receipt => <li key={receipt.ref}>{receipt.ref} · {exactMoney(receipt.amount)} · settled {observed(receipt.settledAt)} · observed {observed(receipt.observedAt)} · {receipt.evidenceRef}</li>)}</ul> : <p>No paid receipt was returned. This does not prove payment or nonpayment.</p>}
      <h3>Append-only adjustments</h3>
      {record.adjustments.length ? <ul className={styles.evidence}>{record.adjustments.map(adjustment => <li key={adjustment.ref}>{adjustment.ref} · {adjustment.reason} · {exactMoney(adjustment.amount)} · original receipt {adjustment.receiptRef} · effective {observed(adjustment.effectiveAt)} · {adjustment.evidenceRef}</li>)}</ul> : <p>No adjustment evidence was returned.</p>}
      <p>Viewing this evidence does not confirm a match, change an original receipt or create a payment.</p>
      <FinanceSourceLink record={record} kind="evidence" label="Open source evidence" />
    </div>}
    <Button variant="secondary" onClick={onClose}>Close evidence</Button>
  </Dialog>;
}

export function RecordNavigation({ record, children }: { record: SettlementRecord; children: ReactNode }) { return <LinkButton variant="secondary" to={recordPath(record)}>{children}</LinkButton>; }
