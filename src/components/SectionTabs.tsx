import { Link } from "react-router-dom";
import styles from "./SectionTabs.module.css";

export type SectionTab = { label: string; to: string; width?: number; current?: boolean; /** A gated tab. Needs `reasonId`: the id of visible text that says why it is unavailable. */ disabled?: boolean; reasonId?: string };

/** Section navigation (Figma component set 6:424). These are links, so the current one uses aria-current. */
export function SectionTabs({ label, tabs, gap }: { label: string; tabs: SectionTab[]; gap?: number }) {
  return (
    <nav aria-label={label} className={styles.tabs} style={gap ? { gap } : undefined}>
      {tabs.map((tab) =>
        tab.disabled ? (
          <button key={tab.label} type="button" className={styles.tab} style={tab.width ? { minWidth: tab.width } : undefined} aria-disabled="true" aria-describedby={tab.reasonId}>
            {tab.label}
          </button>
        ) : (
        <Link key={tab.label} to={tab.to} className={styles.tab} style={tab.width ? { minWidth: tab.width } : undefined} aria-current={tab.current ? "page" : undefined}>
          {tab.label}
        </Link>
        ),
      )}
    </nav>
  );
}
