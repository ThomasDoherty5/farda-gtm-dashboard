import type { ReactNode } from "react";
import styles from "./Kpi.module.css";

/** KPI card (Figma component set 6:516). The label, value and context read together as one definition. */
/** `warn` colors the context line as a caution, for a value that is held rather than known. */
/** `hug` sizes the card to its content, as Figma's content-sized instances do; the default is the design's fixed 152px. */
export function Kpi({ label, children, context, testId, hug = false, warn = false }: { label: string; children: ReactNode; context: string; testId?: string; hug?: boolean; warn?: boolean }) {
  return (
    <dl className={hug ? `${styles.kpi} ${styles.hug}` : styles.kpi}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value} data-testid={testId}>{children}</dd>
      <dd className={warn ? `${styles.context} ${styles.warn}` : styles.context}>{context}</dd>
    </dl>
  );
}

/** `keepColumns` holds the column count down to phone width, for the Operations 1024 design, which keeps three. `align="start"` lets cards keep their own heights, as Figma's content-sized rows do; the default stretches them to one height. */
export function KpiRow({ children, columns = 4, keepColumns = false, align = "stretch" }: { children: ReactNode; columns?: number; keepColumns?: boolean; align?: "stretch" | "start" }) {
  return <div className={align === "start" ? `${styles.row} ${styles.start}` : styles.row} data-keep-columns={keepColumns || undefined} style={{ "--kpi-columns": columns } as React.CSSProperties}>{children}</div>;
}
