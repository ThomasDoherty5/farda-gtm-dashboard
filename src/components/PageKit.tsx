import { Timeline } from "./Timeline";
import type { CSSProperties, ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import { LinkButton } from "./Button";
import styles from "./PageKit.module.css";

/** Page-level pieces shared by the settings, automation and lifecycle screens. Each maps to a repeated Figma frame. */

/** "Title and actions" (e.g. 7:898): the heading with its action buttons beside it. Figma fixes the heading width per screen (850, 860 or 1070), so the buttons follow it rather than sitting at the right edge. */
export function PageHeader({ id, title, subtitle, titleWidth = 850, children }: { id: string; title: string; subtitle: string; titleWidth?: number; children?: ReactNode }) {
  return (
    <div className={styles.titleRow}>
      <div className={styles.heading} style={{ flexBasis: titleWidth }}>
        <h1 id={id}>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

/** A bordered card with a "Section heading" (e.g. 7:919). `large` is the 22px heading used on full-width cards, `roomy` is the 24px gap Figma uses on the capability matrix, and `headingGap` is the 4px, 6px or 20px between a heading and its note (Figma uses all three). */
export function Panel({ title, note, large = false, roomy = false, tight = false, headingGap, headingId, testId, children }: { title: string; note?: string | undefined; large?: boolean; roomy?: boolean; tight?: boolean; headingGap?: 4 | 6 | 20; headingId: string; testId?: string; children: ReactNode }) {
  return (
    <section className={`${styles.card} ${large ? styles.cardLarge : ""} ${roomy ? styles.cardRoomy : ""} ${tight ? styles.cardTight : ""}`} aria-labelledby={headingId} data-testid={testId}>
      <div className={styles.sectionHead} style={{ gap: headingGap ?? (large ? 6 : 4) }}>
        <h2 id={headingId} className={large ? styles.heading2 : styles.heading3}>{title}</h2>
        {note && <p>{note}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * The violet boxes under a page title. `context` is the bordered "Current acquisition policy" box that can hold actions,
 * `plain` is the borderless notice, and `source` is the notice with a leading "Source" badge.
 */
export function Notice({ title, kind = "context", badge, actions, actionsGap, descriptionId, children }: { title: string; kind?: "context" | "plain" | "source"; badge?: string; actions?: ReactNode; /** Space between the action buttons in px, where a design sets other than 12. */ actionsGap?: number; descriptionId?: string; children: ReactNode }) {
  if (kind === "source")
    return (
      <div className={styles.source}>
        {badge && <Badge tone="violet" width={122}>{badge}</Badge>}
        <div className={styles.sourceCopy}>
          <p className={styles.contextTitle}>{title}</p>
          <p className={styles.small}>{children}</p>
        </div>
      </div>
    );
  return (
    <div className={`${styles.context} ${kind === "plain" ? styles.contextPlain : ""}`}>
      <p className={styles.contextTitle}>{title}</p>
      <p id={descriptionId} className={styles.small}>{children}</p>
      {actions && <div className={styles.row} style={actionsGap ? { gap: actionsGap } : undefined}>{actions}</div>}
    </div>
  );
}

/** Label and value rows (Figma "Detail" rows such as 7:1017). `gap` and `labelWidth` follow the card the rows sit in (some use 20px and a 165px label). */
export function DetailRows({ rows, wide = false, gap, labelWidth }: { rows: readonly (readonly [string, string])[]; wide?: boolean; gap?: number; labelWidth?: number }) {
  const style = { ...(gap ? { gap } : {}), ...(labelWidth ? { "--detail-label": `${labelWidth}px` } : {}) } as CSSProperties;
  return (
    <dl className={`${styles.details} ${wide ? styles.detailsWide : ""}`} style={style}>
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

export const Divider = () => <hr className={styles.divider} />;

export type Step = { n: string; tone: BadgeTone; title: string; note: string };

/** Numbered steps (Figma "Step" rows such as 7:1228). The number is a badge, and the list order carries the sequence. */
export function Steps({ steps, divided = false }: { steps: readonly Step[]; divided?: boolean }) {
  return (
    <Timeline label="Workflow steps" className={`${styles.steps} ${divided ? styles.stepsDivided : ""}`}>
      {steps.map((s) => (
        <li key={s.n} className={styles.step}>
          <Badge tone={s.tone} width={40}>{s.n}</Badge>
          <div className={styles.stepCopy}>
            <p className={styles.contextTitle}>{s.title}</p>
            <p className={styles.small}>{s.note}</p>
          </div>
        </li>
      ))}
    </Timeline>
  );
}

export type Gate = { chip: string; tone: BadgeTone; title: string; note: string };

/** Gate rows: a state badge, a title and the evidence it needs (e.g. 70:892). */
export function Gates({ gates }: { gates: readonly Gate[] }) {
  return (
    <ul className={styles.gates}>
      {gates.map((g) => (
        <li key={g.title} className={styles.gate}>
          <Badge tone={g.tone} width={140}>{g.chip}</Badge>
          <p className={styles.gateTitle}>{g.title}</p>
          <p className={styles.small}>{g.note}</p>
        </li>
      ))}
    </ul>
  );
}

export const Row = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => <div className={styles.row} style={style}>{children}</div>;
export const Split = ({ children }: { children: ReactNode }) => <div className={styles.split}>{children}</div>;
export const Halves = ({ children }: { children: ReactNode }) => <div className={styles.halves}>{children}</div>;
export const Page = ({ labelledBy, source, children }: { labelledBy: string; source: string; children: ReactNode }) => (
  <section aria-labelledby={labelledBy} data-figma-source={source} className={styles.page}>{children}</section>
);
export const Small = ({ children }: { children: ReactNode }) => <p className={styles.small}>{children}</p>;
export const kit = styles;

/** A state badge and one line of context beneath the title (Figma "Context" and "Flow context", e.g. 5:322). */
export function ContextLine({ badge, tone = "violet", width = 160, trailing, children }: { badge: string; tone?: BadgeTone; width?: number; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.contextLine}>
      <Badge tone={tone} width={width}>{badge}</Badge>
      <p className={styles.small}>{children}</p>
      {trailing}
    </div>
  );
}

export type PillItem = { label: string; to: string; width: number; current?: boolean };

/** Section links drawn as pills (Figma "Secondary navigation", e.g. 5:315). The current one is marked with aria-current. */
export function PillNav({ label, items, gap = 12 }: { label: string; items: PillItem[]; gap?: 8 | 12 }) {
  return (
    <nav aria-label={label} className={styles.row} style={{ gap }}>
      {items.map((i) => (
        <LinkButton key={i.label} to={i.to} variant={i.current ? "primary" : "ghost"} aria-current={i.current ? "page" : undefined} style={{ minWidth: i.width }}>{i.label}</LinkButton>
      ))}
    </nav>
  );
}
