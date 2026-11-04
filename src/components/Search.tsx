import { useId } from "react";
import styles from "./Search.module.css";

/**
 * Search (Figma component set 6:414: Default, Focus, Query). A 320 × 48 pill. The placeholder is the
 * Default text and the typed value is the Query text; Focus is the 2px violet border on :focus-within.
 * The label is required and is the accessible name, because a placeholder is not one.
 */
export function SearchField({ label, value, onChange, placeholder = label, width, fluid = false, testId, id }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; width?: number | string; /** Fills its row below 1180px, as the Monitor filter bar does. */ fluid?: boolean; testId?: string; id?: string }) {
  const generated = useId();
  return (
    <div className={fluid ? `${styles.search} ${styles.fluid}` : styles.search} style={width === undefined ? undefined : { width }} data-testid={testId}>
      <input id={id ?? generated} type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
