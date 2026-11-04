import type { ReactNode } from "react";
import styles from "./DataTable.module.css";

/** Table (Figma sets 6:528, 6:557, 6:564). Scrolls inside a labeled, focusable region on narrow screens. */
/**
 * `variant="ledger"` is the Figma settings table: a medium first cell, muted others and 16px row padding (e.g. 7:957). `dense` has Figma's 62px rows
 * (8px row padding around 12px cells, e.g. 14:743). `list` is Figma's worklist: 16px row padding, no side padding, muted detail cells.
 * `table` is the plain default. `minWidth` overrides the 640px default.
 */
type Props = { caption: string; columns: { label: string; width?: string }[]; rows: ReactNode[][]; testId?: string; minWidth?: number; variant?: "table" | "plain" | "ledger" | "dense" | "list" };

export function DataTable({ caption, columns, rows, testId, minWidth, variant = "table" }: Props) {
  const tableClass = variant === "table" || variant === "plain" ? styles.table : variant === "list" ? `${styles.table} ${styles.list}` : `${styles.table} ${styles.ledger} ${variant === "dense" ? styles.dense : ""}`;
  return (
    <div className={styles.scroll} role="region" aria-label={caption} tabIndex={0} data-testid={testId}>
      <table className={tableClass} style={minWidth !== undefined ? { minWidth } : undefined}>
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
