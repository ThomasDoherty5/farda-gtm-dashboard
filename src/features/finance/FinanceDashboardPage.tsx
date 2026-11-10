import { FinanceReadGrant, type FinanceReadQuery } from "./FinanceReadGrant";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney } from "@/components/MetricValue";
import { Divider, FactList, FlatTable, HalfColumns, Meter, Notice, Page, PageHeader, Panel } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { SourceDialog } from "@/features/approvals/shared";
import { figure } from "@/features/operations/format";
import { runwayOf, type FinanceDashboard } from "@/fixtures/finance";
import { financeMetricDictionary } from "@/fixtures/financeUnitEconomics";
import { usd } from "@/fixtures/values";
import { FinanceNav } from "./FinanceNav";
import styles from "./Finance.module.css";
import { ACQUISITION_COMPONENTS, COMPONENT_LABEL, CONTRIBUTION_COMPONENTS, REASON_TEXT, cacPaybackOf, componentTotal, inputProblems, type CostComponent, type UnitEconomicsInput, contributionOf, coverageText, definitionText, explain, figureText, grossMarginOf, recurringRevenueOf, recurringText, ueFormat } from "./unitEconomics";

const whole = (minor: number) => formatMoney(usd(minor));
const signed = (minor: number) => `${minor < 0 ? "−" : ""}${whole(Math.abs(minor))}`;
const compact = (minor: number) => `$${(minor / 100000).toFixed(1)}k`;

/**
 * Finance dashboard (Figma source 7:510, owner THO-303). Read-only management figures from QuickBooks. Net income, gross profit,
 * margin and runway are derived here from the source rows; year-to-date is unknown until its report arrives, never zero; and runway
 * is N/A with a reason when burn has too little history or isn't positive. The historical $70,000 raised is never used as current cash.
 * Unit economics (`./unitEconomics`) cover the original dashboard cohort only, under proposed definitions: CAC payback is in orders and
 * is N/A or provisional with its reason, and MRR/ARR need verified subscription access, a product and an adopted definition.
 */
export function FinanceDashboardPage() {
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ scenario?: string }, FinanceDashboard>("financeDashboard", scenario ? { scenario } : {});
  return <FinanceReadGrant query={query} title="Finance" titleId="finance-title"><FinanceDashboardContent query={query} /></FinanceReadGrant>;
}

function FinanceDashboardContent({ query }: { query: FinanceReadQuery<FinanceDashboard> & { isPending: boolean } }) {
  const [dialog, setDialog] = useState<null | "period" | "definitions" | { source: string }>(null);
  const res = query.data;
  const data = res?.data ?? null;
  return (
    <Page aria-labelledby="finance-title" data-figma-source="7:510">
      <PageHeader id="finance-title" title="Finance" subtitle="Know your cash, understand your margin, close with confidence.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 176 }} onClick={() => setDialog("period")}>Last 30 days</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 210 }} onClick={() => setDialog({ source: "Open QuickBooks" })}>Open QuickBooks</Button>
      </PageHeader>
      <FinanceNav current="overview" />
      <ReadState res={query.data} subject="The finance dashboard" only={["partial"]} />
      {query.isPending && <SkeletonCard label="Loading finance…" />}
      {query.isError && <ViewError error={query.error} subject="Finance" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title="No finance data yet"><p>QuickBooks responded, but no management report exists for this period.</p></EmptyState>}
      {res && data && <Body data={data} stale={res.dataState === "stale"} setDialog={setDialog} />}
      <Dialog open={dialog === "period"} title="The 30-day window" onClose={() => setDialog(null)}>
        <p>The figures cover the 30 days ending Oct 29, 2026. Calendar-month and year-to-date figures await their source reports, so there is no other period to choose in the demo.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog === "definitions"} title="Metric definitions" badge="Read only" onClose={() => setDialog(null)}>
        <p>Gross margin is gross profit over net revenue. Pre-marketing contribution per order excludes acquisition and fixed spend. Burn is the average net cash out over the last three months, using the proposed cash-flow definition. Runway is verified current cash divided by that burn, and reads N/A when there is too little history or no net spend.</p>
        {data && <UnitEconomicsDefinitions data={data} />}
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <SourceDialog open={Boolean(dialog && typeof dialog === "object")} title={dialog && typeof dialog === "object" ? dialog.source : ""} url={null} onClose={() => setDialog(null)} />
    </Page>
  );
}

function Body({ data, stale, setDialog }: { data: FinanceDashboard; stale: boolean; setDialog: (d: null | "period" | "definitions" | { source: string }) => void }) {
  const p = data.pnl;
  const gross = p.revenue - p.cogs;
  const net = gross - p.opex;
  const runway = runwayOf(data);
  const ue = data.unitEconomics;
  const margin = grossMarginOf(p, ue); // N/A over zero receipts, never NaN
  const { perOrder } = contributionOf(p, ue, data.contributionPerOrder);
  const { paybackOrders } = cacPaybackOf(p, ue, data.contributionPerOrder);
  const recurring = recurringRevenueOf(data.subscriptions);
  const rows: [string, number][] = [["Net revenue", p.revenue], ["Cost of goods sold", -p.cogs], ["Gross profit", gross], ["Operating expenses", -p.opex], ["Net income", net]];
  const actualVsForecast = data.forecastRevenue > 0 ? (100 * p.revenue) / data.forecastRevenue : null;
  const close = data.closeSummary;
  return (
    <>
      <Notice tone={stale ? "warning" : "violet"} label={stale ? "Behind" : "Source"} title="QuickBooks is the official ledger · Management P&L" role={stale ? "status" : undefined} testId="source-freshness">
        {`${data.period.label} · Illustrative management figures. Calendar-month and YTD figures await source reports.${stale ? " The mirror is behind its source." : ""}`}
      </Notice>
      <KpiRow>
        <Kpi label="Cash balance" context={`${whole(data.historicalRaised)} raised · as of ${data.cashAsOf}`} testId="metric-Cash balance">{figure(data.cash, (m) => whole(m))}</Kpi>
        <Kpi label="Monthly burn" context={data.burn.state === "known" ? "Average net cash out · last 3 months" : `Needs ${data.burnWindowMonths} months of history`} testId="metric-Monthly burn">{figure(data.burn, (m) => whole(m))}</Kpi>
        <Kpi label="Runway" context={runway.reason ?? "Current cash / average burn"} testId="metric-Runway">{runway.months === null ? "N/A" : `${runway.months.toFixed(1)} months`}</Kpi>
        <Kpi label="Pre-marketing contribution" context={perOrder.state === "notApplicable" ? explain(perOrder) : `Per order · ${perOrder.state === "provisional" ? `Provisional · ${explain(perOrder)}` : "proposed definition"}`} testId="metric-Pre-marketing contribution">{perOrder.value === null ? "N/A" : ueFormat.money(perOrder.value)}</Kpi>
      </KpiRow>
      <HalfColumns>
        <Panel title="Profit & loss" subtitle={`${data.period.label} · 30-day management P&L`} testId="pnl">
          <FlatTable
            caption="Profit and loss"
            testId="pnl-table"
            columns={[{ label: "Account", width: 326 }, { label: "30 days", width: 131 }, { label: "YTD", width: 131 }]}
            rows={rows.map(([account, minor]) => ({ key: account, cells: [account, signed(minor), figure(p.ytd, whole).replace("N/A", "Awaiting data")] }))}
          />
        </Panel>
        <Panel title="Cash & obligations" subtitle="Do not confuse cash with revenue" testId="cash">
          <dl className={styles.ledgerRows} aria-label="Cash and obligations">
            <div><dt>Cash</dt><dd>{figure(data.cash, whole)}</dd></div>
            <div><dt>Inventory · demo lot valuation</dt><dd>{whole(data.inventoryValue)}</dd></div>
            <div><dt>Accounts payable</dt><dd>{whole(data.accountsPayable)}</dd></div>
            <div><dt>Sales tax payable</dt><dd>{whole(data.salesTaxPayable)}</dd></div>
          </dl>
          <Divider />
          <p className={styles.sub}>Forecast vs. actual</p>
          <p className={styles.warnText}>Forecast is illustrative until rebaselined.</p>
          <FactList wide label="Forecast vs actual" rows={[["Revenue actual / forecast", `${compact(p.revenue)} / ${compact(data.forecastRevenue)}`]]} />
          {actualVsForecast === null ? <p className={styles.warnText}>No forecast to compare with.</p> : <Meter percent={actualVsForecast} label={`Revenue actual is ${actualVsForecast.toFixed(0)}% of the illustrative forecast`} />}
        </Panel>
      </HalfColumns>
      <HalfColumns>
        <Panel title="Unit economics" subtitle="Pre-marketing contribution excludes acquisition and fixed spend." testId="unit-economics">
          <FactList wide label="Unit economics" rows={[["Gross margin", figureText(margin, ueFormat.percent)], ["Pre-marketing contribution / order", figureText(perOrder, ueFormat.money)], ["CAC payback", figureText(paybackOrders, ueFormat.orders)], ["Creator costs · attribution", ue ? `${coverageText(ue.creatorCosts, "creators")} · ${coverageText(ue.attribution, "orders")}` : "Not reported"], ["First-wave sample plan", `${data.samplesPlanned} units · planned allocation`]]} />
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 240, alignSelf: "flex-start" }} onClick={() => setDialog("definitions")}>View metric definitions</Button>
        </Panel>
        <Panel title="Month-end & compliance" subtitle="Review unresolved items before closing" testId="close-summary">
          <span><Badge tone="warning" width={210}>{close.label} · In progress</Badge></span>
          <FactList wide label="Close summary" rows={[["Payouts to reconcile", close.unmatchedPayouts], ["CPA sign-off", close.cpaSignOff]]} />
          <LinkButton to={`/finance/close/${close.period}`} style={{ minWidth: 236, alignSelf: "flex-start" }}>Open month-end close</LinkButton>
          <Divider />
          <h3 className={styles.h3} data-testid="subscription-state" data-state={recurring.kind}>{SUBSCRIPTION_HEADING[recurring.kind](recurringText(recurring))}</h3>
          <p className={styles.footnote}>{recurring.kind === "none" ? "MRR and ARR appear only when subscription orders exist." : recurring.reason}</p>
        </Panel>
      </HalfColumns>
      <Panel large roomy title="Accrual, cash and provider ownership." subtitle="The original dashboard cohort is unchanged. The separate affiliate pilot has its own commission ledger and cost basis." testId="compensation">
        <p className={styles.footnote}>Recognize gross commission less reversals as expense. Provider cash settlement does not create a second expense or manual payment. Reconcile native billing, fees, payee and QBO references.</p>
        <div className={styles.actionsRow} style={{ gap: 16 }}>
          <LinkButton to="/finance/commissions" style={{ minWidth: 218 }}>Commission ledger</LinkButton>
          <LinkButton variant="secondary" to="/finance/settlements/COMM-DEMO-D" style={{ minWidth: 238 }}>Payout reconciliation</LinkButton>
          <LinkButton variant="ghost" to="/finance/payables/PAY-0012" style={{ minWidth: 210 }}>Direct content fee</LinkButton>
        </div>
      </Panel>
    </>
  );
}

const SUBSCRIPTION_HEADING: Record<ReturnType<typeof recurringRevenueOf>["kind"], (t: { mrr: string; arr: string }) => string> = {
  none: () => "No subscription revenue",
  unavailable: () => "Subscription revenue unknown",
  unknown: () => "Subscription revenue unknown",
  notDefined: () => "MRR and ARR not defined",
  known: (t) => `MRR ${t.mrr} · ARR ${t.arr}`,
};

/** The proposed dictionary, this cohort's cost components and the forecast's own version, for the definitions dialog. */
function UnitEconomicsDefinitions({ data }: { data: FinanceDashboard }) {
  const ue = data.unitEconomics;
  const plan = data.forecastPlan;
  // Per-component rows use the same whole-input checks as the group totals, so they always sum to them or are refused together.
  const component = (u: UnitEconomicsInput, c: CostComponent) => {
    const declared = u.costs.some((r) => r.component === c) ? null : u.declared.find((d) => d.component === c);
    if (declared?.state === "notApplicable" && inputProblems(u).length === 0) return `N/A · ${declared.reasonCode === "PILOT_COHORT_ONLY" ? "pilot cohort only; see the commission ledger" : declared.reasonCode}`;
    return figureText(componentTotal(u, [c]), ueFormat.money);
  };
  const group = (u: UnitEconomicsInput, name: string, members: readonly CostComponent[]): [string, string][] =>
    [...members.map((c): [string, string] => [`${COMPONENT_LABEL[c]} · ${name}`, component(u, c)]), [`Total ${name} costs`, figureText(componentTotal(u, members), ueFormat.money)]];
  return (
    <>
      <p className={styles.warnText}>{`${ue ? definitionText(ue.definition) : "Not configured"}. ${financeMetricDictionary.policy}`}</p>
      <FactList label="Unit-economics definitions" rows={financeMetricDictionary.entries.map((e) => [e.label, `${e.numerator}${e.denominator === "None" ? "" : ` ÷ ${e.denominator}`}. ${e.costBuckets === "None" || e.costBuckets.startsWith("As ") ? "" : `${e.costBuckets} `}${e.whenUnavailable}`])} />
      {ue
        ? <FactList label="Cohort cost components" rows={[["Cohort", `${ue.cohort.label} · the affiliate pilot is excluded and keeps its own ledger`], ...group(ue, "contribution", CONTRIBUTION_COMPONENTS), ...group(ue, "acquisition", ACQUISITION_COMPONENTS)]} />
        : <p>{`N/A · ${REASON_TEXT.UNIT_ECONOMICS_NOT_REPORTED}. No cost component is inferred.`}</p>}
      <FactList label="Actuals and forecast" rows={[["Actuals", `Source version ${data.version} · management P&L`], ...(plan ? [["Forecast", `${plan.version} · ${plan.basis}`], ["Forecast assumptions", plan.assumptions.length ? plan.assumptions.join(" · ") : "None stated"]] as [string, string][] : [["Forecast", "No forecast plan reported"]] as [string, string][])]} />
    </>
  );
}
