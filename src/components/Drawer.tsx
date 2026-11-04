import { useId, type ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import styles from "./Drawer.module.css";
import { useModalDialog } from "./useModalDialog";

/**
 * Drawer (Figma component set 6:703, "Detail"): a 420px panel for one record's details, opened beside the page
 * so the list stays in context. It is a modal dialog docked to the right: focus is trapped, Escape closes it
 * and focus returns to the control that opened it. The status badge names the record's state in words.
 */
export function Drawer({ open, title, badge, tone = "warning", details, note, action, onClose, children }: { open: boolean; title: string; badge?: string; tone?: BadgeTone; details?: readonly (readonly [string, ReactNode])[]; note?: ReactNode; action?: ReactNode; onClose: () => void; children?: ReactNode }) {
  const { ref, onCancel } = useModalDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog ref={ref} className={styles.drawer} aria-labelledby={titleId} onCancel={onCancel}>
      {open && (
        <div className={styles.body}>
          <div className={styles.head}>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${title}`}>Close</button>
          </div>
          {badge && <div><Badge tone={tone} width={182}>{badge}</Badge></div>}
          {details && (
            <dl className={styles.details}>
              {details.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
            </dl>
          )}
          {(details || note) && <hr className={styles.divider} />}
          {note && <p className={styles.note}>{note}</p>}
          {children}
          {action}
        </div>
      )}
    </dialog>
  );
}
