import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import styles from "./StatePanel.module.css";

/**
 * A recovery or feedback state (Figma "State / …", e.g. 12:561): what happened, in words, and the next step.
 * The badge carries the state's name, so color never carries it alone. `busy` marks a region that is still loading.
 */
export function StatePanel({ badge, tone = "neutral", title, testId, busy = false, bodyId, children, actions }: { badge: string; tone?: BadgeTone; title: string; testId?: string; busy?: boolean; bodyId?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <article className={styles.panel} data-testid={testId} aria-label={title} aria-busy={busy || undefined}>
      <Badge tone={tone} width={184}>{badge}</Badge>
      <h3>{title}</h3>
      <p id={bodyId} className={styles.body}>{children}</p>
      {actions}
    </article>
  );
}

/** Placeholder bars for content that is loading (Figma 12:566). Decorative: the status line says what is loading. */
export function LoadingBones({ widths = [350, 292, 318] }: { widths?: number[] }) {
  return (
    <div className={styles.bones} aria-hidden="true">
      {widths.map((w) => <span key={w} className={styles.bone} style={{ width: w }} />)}
    </div>
  );
}

export const stateStyles = styles;
