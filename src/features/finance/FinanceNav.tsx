import { LinkButton } from "@/components/Button";
import styles from "./Finance.module.css";

export type FinanceSection = "overview" | "economics" | "close" | "reports";
const TABS: { key: FinanceSection; label: string; to: string; width: number }[] = [
  { key: "overview", label: "Overview", to: "/finance", width: 132 },
  { key: "economics", label: "Unit economics", to: "/analytics/finance", width: 170 },
  { key: "close", label: "Month-end", to: "/finance/close/2026-10", width: 132 },
  { key: "reports", label: "Reports", to: "/finance/close/2026-10#reports", width: 132 },
];

/** Section navigation of the finance screens (Figma "Section navigation", e.g. 7:536). The current one is aria-current. */
export function FinanceNav({ current }: { current: FinanceSection }) {
  return (
    <nav aria-label="Finance sections" className={styles.pills}>
      {TABS.map((t) => <LinkButton key={t.key} to={t.to} variant={t.key === current ? "primary" : "ghost"} aria-current={t.key === current ? "page" : undefined} style={{ minWidth: `min(${t.width}px, 100%)` }}>{t.label}</LinkButton>)}
    </nav>
  );
}
