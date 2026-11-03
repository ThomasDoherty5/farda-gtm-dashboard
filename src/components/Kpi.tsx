import type { ReactNode } from "react";
import styles from "./Kpi.module.css";

/** KPI card (Figma component set 6:516). The label, value and context read together as one definition. */
/** `hug` sizes the card to its content, as Figma's content-sized instances do; the default is the design's fixed 152px. */
export function Kpi({ label, children, context, testId, hug = false }: { label: string; children: ReactNode; context: string; testId?: string; hug?: boolean }) {
  return (
    <dl className={hug ? `${styles.kpi} ${styles.hug}` : styles.kpi}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value} data-testid={testId}>{children}</dd>
      <dd className={styles.context}>{context}</dd>
    </dl>
  );
}

export function KpiRow({ children, columns = 4 }: { children: ReactNode; columns?: number }) {
  return <div className={styles.row} style={{ "--kpi-columns": columns } as React.CSSProperties}>{children}</div>;
}
