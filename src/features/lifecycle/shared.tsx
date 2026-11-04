import { useId } from "react";
import { Checkbox } from "@/components/Checkbox";
import { mandatoryPolicies, type FlowStep } from "@/fixtures/lifecycle";
import styles from "./Lifecycle.module.css";

/** "Lifecycle/Step" rows (Figma 5:3). A hold is a text label as well as a color. */
export function FlowSteps({ steps }: { steps: FlowStep[] }) {
  return (
    <ol className={styles.steps}>
      {steps.map((s) => (
        <li key={s.n} className={styles.step}>
          <span className={styles.stepNumber} aria-hidden="true">{s.n}</span>
          <div className={styles.stepBody}>
            <p className={styles.stepTitle}>{s.title}</p>
            <p className={styles.stepKind}>{s.note}</p>
          </div>
          <span className={s.hold ? `${styles.stepKind} ${styles.hold}` : styles.stepKind}>{s.kind}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The three mandatory send policies (CTRL-182 to CTRL-196). They are locked and checked, with no way to change them, and the reason
 * is on the page. The server rechecks consent, suppression and duplicates at send time, so no client state can bypass them.
 */
export function LockedPolicies() {
  const reasonId = useId();
  return (
    <>
      <fieldset className={styles.policies} aria-describedby={reasonId}>
        <legend>Mandatory send policies, locked</legend>
        {mandatoryPolicies.map((label) => (
          <Checkbox key={label} label={label} checked readOnly describedBy={reasonId} />
        ))}
      </fieldset>
      <p id={reasonId} className={styles.stepKind}>Locked policies. The server enforces them at send time, so a changed or forged request can't bypass them. Changing one needs its own authorized, versioned change.</p>
    </>
  );
}

