import { useEffect, useId, useState, type ReactNode } from "react";
import styles from "./Tooltip.module.css";

/**
 * Tooltip (Figma component set 6:714). Shows on hover and on keyboard focus, stays open while the pointer is
 * over it, and Escape dismisses it without moving focus (WCAG 1.4.13). The trigger receives `aria-describedby`,
 * so the text is its description. A tooltip never holds the only copy of something the user needs: use it for
 * the reason a control is unavailable or an explanation of a term, never for required instructions.
 */
export function Tooltip({ label, children }: { label: string; children: (props: { "aria-describedby": string }) => ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <span className={styles.wrap} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      {children({ "aria-describedby": id })}
      <span id={id} role="tooltip" className={styles.tip} hidden={!open}>{label}</span>
    </span>
  );
}
