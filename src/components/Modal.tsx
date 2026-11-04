import { useId, type ReactNode } from "react";
import { Button } from "./Button";
import styles from "./Modal.module.css";
import { useModalDialog } from "./useModalDialog";

/**
 * Modal (Figma component set 6:687: Confirm, Access, Reconcile): a 460px question with Cancel and one
 * confirming action. The variants differ only in the confirming label ("Continue", or "Open source" for
 * Reconcile). Cancel is first in the order and Escape cancels. `busy` blocks a second confirmation while
 * the first is in flight, and the dialog stays open until the owner closes it, so it never reports a
 * result it hasn't received.
 */
export type ModalState = "confirm" | "access" | "reconcile";
const CONFIRM_LABEL: Record<ModalState, string> = { confirm: "Continue", access: "Continue", reconcile: "Open source" };

export function Modal({ open, state = "confirm", title, description, confirmLabel, cancelLabel = "Cancel", busy = false, confirmDisabledReason = null, onConfirm, onCancel, children }: { open: boolean; state?: ModalState; title: string; description: string; confirmLabel?: string; cancelLabel?: string; busy?: boolean; confirmDisabledReason?: string | null; onConfirm: () => void; onCancel: () => void; children?: ReactNode }) {
  const { ref, onCancel: onEscape } = useModalDialog(open, onCancel);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <dialog ref={ref} className={styles.modal} aria-labelledby={titleId} aria-describedby={descriptionId} data-state={state} onCancel={onEscape}>
      {open && (
        <div className={styles.body}>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          <p id={descriptionId} className={styles.description}>{description}</p>
          {children}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
            <Button loading={busy} disabledReason={confirmDisabledReason} onClick={onConfirm}>{confirmLabel ?? CONFIRM_LABEL[state]}</Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
