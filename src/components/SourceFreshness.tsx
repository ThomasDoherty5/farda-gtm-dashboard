import { Badge, type BadgeTone } from "./Badge";
import styles from "./SourceFreshness.module.css";

/**
 * Source freshness (Figma component set 6:500: Live, Synced, Stale, Unknown, Error): the source's name, a
 * state badge, when it was last read, and one action. Unknown is a state of its own and never shows a time,
 * so a missing sync can't be mistaken for a recent one. Stale and Error are announced; the others are quiet.
 */
export type FreshnessState = "live" | "synced" | "stale" | "unknown" | "error";
const BADGE: Record<FreshnessState, { label: string; tone: BadgeTone }> = {
  live: { label: "Live", tone: "success" },
  synced: { label: "Synced", tone: "success" },
  stale: { label: "Stale", tone: "warning" },
  unknown: { label: "Unknown", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

export function SourceFreshness({ source, state, updated, action, onAction }: { source: string; state: FreshnessState; updated?: string | null; action?: string; onAction?: () => void }) {
  const badge = BADGE[state];
  const line = state === "unknown" ? "Last sync unknown" : updated ?? "Last sync time not reported";
  return (
    <div className={`${styles.card} ${state === "error" ? styles.error : ""}`} data-state={state} role={state === "stale" || state === "error" ? "status" : undefined} aria-label={`${source}: ${badge.label}`}>
      <div className={styles.head}>
        <p className={styles.source}>{source}</p>
        <Badge tone={badge.tone} width={122}>{badge.label}</Badge>
      </div>
      <p className={styles.updated}>{line}</p>
      {action && onAction && <button type="button" className={styles.action} onClick={onAction}>{action}</button>}
    </div>
  );
}
