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

/**
 * Skeleton (Figma component set 6:659). Card is three bars, Row is two. Widths are the design's and the bars are
 * decorative: the status line says what is loading, so a screen reader hears one message, not empty shapes.
 */
const BARS = { card: [120, 240, 180], row: [220, 160] } as const;

export function Skeleton({ variant, label }: { variant: "card" | "row"; label: string }) {
  return (
    <div role="status" className={styles.skeleton} data-variant={variant}>
      <span className="visually-hidden">{label}</span>
      {BARS[variant].map((width) => <span key={width} aria-hidden="true" className={styles.bone} style={{ width }} />)}
    </div>
  );
}

export const SkeletonCard = ({ label }: { label: string }) => <Skeleton variant="card" label={label} />;
export const SkeletonRow = ({ label }: { label: string }) => <Skeleton variant="row" label={label} />;
