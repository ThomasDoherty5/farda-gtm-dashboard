import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/Badge";
import { SkeletonCard } from "@/components/EmptyState";
import { ViewError } from "@/components/ViewError";
import { Button, LinkButton } from "@/components/Button";
import { SectionTabs } from "@/components/SectionTabs";
import { SourceDialog } from "@/features/approvals/shared";
import { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID } from "@/fixtures/ids";
import { CUMULATIVE_DAYS } from "@/fixtures/creators";
import { pipelineSources } from "@/fixtures/pipeline";
import acquisition from "@/features/acquisition/Acquisition.module.css";
import styles from "./Creators.module.css";

export const evidencePath = `/creators/${DEMO_CREATOR_ID}/evidence/${DEMO_EVIDENCE_ID}`;

/** Heading, subtitle and the two title actions (Figma "Title and actions"). */
export function PageTitle({ id, title, subtitle, children }: { id: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className={acquisition.titleRow}>
      <div className={acquisition.heading}>
        <h1 id={id}>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

/** A button that hands off to a source system. It never invents a destination: no verified link says so (CTRL source profile). */
export function SourceButton({ label, title, width, variant = "secondary" }: { label: string; title: string; width: number; variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} aria-haspopup="dialog" style={{ minWidth: `min(${width}px, 100%)` }} onClick={() => setOpen(true)}>{label}</Button>
      <SourceDialog open={open} title={title} url={null} onClose={() => setOpen(false)} />
    </>
  );
}

/** Platform switch on the dashboards: four tabs, the current one marked (Figma "Section navigation"). */
export function DashboardTabs({ current }: { current: "Social Cat" | "TikTok Shop" }) {
  const tabs = [
    { label: "Social Cat", to: "/creators/social-cat?view=dashboard" },
    { label: "TikTok Shop", to: "/creators/tiktok?view=dashboard" },
    { label: "Content monitor", to: "/content" },
    { label: "Watchlist", to: "/creators/watchlist" },
  ];
  return (
    <div className={styles.row}>
      <SectionTabs label="Creator platforms" gap={12} tabs={tabs.map((t) => ({ ...t, width: 164, current: t.label === current }))} />
      <span className={styles.spacer} style={{ "--spacer": "110px" } as React.CSSProperties} aria-hidden="true" />
      <Badge tone="warning" width={264}>Demo · hourly plan not live</Badge>
    </div>
  );
}

/** Commission-only context shown above both dashboards (Figma 107:268). */
export function CommissionContext() {
  return (
    <div className={acquisition.context}>
      <p className={acquisition.contextTitle}>Commission-only acquisition</p>
      <p className={acquisition.small}>Discover and review lifestyle creators daily. No upfront content fee; product and shipping are approved separately. Recruitment source, publishing network and checkout remain separate.</p>
      <div className={styles.contextActions}>
        <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
        <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
        <LinkButton variant="secondary" to={evidencePath} style={{ minWidth: 223.5 }}>Review lifestyle evidence</LinkButton>
      </div>
    </div>
  );
}

/** Context above both boards: the snapshot is illustrative, and the full funnel is a separate cohort (Figma 107:583). */
export function BoardContext() {
  return (
    <div className={acquisition.context}>
      <p className={acquisition.contextTitle}>Operational stages and acquisition conversion</p>
      <p className={acquisition.small}>These cards show an illustrative operational snapshot. The full funnel follows a separate mature acquisition cohort. New offers are commission-only; accepted historical terms remain valid.</p>
      <div className={styles.contextActions}>
        <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
        <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
      </div>
    </div>
  );
}

/** Platform switch on the boards: two badges, the other platform linked (Figma "Platform tabs"). */
export function BoardPlatforms({ current, children }: { current: "Social Cat" | "TikTok Shop"; children: ReactNode }) {
  return (
    <div className={styles.row}>
      {current === "Social Cat" ? <Badge tone="violet" width={122}>Social Cat</Badge> : <Badge to="/creators/social-cat?view=board" width={122}>Social Cat</Badge>}
      {current === "TikTok Shop" ? <Badge tone="violet" width={128}>TikTok Shop</Badge> : <Badge to="/creators/tiktok?view=board" width={128}>TikTok Shop</Badge>}
      <span className={styles.spacer} style={{ "--spacer": "560px" } as React.CSSProperties} aria-hidden="true" />
      {children}
    </div>
  );
}

/** Cumulative line and area (Figma "Native view curve and area"), drawn from data so a filter redraws it. Its table is the text equivalent. */
export function CumulativeChart({ title, series, unit, scaleMax }: { title: string; series: number[]; unit: string; scaleMax: number }) {
  const x = (i: number) => 44 + (i * 732) / 13;
  const y = (v: number) => 212 - (v / scaleMax) * 196;
  const points = series.map((v, i) => [Number(x(i).toFixed(2)), Number(y(v).toFixed(2))] as const);
  const line = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join("");
  const last = points[points.length - 1]!;
  const ticks = [scaleMax, (scaleMax * 2) / 3, scaleMax / 3, 0];
  const label = (v: number) => `${Math.round(v / 1000)}k`;
  return (
    <div className={styles.chartScroll} role="region" aria-label={`${title}, drawn on a shared ${label(scaleMax)} scale`} tabIndex={0}>
      <div className={styles.chart} data-testid="cumulative-chart">
        {ticks.map((t, i) => {
          const top = 16 + i * 65.33;
          return (
            <Fragment key={i}>
              <span className={styles.tick} style={{ top: top - 8 }} aria-hidden="true">{label(t)}</span>
              <span className={styles.grid} style={{ top }} aria-hidden="true" />
            </Fragment>
          );
        })}
        <svg className={styles.curve} width="784" height="244" viewBox="0 0 784 244" fill="none" aria-hidden="true" focusable="false">
          <path d={`${line}V212H44Z`} fill="var(--color-violetSoft)" />
          <path d={line} stroke="var(--color-violet)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={last[0]} cy={last[1]} r="5" fill="var(--color-violet)" />
        </svg>
        {[0, 4, 8, 13].map((i) => (
          <span key={i} className={styles.day} style={{ left: i === 13 ? 734 : x(i) }} aria-hidden="true">{CUMULATIVE_DAYS[i]}</span>
        ))}
      </div>
      <div className="visually-hidden"><table>
        <caption>{title} by day ({unit})</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Cumulative {unit}</th></tr></thead>
        <tbody>{series.map((v, i) => <tr key={i}><th scope="row">{CUMULATIVE_DAYS[i]}</th><td>{v.toLocaleString("en-US")}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

/** Dark action card (Figma 23:359 and the TikTok equivalent). Counts are queue sizes, not approvals or sends. */
export function QueuePanel({ title, items, buttonLabel, to, note }: { title: string; items: { count: number; label: string }[]; buttonLabel: string; to: string; note: string }) {
  return (
    <section className={`${styles.panel} ${styles.panelDark}`} aria-label={title} data-testid="action-queue">
      <h2 className={acquisition.h2} style={{ color: "var(--color-onDark)" }}>{title}</h2>
      <ul className={styles.queueList}>
        {items.map((item) => (
          <li key={item.label} className={styles.queueRow}>
            <span className={styles.num}>{String(item.count).padStart(2, "0")}</span>
            <span className={styles.text}>{item.label}</span>
          </li>
        ))}
      </ul>
      <LinkButton variant="secondary" to={to} style={{ width: "100%" }}>{buttonLabel}</LinkButton>
      <p className={acquisition.small}>{note}</p>
    </section>
  );
}

/** From invitation to retained sales: one source of the separate acquisition cohort, read from the pipeline fixture (Figma 107:278). */
export function FunnelStrip({ source, matchLabel, matchContext, subtitle }: { source: "social-cat" | "tiktok-shop"; matchLabel: string; matchContext: string; subtitle: string }) {
  const facts = pipelineSources.find((s) => s.source === source)!;
  const r = facts.reached;
  const cells: [string, number | null, string][] = [
    ["Confirmed invites", r[4] ?? null, `${r[4]} unique recipients`],
    [matchLabel, r[5] ?? null, matchContext],
    ["Terms confirmed", r[6] ?? null, "Explicit accepted agreement"],
    ["Tracking active", r[7] ?? null, "Commerce route verified"],
    ["Published creators", r[8] ?? null, "Creator grain, not posts"],
    ["Retained-order creators", r[9] ?? null, "Creator grain, not orders"],
  ];
  return (
    <section className={`${styles.panel} ${styles.panelWide}`} aria-labelledby={`strip-${source}`} data-testid="funnel-strip">
      <div className={styles.sectionRow}>
        <div className={`${acquisition.sectionTitle} ${styles.grow}`}>
          <h2 id={`strip-${source}`} className={acquisition.h2}>From invitation to retained sales.</h2>
          <p className={acquisition.small}>{subtitle}</p>
        </div>
        <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 230 }}>Full acquisition funnel</LinkButton>
      </div>
      <dl className={styles.funnelStrip}>
        {cells.map(([label, value, context]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={styles.value}>{value ?? "N/A"}</dd>
            <dd className={styles.context}>{context}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.divider} />
      <p className={acquisition.small}>This acquisition cohort is separate from the performance snapshot above. Open the full funnel for stage conversion, elapsed time, drop-offs and confirmed-send evidence.</p>
    </section>
  );
}

export const collaborationPath = (id: string) => `/collaborations/${id}?tab=overview`;
export const CollaborationLink = ({ id }: { id: string }) => <Link className={styles.cardLink} to={collaborationPath(id)}>View collaboration →</Link>;

export function Pending({ query, subject, children }: { query: { isPending: boolean; isError: boolean; isPlaceholderData?: boolean; error: Error | null; data?: ReadResponse<unknown>; refetch: () => unknown }; subject: string; children: React.ReactNode }) {
  return (
    <>
      {query.isPlaceholderData && <p className={styles.footnote} role="status">Updating…</p>}
      {query.isPending && <SkeletonCard label={`Loading ${subject}…`} />}
      {query.isError && <ViewError error={query.error!} subject={subject} hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {children}
    </>
  );
}

export function StaleNotice({ res }: { res: ReadResponse<unknown> }) {
  return (
    <>
      {res.dataState === "stale" && <Alert state="warning" title="This view may be out of date" testId="view-stale"><p>Values below are from the last successful read, not current.</p></Alert>}
      {res.dataState === "partial" && <Alert state="warning" title="Some data is missing" testId="view-partial"><p>Unknown values show N/A, never zero.</p></Alert>}
    </>
  );
}

