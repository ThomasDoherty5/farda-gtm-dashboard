import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import styles from "./StepCard.module.css";

/**
 * Step (Figma component set 6:595: Pending, Approval, Running, Completed, Failed): one task step as a card with
 * its state in words, a title and a one-line description. This is the card form; the numbered row form used by
 * lifecycle screens is Figma's "Lifecycle/Step" (5:3), built as `Steps`. Render inside a list with `as="li"`.
 */
export type StepCardState = "pending" | "approval" | "running" | "completed" | "failed";
const BADGE: Record<StepCardState, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pending", tone: "neutral" },
  approval: { label: "Approval", tone: "warning" },
  running: { label: "Running", tone: "violet" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export function StepCard({ state, title, description, as: Tag = "div", children }: { state: StepCardState; title: string; description: string; as?: "div" | "li"; children?: ReactNode }) {
  const badge = BADGE[state];
  return (
    <Tag className={styles.card} data-state={state} aria-current={state === "running" ? "step" : undefined}>
      <Badge tone={badge.tone} width={132}>{badge.label}</Badge>
      <p className={styles.title}>{title}</p>
      <p className={styles.description}>{description}</p>
      {children}
    </Tag>
  );
}
