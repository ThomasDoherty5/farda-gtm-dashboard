import { Timeline } from "./Timeline";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import styles from "./Panels.module.css";

/** Title, subtitle and actions at the top of a page (Figma "Title and actions", e.g. 4:28). */
export function PageHeader({ id, title, subtitle, children }: { id: string; title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.titleRow}>
      <div className={styles.heading}>
        <h1 id={id}>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className={styles.actions}>{children}</div>}
    </div>
  );
}

export const Page = ({ children, ...rest }: { children: ReactNode; "aria-labelledby": string; "data-figma-source"?: string }) => (
  <section {...rest} className={styles.page}>{children}</section>
);

/** Card with a section heading (Figma frames such as 4:67: 24px padding, 24px radius). */
export function Panel({ title, subtitle, id, roomy = false, spacious = false, large = false, testId, header, children }: { title?: ReactNode; /** The 22px section title used on the finance screens. */ large?: boolean; subtitle?: ReactNode; id?: string; roomy?: boolean; /** 24px between children, as in Figma 66:485. */ spacious?: boolean; testId?: string; /** Replaces the standard heading when the design puts something beside the title. It must contain the h2 with `id`. */ header?: ReactNode; children?: ReactNode }) {
  return (
    <section className={spacious ? `${styles.panel} ${styles.panelSpacious}` : roomy ? `${styles.panel} ${styles.panelRoomy}` : styles.panel} aria-labelledby={id} data-testid={testId}>
      {header ?? <SectionHeading id={id} title={title} subtitle={subtitle} large={large} />}
      {children}
    </section>
  );
}

export function SectionHeading({ id, title, subtitle, large = false }: { id?: string; title: ReactNode; subtitle?: ReactNode; large?: boolean }) {
  return (
    <div className={large ? `${styles.sectionHeading} ${styles.sectionLarge}` : styles.sectionHeading}>
      <h2 id={id}>{title}</h2>
      {subtitle && (typeof subtitle === "string" ? <p>{subtitle}</p> : <div className={styles.sectionCopy}>{subtitle}</div>)}
    </div>
  );
}

/** Notice banner (Figma "Notice / …", e.g. 4:43). A label badge, a title and a sentence. */
export function Notice({ tone, label, title, children, role, testId }: { tone: "violet" | "warning" | "danger" | "success"; label: string; title: string; children: ReactNode; role?: "status" | "alert"; testId?: string }) {
  const badge: BadgeTone = tone;
  return (
    <div className={styles.notice} data-tone={tone} role={role} data-testid={testId}>
      <span className={styles.noticeBadge}><Badge tone={badge} width={122}>{label}</Badge></span>
      <div className={styles.noticeBody}>
        <p className={styles.noticeTitle}>{title}</p>
        <p className={styles.noticeText}>{children}</p>
      </div>
    </div>
  );
}

/** Label and value rows (Figma "Detail / …": a 168px label and 216px value). */
export function FactList({ rows, tight = false, wide = false, labelWidth, gap, label }: { rows: [string, ReactNode][]; tight?: boolean; wide?: boolean; /** Label column width in px, where a design sets one other than 168 or 247. */ labelWidth?: number; /** Row gap in px where a design sets one other than 16. */ gap?: number; label?: string }) {
  const className = [styles.facts, tight && styles.factsTight, wide && styles.factsWide].filter(Boolean).join(" ");
  return (
    <dl className={className} aria-label={label} style={labelWidth || gap ? ({ ...(labelWidth ? { "--fact-label": `${labelWidth}px` } : {}), ...(gap ? { gap } : {}) } as React.CSSProperties) : undefined}>
      {rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

export type StepState = "done" | "current" | "pending" | "problem";
const STEP_TONE: Record<StepState, BadgeTone> = { done: "success", current: "violet", pending: "neutral", problem: "danger" };
const STEP_MARK: Record<StepState, string> = { done: "✓", current: "", pending: "", problem: "!" };
const STEP_STATE_WORD: Record<StepState, string> = { done: "Done", current: "Current", pending: "Not yet", problem: "Problem" };

/** Lifecycle steps (Figma "Step / …"). The number or mark is decoration; the state is also in text for screen readers. */
export function Steps({ steps, label }: { steps: { title: string; note: string; state: StepState }[]; label: string }) {
  return (
    <Timeline label={label} className={styles.steps}>
      {steps.map((step, i) => (
        <li key={step.title} className={styles.step} aria-current={step.state === "current" ? "step" : undefined}>
          <span className={styles.stepMark} aria-hidden="true"><Badge tone={STEP_TONE[step.state]} width={40}>{STEP_MARK[step.state] || String(i + 1)}</Badge></span>
          <div className={styles.stepBody}>
            <p className={styles.stepTitle}>{step.title}<span className="visually-hidden"> · {STEP_STATE_WORD[step.state]}</span></p>
            <p className={styles.stepNote}>{step.note}</p>
          </div>
        </li>
      ))}
    </Timeline>
  );
}

export const Divider = () => <hr className={styles.divider} />;
export const Note = ({ children }: { children: ReactNode }) => <p className={styles.note}>{children}</p>;

/** Two-column row layout used by every detail page (Figma 824/448). Stacks below 1180px. */
export const TwoColumns = ({ children }: { children: ReactNode }) => <div className={`${styles.cols} ${styles.cols2}`}>{children}</div>;
/** Two equal panels. `keepColumns` holds both side by side down to 768px, as the Operations 1024 design does. */
export const HalfColumns = ({ children, keepColumns = false }: { children: ReactNode; keepColumns?: boolean }) => <div className={`${styles.cols} ${styles.cols11}${keepColumns ? ` ${styles.keep}` : ""}`}>{children}</div>;

/**
 * Table with fixed proportional columns and a 1px divider under every row (Figma "Table", e.g. 4:85).
 * `columns` widths are the design's pixel widths and only set proportions. Scrolls inside a labeled region when narrow.
 */
export function FlatTable({ caption, columns, rows, testId }: { caption: string; columns: { label: string; width: number }[]; rows: { key: string; cells: ReactNode[] }[]; testId?: string }) {
  const total = columns.reduce((sum, c) => sum + c.width, 0);
  return (
    <div className={styles.scroll} role="region" aria-label={caption} tabIndex={0} data-testid={testId}>
      <table className={styles.table}>
        <caption className="visually-hidden">{caption}</caption>
        <colgroup>{columns.map((c) => <col key={c.label} style={{ width: `${(100 * c.width) / total}%` }} />)}</colgroup>
        <thead><tr>{columns.map((c) => <th key={c.label} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.key}>{r.cells.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function Meter({ percent, tone, label }: { percent: number; tone?: "warning"; label: string }) {
  return (
    <div className={styles.progress} data-tone={tone} role="img" aria-label={label}>
      <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

/** Labeled bars (Figma "Chart row / …": a 110px label, a 390px track, a 56px value). `max` is the value a full track stands for. */
export function BarRows({ label, rows, max, gap = 16, widths, trackTop }: { label: string; rows: { label: string; value: number; display?: string; warn?: boolean }[]; max: number; gap?: 16 | 20; /** Label, track and value column widths in px where a design sets them other than 110, 390 and 56. */ widths?: [number, number, number]; /** Space above the track in px, where a design sets other than 6. */ trackTop?: number }) {
  return (
    <ul className={styles.barRows} style={{ gap, ...(widths ? ({ "--bar-cols": widths.map((w) => `minmax(0, ${w}px)`).join(" ") } as React.CSSProperties) : {}), ...(trackTop !== undefined ? ({ "--bar-top": `${trackTop}px` } as React.CSSProperties) : {}) }} aria-label={label}>
      {rows.map((r) => (
        <li key={r.label} className={styles.barRow}>
          <span>{r.label}</span>
          <span><Meter percent={(100 * r.value) / max} tone={r.warn ? "warning" : undefined} label={`${r.label}: ${r.display ?? r.value}`} /></span>
          <span>{r.display ?? r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** A tinted box with a title, a sentence and optional actions (Figma "Historical acquisition context", "Context / …"). */
export function ContextCard({ title, tone = "violet", children, actions }: { title: string; tone?: "violet" | "subtle"; children: ReactNode; actions?: ReactNode }) {
  return (
    <aside className={styles.context} data-tone={tone} aria-label={title}>
      <p className={styles.contextTitle}>{title}</p>
      <p className={styles.contextText}>{children}</p>
      {actions && <div className={styles.contextActions}>{actions}</div>}
    </aside>
  );
}

/** Rows of a status badge, a title and an explanation (Figma "Execution gates"). */
export function GateRows({ rows, label }: { rows: { badge: ReactNode; title: string; text: string }[]; label: string }) {
  return (
    <ul className={styles.gates} aria-label={label}>
      {rows.map((r) => (
        <li key={r.title} className={styles.gate}>
          <span className={styles.gateBadge}>{r.badge}</span>
          <span className={styles.gateTitle}>{r.title}</span>
          <span className={styles.gateText}>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
