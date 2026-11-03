import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

/**
 * Shared button (Figma component set 2:69, 8 variants).
 * Variant names and visuals are PENDING Figma intake; behaviour follows the control contracts:
 * - loading: aria-busy, blocks duplicate submission, keeps its label.
 * - disabledReason: stays focusable (aria-disabled) so the reason is announced, and swallows clicks.
 */
export type ButtonVariant = "pending-default";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & {
  variant?: ButtonVariant;
  loading?: boolean;
  disabledReason?: string | null;
  children: ReactNode;
};

export function Button({ variant = "pending-default", loading = false, disabledReason = null, onClick, children, type = "button", ...rest }: Props) {
  const reasonId = useId();
  const blocked = loading || Boolean(disabledReason);
  return (
    <>
      <button
        {...rest}
        type={type}
        className={styles.button}
        data-variant={variant}
        aria-busy={loading || undefined}
        aria-disabled={blocked || undefined}
        aria-describedby={disabledReason ? reasonId : rest["aria-describedby"]}
        onClick={(e) => {
          if (blocked) { e.preventDefault(); return; }
          onClick?.(e);
        }}
      >
        {children}
        {loading && <span className="visually-hidden"> (in progress)</span>}
      </button>
      {disabledReason && <span id={reasonId} className={styles.reason}>{disabledReason}</span>}
    </>
  );
}
