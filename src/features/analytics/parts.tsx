import { useId, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Money, ProvenanceValue, ReadResponse } from "@/adapter/contract";
import { staleReasonText } from "@/adapter/freshness";
import { useScope } from "@/adapter/scope";
import { Alert } from "@/components/Alert";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { formatMoney, formatMoneyExact } from "@/components/MetricValue";
import { ViewError } from "@/components/ViewError";
import type { Provenance } from "@/fixtures/analytics";
import { z } from "zod";
import { sourceStatusSchema, type SourceStatus } from "@/adapter/viewSchemas/analytics";
import styles from "./Analytics.module.css";

export const usd = (m: Money) => formatMoney(m);
export const usdExact = (m: Money) => formatMoneyExact(m);
export const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
/** A share as text. Over a whole that is not above zero there is no share, so it is "N/A", never NaN or Infinity (and never 0%). */
export const percent = (part: number, whole: number, digits = 1) => (whole > 0 ? `${new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format((100 * part) / whole)}%` : "N/A");
/** Exact ratio of two whole numbers, as a share of a scale in [0, 1]. */
export const ratio = (value: number, scale: number) => (scale > 0 ? Math.min(1, Math.max(0, value / scale)) : 0);
export const dateTime = (iso: string, timeZone = "America/Los_Angeles") =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(iso));

const REASONS: Record<string, string> = {
  LAUNCH_DATE_UNSET: "The launch date is not set.",
  SOURCE_ROWS_MISSING: "The source returned no rows for this metric.",
  PLATFORM_SPEND_MISSING: "Platform spend is missing, so ROAS can't be calculated.",
  LANDED_COST_INCOMPLETE: "Landed cost is incomplete, so contribution can't be stated.",
  SESSIONS_SOURCE_UNSELECTED: "No sessions source is selected, so conversion can't be calculated.",
  NO_DELIVERED_COHORT: "No delivered cohort, so support and return rates can't be calculated.",
  RATINGS_FEED_UNAVAILABLE: "The ratings feed is unavailable, so the average rating can't be calculated.",
};

/** A provenance value as text. Known zero stays "0"; unknown and not applicable read "N/A" with the reason. */
export function MetricText<T>({ value, format }: { value: ProvenanceValue<T>; format: (v: T) => string }) {
  if (value.state === "known" && value.value !== null) return <span data-state="known">{format(value.value)}</span>;
  return (
    <span data-state={value.state}>
      N/A <span style={{ display: "block", font: "var(--text-small)", color: "var(--color-muted)" }}>{(value.reasonCode && REASONS[value.reasonCode]) ?? "Not available from the source."}</span>
    </span>
  );
}

export function PageHeader({ id, title, subtitle, children }: { id: string; title: string; subtitle: string; children?: ReactNode }) {
  return (
    <div className={styles.titleRow}>
      <div className={styles.heading}>
        <h1 id={id}>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

export function Notice({ tone, title, children }: { tone: "warning" | "violet"; title: string; children: ReactNode }) {
  return (
    <div className={`${styles.notice} ${tone === "warning" ? styles.noticeWarning : styles.noticeViolet}`}>
      <p className={styles.label}>{title}</p>
      <p className={styles.small}>{children}</p>
    </div>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className={styles.kpis}>{children}</div>;
}

/** KPI card (Figma set 6:516). The context line names the denominator or window. */
export function KpiCard({ label, children, context, warn = false, testId }: { label: string; children: ReactNode; context: ReactNode; warn?: boolean; testId?: string }) {
  return (
    <dl className={styles.kpi}>
      <dt>{label}</dt>
      <dd className={styles.kpiValue} data-testid={testId}>{children}</dd>
      <dd className={`${styles.kpiContext} ${warn ? styles.kpiContextWarning : ""}`}>{context}</dd>
    </dl>
  );
}

export function SectionHeading({ id, title, note, level = 2 }: { id?: string; title: string; note?: string; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className={styles.sectionHeading}>
      <H id={id}>{title}</H>
      {note && <p>{note}</p>}
    </div>
  );
}

export function Card({ labelledBy, className = "", children, testId }: { labelledBy?: string; className?: string; children: ReactNode; testId?: string }) {
  return <section aria-labelledby={labelledBy} className={`${styles.card} ${className}`} data-testid={testId}>{children}</section>;
}

export type BarRow = { key: string; label: string; value: string; note?: string; share: number; tone?: "warning" };

/**
 * Labeled bars on a stated scale. The fill is decorative; the label and value carry the number, so the list
 * reads as text without the bar.
 */
export function BarList({ rows, label, cols, gap, className, large = false }: { rows: BarRow[]; label: string; cols?: string; gap?: number; className?: string; large?: boolean }) {
  const style = { ...(cols ? { "--bar-cols": cols } : {}), ...(gap ? { "--bar-gap": `${gap}px` } : {}) } as React.CSSProperties;
  return (
    <ul className={`${styles.bars} ${className ?? ""}`} aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className={`${styles.bar} ${large ? styles.barLarge : ""}`} style={style}>
          <span>{r.label}</span>
          <span className={styles.track} aria-hidden="true"><span className={`${styles.fill} ${r.tone === "warning" ? styles.fillWarning : ""}`} style={{ width: `${(r.share * 100).toFixed(2)}%` }} /></span>
          <span className={styles.barValue}>{r.value}</span>
          {r.note !== undefined && <span className={styles.barNote}>{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** One label and value as its own definition list, for cards whose rows are spaced by the card's own gap. */
export function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return <dl className={styles.details}><div><dt>{label}</dt><dd>{value}</dd></div></dl>;
}

export function Details({ rows, className }: { rows: { label: string; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={`${styles.details} ${className ?? ""}`}>
      {rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
    </dl>
  );
}

/** Table with the design's column widths as proportions. Scrolls inside a labeled region when narrow. */
export function Table({ caption, columns, rows, tight = false, cell12 = false, testId }: { caption: string; columns: { label: string; width: number }[]; rows: { key: string; cells: ReactNode[] }[]; tight?: boolean; cell12?: boolean; testId?: string }) {
  const total = columns.reduce((s, c) => s + c.width, 0);
  return (
    <div className={styles.tableWrap} role="region" aria-label={caption} tabIndex={0} data-testid={testId}>
      <table className={`${styles.table} ${tight ? styles.tableTight : ""} ${cell12 ? styles.tableCell12 : ""}`}>
        <caption className="visually-hidden">{caption}</caption>
        <colgroup>{columns.map((c) => <col key={c.label} style={{ width: `${(100 * c.width) / total}%` }} />)}</colgroup>
        <thead><tr>{columns.map((c) => <th key={c.label} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>{r.cells.map((cell, i) => (i === 0 ? <th key={i} scope="row">{cell}</th> : <td key={i} className={styles.tableNum}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Loading, failure, stale, partial and empty states shared by every analytics read. Stale and partial data stays
 * visible but is labeled; an empty source answer is not shown as zero.
 */
const SOURCE_NAMES: Record<SourceStatus["source"], string> = { orders: "Orders", adPlatforms: "Ad platforms", sessions: "Storefront sessions", support: "Support and reviews" };
const SOURCE_STATE_WORDS: Record<SourceStatus["state"], string> = {
  current: "current", noChange: "current, no change", partial: "partial", stale: "stale", error: "sync failed", neverSynced: "never synced",
  unconfigured: "not connected", unavailable: "could not be read", invalid: "returned unverified data",
};
/** Each served source's own state. A source that is not connected is shown as such; its figures read N/A, never zero. */
export function SourceStates({ sources }: { sources: SourceStatus[] | undefined }) {
  const attention = (sources ?? []).filter((s) => s.state !== "current" && s.state !== "noChange");
  if (!attention.length) return null;
  return (
    <Alert state="warning" title="Some sources are not current" testId="source-states">
      <p>{attention.map((s) => `${SOURCE_NAMES[s.source]}: ${SOURCE_STATE_WORDS[s.state]}`).join(" · ")}. Figures that depend on them read N/A, not zero.</p>
    </Alert>
  );
}
/** Only a served read's per-source states. Other views use a "sources" field for different rows (the launch snapshot), so the shape is checked. */
const sourcesOf = (data: unknown) => {
  if (!data || typeof data !== "object" || !("sources" in data)) return undefined;
  const parsed = z.array(sourceStatusSchema).safeParse((data as { sources: unknown }).sources);
  return parsed.success ? parsed.data : undefined;
};

export function ViewShell<D>({ query, subject, emptyTitle, emptyBody, children }: { query: UseQueryResult<ReadResponse<D>, Error>; subject: string; emptyTitle: string; emptyBody: string; children: (data: D, res: ReadResponse<D>) => ReactNode }) {
  const res = query.data;
  const freshness = res?.sourceFreshness[0];
  return (
    <>
      {query.isPending && <SkeletonCard label={`Loading ${subject.toLowerCase()}…`} />}
      {query.isError && <ViewError error={query.error} subject={subject} hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res?.dataState === "stale" && (
        <Alert state="warning" title="Source data is stale">
          <p>{staleReasonText(freshness)}. Values below are from the last successful sync, {freshness?.lastSourceSuccessAt ? dateTime(freshness.lastSourceSuccessAt) : "at an unknown time"}, not current.</p>
        </Alert>
      )}
      {res?.dataState === "partial" && (
        <Alert state="warning" title="Partial data">
          <p>{res.coverage.expectedCount === null ? `${res.coverage.observedCount ?? "Unknown"} source records observed; total coverage is unknown.` : `${res.coverage.observedCount ?? "Unknown"} of ${res.coverage.expectedCount} source records are available.`} Totals cover only those records.</p>
        </Alert>
      )}
      <SourceStates sources={sourcesOf(res?.data)} />
      {query.isPlaceholderData && <span role="status" className="visually-hidden">Updating results…</span>}
      {res && (res.data && res.dataState !== "empty" ? <div style={{ display: "contents" }} aria-busy={query.isPlaceholderData || undefined}>{children(res.data, res)}</div> : <EmptyState state="Empty" title={emptyTitle}><p>{emptyBody}</p></EmptyState>)}
    </>
  );
}

export function useIsDemo() {
  return useScope().adapter.kind === "demo";
}

/** Reporting-window explanation. The window is fixed in the demo and stated, never implied. */
export function PeriodDialog({ open, onClose, period }: { open: boolean; onClose: () => void; period: string | null }) {
  const demo = useIsDemo();
  return (
    <Dialog open={open} title="A consistent reporting window." badge={demo ? "Demo" : undefined} onClose={onClose}>
      <p>{demo ? `This demo uses ${period ?? "one fixed window"}. ` : ""}Keep the same period across revenue, costs and attribution. A live implementation applies the chosen date range to every panel and labels incomplete periods.</p>
      <Button variant="secondary" onClick={onClose}>{demo ? "Keep demo period" : "Close"}</Button>
    </Dialog>
  );
}

/** Read-only disclosure of where figures came from (CTRL-205). Opening it changes nothing. */
export function ProvenanceDialog({ open, onClose, provenance }: { open: boolean; onClose: () => void; provenance: Provenance }) {
  const demo = useIsDemo();
  return (
    <Dialog open={open} title="Metrics as of" badge={demo ? "Demo" : undefined} onClose={onClose}>
      <dl className={styles.defs}>
        <div><dt>Source</dt><dd>{provenance.source}</dd></div>
        <div><dt>Observed</dt><dd>{dateTime(provenance.observedAt, provenance.timezone)} ({provenance.timezone})</dd></div>
        <div><dt>Coverage</dt><dd>{provenance.coverage}</dd></div>
        <div><dt>Freshness</dt><dd>{provenance.stale ? "Stale. Values are not current." : "Not marked stale in this demo snapshot."}</dd></div>
      </dl>
      <p>This is a disclosure, not a refresh. The label can't make an old snapshot current.</p>
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}

/**
 * Shown where a control points at a record or tool this build can't open: a synthetic or missing reference is named
 * as such, and nothing is claimed to have opened, completed or changed.
 */
export function HandoffDialog({ open, onClose, title, rows, children, action }: { open: boolean; onClose: () => void; title: string; rows: { label: string; value: string }[]; children?: ReactNode; action?: { to: string; label: string } }) {
  const demo = useIsDemo();
  return (
    <Dialog open={open} title={title} badge={demo ? "Demo" : undefined} onClose={onClose}>
      <dl className={styles.defs}>{rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
      {children}
      {action && <LinkButton to={action.to} onClick={onClose}>{action.label}</LinkButton>}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}

/**
 * A filter that lives in the URL. The button shows the current choice, only allowed values are offered, and choosing
 * applies at once by default. Native remote lists opt into committing on Done so changing the query cannot unmount
 * an open choice dialog; Escape discards that draft. The owner retains URL history. It never writes to a source.
 */
export function ChoiceButton({ legend, title, options, value, onChange, width, buttonLabel, applyOnDone = false }: { legend: string; title: string; options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; width?: number; buttonLabel: (current: { value: string; label: string }) => string; applyOnDone?: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const group = useId();
  const current = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" style={width ? { minWidth: width } : undefined} onClick={() => { setDraft(value); setOpen(true); }}>{buttonLabel(current)}</Button>
      <Dialog open={open} title={title} onClose={() => setOpen(false)}>
        <fieldset className={styles.options}>
          <legend>{legend}</legend>
          {options.map((o) => (
            <label key={o.value} className={styles.option} htmlFor={`${group}-${o.value}`}>
              <input id={`${group}-${o.value}`} type="radio" name={group} checked={o.value === (applyOnDone ? draft : current.value)} onChange={() => applyOnDone ? setDraft(o.value) : onChange(o.value)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <Button onClick={() => { setOpen(false); if (applyOnDone && draft !== value) onChange(draft); }}>Done</Button>
      </Dialog>
    </>
  );
}

/** Workspace navigation (Figma 14:100): the current page is a primary button, the others are ghost buttons. */
export function WorkspaceTabs({ tabs }: { tabs: { label: string; to: string; current: boolean }[] }) {
  return (
    <nav aria-label="Overview sections" className={styles.actions} style={{ gap: 8 }}>
      {tabs.map((t) => <LinkButton key={t.label} to={t.to} variant={t.current ? "primary" : "ghost"} style={{ minWidth: 152 }} aria-current={t.current ? "page" : undefined}>{t.label}</LinkButton>)}
    </nav>
  );
}
