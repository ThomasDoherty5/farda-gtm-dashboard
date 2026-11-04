import { Link } from "react-router-dom";
import styles from "./SectionTabs.module.css";

export type SectionTab = { label: string; to: string; width?: number; current?: boolean; /** Read-only: shown, not selectable. Give `reasonFor` the id of the text that says why. */ disabled?: boolean; reasonFor?: string };

/** Section navigation (Figma component set 6:424). These are links, so the current one uses aria-current. */
export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  return (
    <nav aria-label={label} className={styles.tabs}>
      {tabs.map((tab) =>
        tab.disabled ? (
          <span key={tab.label} className={`${styles.tab} ${styles.disabled}`} style={tab.width ? { minWidth: tab.width } : undefined} aria-disabled="true" aria-describedby={tab.reasonFor}>{tab.label}</span>
        ) : (
        <Link key={tab.label} to={tab.to} className={styles.tab} style={tab.width ? { minWidth: tab.width } : undefined} aria-current={tab.current ? "page" : undefined}>
          {tab.label}
        </Link>
        ),
      )}
    </nav>
  );
}
