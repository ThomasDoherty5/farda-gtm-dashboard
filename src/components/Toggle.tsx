import { useId } from "react";
import styles from "./Toggle.module.css";

/**
 * Toggle (Figma component set 6:459: Off, On, Disabled). A switch button: `role="switch"` with `aria-checked`,
 * so the label and state are announced and Space or Enter flips it; the label is part of the button, so clicking
 * it flips the switch too. A disabled switch that is on is still drawn on (thumb right, muted track), so the picture matches `aria-checked`. Disabled keeps the switch focusable and says why, as Button does, so the reason is
 * reachable without a pointer.
 */
export function Toggle({ label, checked, onChange, disabledReason = null }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabledReason?: string | null }) {
  const reasonId = useId();
  const blocked = Boolean(disabledReason);
  return (
    <div className={styles.toggle}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? reasonId : undefined}
        className={styles.button}
        onClick={() => { if (!blocked) onChange(!checked); }}
      >
        <span className={`${styles.track} ${checked ? (blocked ? styles.onDisabled : styles.on) : ""}`} data-visual={checked ? "on" : "off"} aria-hidden="true"><span className={styles.thumb} /></span>
        <span className={`${styles.label} ${blocked ? styles.muted : ""}`}>{label}</span>
      </button>
      {blocked && <span id={reasonId} className={styles.reason}>{disabledReason}</span>}
    </div>
  );
}
