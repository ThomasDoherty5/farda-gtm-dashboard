import type { ReactNode } from "react";
import styles from "./DataTable.module.css";

/** Table (Figma sets 6:528, 6:557, 6:564). Scrolls inside a labeled, focusable region on narrow screens. */
type Props = { caption: string; columns: { label: string; width?: string }[]; rows: ReactNode[][]; testId?: string; minWidth?: number };

export function DataTable({ caption, columns, rows, testId, minWidth }: Props) {
  return (
    <div className={styles.scroll} role="region" aria-label={caption} tabIndex={0} data-testid={testId}>
      <table className={styles.table} style={minWidth ? { minWidth } : undefined}>
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
