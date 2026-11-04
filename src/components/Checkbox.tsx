import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Checkbox.module.css";

/**
 * Checkbox (Figma component set 6:443: Unchecked, Checked, Mixed, Disabled). A native input carries the
 * semantics, focus and keyboard; the 20px box is drawn beside it. `mixed` sets the input's indeterminate
 * state, so assistive technology hears "mixed" as well as seeing the dash. `readOnly` keeps a checked
 * policy visible and unchangeable, with the reason supplied by the caller through `describedBy`.
 */
export function Checkbox({ label, checked, mixed = false, disabled = false, readOnly = false, onChange, describedBy, id }: { label: ReactNode; checked: boolean; mixed?: boolean; disabled?: boolean; readOnly?: boolean; onChange?: (checked: boolean) => void; describedBy?: string; id?: string }) {
  const generated = useId();
  const inputId = id ?? generated;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  const on = checked || mixed;
  return (
    <div className={`${styles.checkbox} ${disabled ? styles.disabled : ""} ${readOnly ? styles.readonly : ""}`} data-readonly={readOnly || undefined}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        aria-readonly={readOnly || undefined}
        aria-describedby={describedBy}
        onChange={(e) => { if (!readOnly) onChange?.(e.target.checked); }}
      />
      <span className={`${styles.box} ${on ? styles.on : ""}`} aria-hidden="true">{mixed ? "−" : checked ? "✓" : ""}</span>
      <label htmlFor={inputId} className={styles.label}>{label}</label>
    </div>
  );
}
