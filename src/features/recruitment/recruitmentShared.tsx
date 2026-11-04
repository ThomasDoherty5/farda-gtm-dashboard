import type { ReactNode } from "react";
import { LinkButton } from "@/components/Button";
import { DEMO_ASSESSMENT_ID, DEMO_CREATOR_ID } from "@/fixtures/ids";
import acquisition from "@/features/acquisition/Acquisition.module.css";
import creators from "@/features/creators/Creators.module.css";
import styles from "./Recruitment.module.css";

export { acquisition, creators, styles };

export const assessmentPath = (model?: string) => `/creators/${DEMO_CREATOR_ID}/assessments/${DEMO_ASSESSMENT_ID}${model ? `?model=${model}` : ""}`;

/** The six 206px navigation buttons under the title. Exactly one is the current view and is marked as such. */
export function NavButtons({ current, items }: { current: string; items: { label: string; to: string }[] }) {
  return (
    <nav className={styles.navRow} aria-label="Creator workspaces">
      {items.map((item) => (
        <LinkButton key={item.label} variant={item.label === current ? "primary" : "secondary"} to={item.to} aria-current={item.label === current ? "page" : undefined} style={{ minWidth: 206 }}>{item.label}</LinkButton>
      ))}
    </nav>
  );
}

/** The violet context box (Figma "Context / Commission-only acquisition"). */
export function ContextBox({ title, text, children }: { title: string; text: ReactNode; children?: ReactNode }) {
  return (
    <div className={acquisition.context}>
      <p className={acquisition.contextTitle}>{title}</p>
      <p className={acquisition.small}>{text}</p>
      {children}
    </div>
  );
}

/** Numbered process tiles. The numbers order the steps; they are not counts. */
export function Steps({ steps, label }: { steps: string[]; label: string }) {
  return (
    <ol className={styles.steps} aria-label={label}>
      {steps.map((step, i) => (
        <li key={step} className={styles.step}><span className={styles.num}>{String(i + 1).padStart(2, "0")}</span><span className={styles.label}>{step}</span></li>
      ))}
    </ol>
  );
}

/** The page heading while the page has no data (loading, not found, no access), so every state still has a first-level heading. */
export function BareTitle({ id, title }: { id: string; title: string }) {
  return (
    <div className={acquisition.titleRow}>
      <div className={acquisition.heading}><h1 id={id}>{title}</h1></div>
    </div>
  );
}
