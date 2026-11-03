import { useEffect, useId, useRef, type ReactNode } from "react";
import { Badge } from "./Badge";
import styles from "./Dialog.module.css";

type Props = { open: boolean; title: string; badge?: string; onClose: () => void; children: ReactNode };

/**
 * Modal dialog, from the Figma dialogs such as 51:1945. Native <dialog> traps focus, closes on
 * Escape and returns focus to the trigger.
 */
export function Dialog({ open, title, badge, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open) ref.current?.showModal?.();
    else ref.current?.close?.();
  }, [open]);
  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && (
        <div className={styles.body}>
          {badge && <Badge tone="violet" width={190}>{badge}</Badge>}
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
