import { forwardRef, type ReactNode } from "react";
import styles from "./States.module.css";

/** Alert (Figma component set 6:616). */
type Props = { state?: "info" | "warning" | "error" | "success"; title: string; testId?: string; focusable?: boolean; children?: ReactNode };

export const Alert = forwardRef<HTMLDivElement, Props>(function Alert({ state = "info", title, testId, focusable = false, children }, ref) {
  return (
    <div ref={ref} role="alert" tabIndex={focusable ? -1 : undefined} data-testid={testId} className={`${styles.alert} ${styles[state]}`}>
      <p className={styles.alertTitle}>{title}</p>
      <div className={styles.alertBody}>{children}</div>
    </div>
  );
});
