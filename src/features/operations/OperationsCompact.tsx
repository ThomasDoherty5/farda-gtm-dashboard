import { useSearchParams } from "react-router-dom";
import { operationsContext, operationsEvidenceLabel, operationsHref, queueDetailPath, stockAvailable, stockLow, type NativeQueueRow, type OperationsOverviewRead } from "./nativeRead";
import { Link } from "react-router-dom";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Kpi, KpiRow } from "@/components/Kpi";
import { FactList, FlatTable, HalfColumns, Panel } from "@/components/Panels";
import { homeLabel, type Home } from "@/fixtures/operations";
import { figure, minutesAgoLabel, waitingLabel } from "./format";
import styles from "./Operations.module.css";

export type CompactProps = {
  data: OperationsOverviewRead;
  demo: boolean;
  view: "overview" | "orders" | "shipping";
  overviewTo: string;
  ordersTo: string;
  home: Home | "all";
  ready: NativeQueueRow[];
  held: NativeQueueRow[];
  /** Whole minutes since the source last synced, or null when it never did. */
  syncedMinutesAgo: number | null;
  stale: boolean;
  complete: boolean;
};

const WORDS = ["No", "One", "Two", "Three", "Four", "Five"];
/** "One lost, one returned." from the exception states. */
const exceptionSummary = (states: string[]) => {
  const counts = [...new Set(states)].map((state) => `${(WORDS[states.filter((s) => s === state).length] ?? String(states.length)).toLowerCase()} ${state.toLowerCase()}`);
  const text = counts.join(", ") || "none";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};
const scopeText = (home: Home | "all") => (home === "all" ? "All homes" : home);
const syncText = (minutes: number | null) => (minutes === null ? "No successful sync recorded" : `Synced ${minutesAgoLabel(minutes)}`);

/** Operations at 1024 (Figma 12:708). A shorter composition than 1440: three figures, three queue rows, stock and exceptions. */
export function TabletOperations({ data, demo, home, ready, held, syncedMinutesAgo, stale, complete }: CompactProps) {
  const [urlSearch] = useSearchParams();
  const search = operationsContext(urlSearch, data);
  const summary = home === "all" ? data.all : data.byHome[home];
  const stock = data.stock.filter((s) => home === "all" || s.home === home);
  const exceptions = data.exceptions.filter((e) => home === "all" || e.home === home);
  return (
    <>
      <p className={styles.scope} data-operations-demo={demo || undefined} data-testid="source-freshness" role={stale ? "status" : undefined}>
        {scopeText(home)} · {demo ? "Demo workspace" : operationsEvidenceLabel(data)} · {stale ? "Behind its source · " : ""}{syncText(syncedMinutesAgo)}
      </p>
      <KpiRow columns={3} keepColumns>
        <Kpi label="To ship" context={`${figure(summary.waitingOverTwoDays, String)} overdue`} testId="metric-To ship">{figure(summary.toShip, String)}</Kpi>
        <Kpi label="Shipped today" context={home === "all" ? "3 homes" : homeLabel(home)} testId="metric-Shipped today">{figure(summary.shippedToday, String)}</Kpi>
        <Kpi label="Open issues" context={home === "all" ? `${data.needHumanResponse} human handoffs` : "Not assigned to a home"} testId="metric-Open issues">{home === "all" ? figure(data.openIssues, String) : "N/A"}</Kpi>
      </KpiRow>
      <Panel title="Ready to leave home" subtitle="Orders and approved samples · oldest first" testId="queue-panel">
        {ready.length ? (
          <FlatTable
            caption="Ready to leave home"
            columns={[{ label: "Order / sample", width: 354 }, { label: "Home", width: 170 }, { label: "Waiting", width: 180 }, { label: "Action", width: 158 }]}
            rows={ready.slice(0, 3).map((r) => ({
              key: r.ref,
              cells: [<span key="r" className={styles.queueRef}>{r.ref}</span>, r.home, waitingLabel(r.waitingHours), queueDetailPath(r, !demo) ? <LinkButton key="a" to={operationsHref(queueDetailPath(r, !demo)!, search)} variant={r.waitingHours > data.warnAfterHours ? "secondary" : "ghost"} aria-label={`View ${r.ref}`} style={{ minWidth: 112 }}>View</LinkButton> : <Button key="a" variant="ghost" disabledReason="An exact source detail reference was not supplied.">View</Button>],
            }))}
            testId="queue-table"
          />
        ) : (
          <p className={styles.panelText}>{complete ? "No eligible dispatch rows were returned for this home." : "Dispatch evidence is incomplete. It is unknown whether more orders or samples are waiting."}</p>
        )}
      </Panel>
      <CompactHolds held={held} demo={demo} search={search} />
      <HalfColumns keepColumns>
        <Panel title="Stock by home" testId="stock-panel">
          <FactList label="Stock by home" labelWidth={166} rows={stock.map((s) => { const available = stockAvailable(s); return [s.home, available === null ? "Unknown availability" : stockLow(s) ? `${available} · low stock` : `${available} available`] as [string, string]; })} />
        </Panel>
        <Panel title={`${exceptions.length} shipping exception${exceptions.length === 1 ? "" : "s"}`} testId="exceptions-panel">
          <p className={styles.panelText}>{exceptionSummary(exceptions.map((e) => e.state))} Resolve source cases before issuing replacements.</p>
          {exceptions[0] && <LinkButton to={operationsHref(`/shipments/${encodeURIComponent(exceptions[0].shipmentRef)}/exceptions/${encodeURIComponent(exceptions[0].exceptionId)}`, search)} style={{ minWidth: 206, alignSelf: "flex-start" }}>Review exceptions</LinkButton>}
        </Panel>
      </HalfColumns>
    </>
  );
}

/** Operations at 390 (Figma 12:653): one column, queue as cards, low stock as a warning card. */
export function MobileOperations({ data, demo, home, view, overviewTo, ordersTo, ready, held, syncedMinutesAgo, stale, complete }: CompactProps) {
  const [urlSearch] = useSearchParams();
  const search = operationsContext(urlSearch, data);
  const summary = home === "all" ? data.all : data.byHome[home];
  const stock = data.stock.filter((s) => home === "all" || s.home === home);
  const available = stock.length && stock.every(s => stockAvailable(s) !== null) ? stock.reduce((sum, s) => sum + stockAvailable(s)!, 0) : null;
  const low = stock.filter(stockLow);
  const exceptions = data.exceptions.filter((e) => home === "all" || e.home === home);
  const tab = (label: string, to: string, current = false) => <LinkButton key={label} to={to} variant={current ? "primary" : "ghost"} aria-current={current ? "page" : undefined}>{label}</LinkButton>;
  return (
    <>
      <p className={styles.scope} data-operations-demo={demo || undefined}>{demo ? "Demo workspace" : operationsEvidenceLabel(data)} · {scopeText(home)}</p>
      <nav aria-label="Operations sections" className={styles.compactTabs}>
        {tab("Overview", overviewTo, view === "overview")}
        {tab("To ship", ordersTo, view === "orders")}
        {tab("Stock", operationsHref("/inventory", search))}
      </nav>
      <div className={styles.strip} data-stale={stale} data-testid="source-freshness" role={stale ? "status" : undefined}>
        <p>{data.source.label.split(" ")[0]} · {stale ? "behind its source, " : ""}{syncedMinutesAgo === null ? "no successful sync" : `synced ${minutesAgoLabel(syncedMinutesAgo).replace(" minutes", " min").replace(" minute", " min")}`}</p>
        <p>Read-only mirror · edit at source</p>
      </div>
      <dl className={styles.miniKpis}>
        <div className={styles.miniKpi}><dt>To ship</dt><dd data-testid="metric-To ship">{figure(summary.toShip, String)}</dd></div>
        <div className={styles.miniKpi}><dt>Available</dt><dd data-testid="metric-Available">{available ?? "Unknown"}</dd></div>
      </dl>
      <h2 className={styles.h3}>Ship next</h2>
      {!ready.length && <p className={styles.panelText}>{complete ? "No eligible dispatch rows were returned for this home." : "Dispatch evidence is incomplete. It is unknown whether more orders or samples are waiting."}</p>}
      <ul className={styles.cards} aria-label="Ship next">
        {ready.map((r) => {
          const over = r.waitingHours > data.warnAfterHours;
          return (
            <li key={r.ref} className={styles.card}>
              <p style={{ font: "var(--text-label)" }}>{r.ref}</p>
              <p className={styles.kind}>{r.kind === "sample" ? "Creator sample" : "Order"} · {r.units} unit{r.units === 1 ? "" : "s"}</p>
              <Badge tone={over ? "danger" : "neutral"} width={180}>{waitingLabel(r.waitingHours)} waiting</Badge>
              {queueDetailPath(r, !demo) ? <LinkButton to={operationsHref(queueDetailPath(r, !demo)!, search)} variant="secondary">View source record</LinkButton> : <Button variant="secondary" disabledReason="An exact source detail reference was not supplied.">View source record</Button>}
            </li>
          );
        })}
      </ul>
      <CompactHolds held={held} demo={demo} search={search} />
      {low.map((s) => (
        <div key={s.home} className={styles.warnCard} data-testid="low-stock">
          <p className={styles.h3}>{s.home} is low on stock</p>
          <div className={styles.lines}>
            <p>{stockAvailable(s) ?? "Unknown"} available · threshold {s.threshold}</p>
            {data.transfers.filter((t) => t.toHome === s.home).map((t) => <p key={t.ref}>Transfer {t.ref} is {t.state}.</p>)}
          </div>
          <LinkButton to={operationsHref("/inventory", new URLSearchParams({ ...Object.fromEntries(search), home: s.home }))} variant="secondary" style={{ minWidth: 180 }}>View transfer</LinkButton>
        </div>
      ))}
      <p className={styles.micro}>
        Last refreshed {syncedMinutesAgo === null ? "never" : minutesAgoLabel(syncedMinutesAgo)} · {exceptions[0] ?
          <Link to={operationsHref(`/shipments/${encodeURIComponent(exceptions[0].shipmentRef)}/exceptions/${encodeURIComponent(exceptions[0].exceptionId)}`, search)}>{exceptions.length} shipping exception{exceptions.length === 1 ? "" : "s"}</Link> : "Operational data only."}
      </p>
    </>
  );
}

function CompactHolds({ held, demo, search }: { held: NativeQueueRow[]; demo: boolean; search: URLSearchParams }) {
  if (!held.length) return null;
  return <Panel title={`${held.length} held, not ready to leave home`}><ul className={styles.stockList}>{held.map(row => <li key={row.ref}><strong>{row.ref}</strong><p>{row.hold?.reason ?? "Dispatch eligibility is unknown"}. {row.hold?.sourceAction ?? "Refresh source eligibility evidence"}.</p>{queueDetailPath(row, !demo) && <LinkButton variant="secondary" to={operationsHref(queueDetailPath(row, !demo)!, search)}>Inspect held record</LinkButton>}</li>)}</ul></Panel>;
}
