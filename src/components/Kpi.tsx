import type { ReactNode } from "react";
import styles from "./Kpi.module.css";

/** KPI card (Figma component set 6:516). The label, value and context read together as one definition. */
export function Kpi({ label, children, context, testId }: { label: string; children: ReactNode; context: string; testId?: string }) {
  return (
    <dl className={styles.kpi}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value} data-testid={testId}>{children}</dd>
      <dd className={styles.context}>{context}</dd>
    </dl>
  );
}

export function KpiRow({ children, columns = 4 }: { children: ReactNode; columns?: number }) {
  return <div className={styles.row} style={{ "--kpi-columns": columns } as React.CSSProperties}>{children}</div>;
}
