import type { CSSProperties, ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
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

/** A bordered card with a "Section heading" (e.g. 7:919). `large` is the 22px heading used on full-width cards, `roomy` is the 24px gap Figma uses on the capability matrix, and `headingGap` is the 4px or 6px between a heading and its note (Figma uses both). */
export function Panel({ title, note, large = false, roomy = false, headingGap, headingId, testId, children }: { title: string; note?: string | undefined; large?: boolean; roomy?: boolean; headingGap?: 4 | 6; headingId: string; testId?: string; children: ReactNode }) {
  return (
    <section className={`${styles.card} ${large ? styles.cardLarge : ""} ${roomy ? styles.cardRoomy : ""}`} aria-labelledby={headingId} data-testid={testId}>
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
export function Notice({ title, kind = "context", badge, actions, descriptionId, children }: { title: string; kind?: "context" | "plain" | "source"; badge?: string; actions?: ReactNode; descriptionId?: string; children: ReactNode }) {
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
      {actions && <div className={styles.row}>{actions}</div>}
    </div>
  );
}

/** Label and value rows (Figma "Detail" rows such as 7:1017). */
export function DetailRows({ rows, wide = false }: { rows: readonly (readonly [string, string])[]; wide?: boolean }) {
  return (
    <dl className={`${styles.details} ${wide ? styles.detailsWide : ""}`}>
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

export const Divider = () => <hr className={styles.divider} />;

export type Step = { n: string; tone: BadgeTone; title: string; note: string };

/** Numbered steps (Figma "Step" rows such as 7:1228). The number is a badge, and the list order carries the sequence. */
export function Steps({ steps, divided = false }: { steps: readonly Step[]; divided?: boolean }) {
  return (
    <ol className={`${styles.steps} ${divided ? styles.stepsDivided : ""}`}>
      {steps.map((s) => (
        <li key={s.n} className={styles.step}>
          <Badge tone={s.tone} width={40}>{s.n}</Badge>
          <div className={styles.stepCopy}>
            <p className={styles.contextTitle}>{s.title}</p>
            <p className={styles.small}>{s.note}</p>
          </div>
        </li>
      ))}
    </ol>
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
