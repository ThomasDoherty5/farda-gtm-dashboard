import type { ReactNode } from "react";
import styles from "./DataTable.module.css";

/** Table (Figma sets 6:528, 6:557, 6:564). Scrolls inside a labeled, focusable region on narrow screens. */
/** `variant="ledger"` is the Figma settings table: a medium first cell, muted others and 16px row padding (e.g. 7:957). `dense` has Figma's 62px rows (8px row padding around 12px cells, e.g. 14:743). `minWidth` overrides the 640px default. */
type Props = { caption: string; columns: { label: string; width?: string }[]; rows: ReactNode[][]; testId?: string; variant?: "plain" | "ledger" | "dense"; minWidth?: number };

export function DataTable({ caption, columns, rows, testId, variant = "plain", minWidth }: Props) {
  return (
    <div className={styles.scroll} role="region" aria-label={caption} tabIndex={0} data-testid={testId}>
      <table className={variant === "plain" ? styles.table : `${styles.table} ${styles.ledger} ${variant === "dense" ? styles.dense : ""}`} style={minWidth !== undefined ? { minWidth } : undefined}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c.label} scope="col" style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>{cells.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
