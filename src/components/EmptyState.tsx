import type { ReactNode } from "react";
import { Badge } from "./Badge";
import styles from "./States.module.css";

/** Empty state (Figma component set 6:649). */
type Props = { state: "Empty" | "Loading" | "Denied" | "Error"; title: string; children?: ReactNode; alert?: boolean };

export function EmptyState({ state, title, children, alert = false }: Props) {
  return (
    <div role={alert ? "alert" : undefined} className={styles.empty}>
      <Badge tone={state === "Error" ? "danger" : "neutral"}>{state}</Badge>
      <h2 className={styles.emptyTitle}>{title}</h2>
      <div className={styles.emptyBody}>{children}</div>
    </div>
  );
}

/** Skeleton card (Figma component set 6:659). Widths are the design's; decorative only. */
export function SkeletonCard({ label }: { label: string }) {
  return (
    <div role="status" className={styles.skeleton}>
      <span className="visually-hidden">{label}</span>
      {[120, 240, 180].map((width) => <span key={width} aria-hidden="true" className={styles.bone} style={{ width }} />)}
    </div>
  );
}
