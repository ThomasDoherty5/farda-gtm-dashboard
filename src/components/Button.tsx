import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import styles from "./Button.module.css";

/**
 * Shared button (Figma component set 2:69). Hover, pressed, focus, disabled and loading are the
 * set's other variants, expressed as states here.
 * - loading: shows "Working…", sets aria-busy, blocks duplicate submission.
 * - disabledReason: stays focusable (aria-disabled) so the reason is announced, and swallows clicks.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & {
  variant?: ButtonVariant;
  loading?: boolean;
  disabledReason?: string | null;
  children: ReactNode;
};

const classes = (variant: ButtonVariant, className?: string) => [styles.button, styles[variant], className].filter(Boolean).join(" ");

export function Button({ variant = "primary", loading = false, disabledReason = null, onClick, children, type = "button", className, ...rest }: Props) {
  const reasonId = useId();
  const blocked = loading || Boolean(disabledReason);
  return (
    <>
      <button
        {...rest}
        type={type}
        className={classes(variant, className)}
        aria-busy={loading || undefined}
        aria-disabled={blocked || undefined}
        aria-describedby={disabledReason ? reasonId : rest["aria-describedby"]}
        onClick={(e) => {
          if (blocked) { e.preventDefault(); return; }
          onClick?.(e);
        }}
      >
        {loading ? <><span aria-hidden="true">Working…</span><span className="visually-hidden">{children} in progress</span></> : children}
      </button>
      {disabledReason && <span id={reasonId} className={styles.reason}>{disabledReason}</span>}
    </>
  );
}

/** A link that navigates, styled as a button. */
export function LinkButton({ variant = "primary", className, ...rest }: LinkProps & { variant?: ButtonVariant }) {
  return <Link {...rest} className={classes(variant, className)} />;
}
