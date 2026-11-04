import { LinkButton } from "@/components/Button";
import styles from "./Operations.module.css";

export type OpsSection = "overview" | "orders" | "shipping" | "stock" | "support";
const TABS: { key: OpsSection; label: string; to: string }[] = [
  { key: "overview", label: "Overview", to: "/operations" },
  { key: "orders", label: "Orders", to: "/operations?view=orders" },
  { key: "shipping", label: "Shipping", to: "/operations?view=shipping" },
  { key: "stock", label: "Stock", to: "/inventory" },
  { key: "support", label: "Support", to: "/support/cases/TEST-ISS-021" },
];

/** Section navigation shared by the Operations screens (Figma "Section navigation", e.g. 4:32). The current one is aria-current. */
export function OpsTabs({ current, hrefs = {} }: { current: OpsSection; hrefs?: Partial<Record<OpsSection, string>> }) {
  return (
    <nav aria-label="Operations sections" className={styles.tabs}>
      {TABS.map((t) => (
        <LinkButton key={t.key} to={hrefs[t.key] ?? t.to} variant={t.key === current ? "primary" : "ghost"} aria-current={t.key === current ? "page" : undefined}>{t.label}</LinkButton>
      ))}
    </nav>
  );
}
