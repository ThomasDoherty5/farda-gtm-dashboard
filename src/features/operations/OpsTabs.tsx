import { useLocation } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import { LinkButton } from "@/components/Button";
import styles from "./Operations.module.css";

export type OpsSection = "hub" | "overview" | "orders" | "shipping" | "stock" | "support";
const TABS: { key: OpsSection; label: string; to: string }[] = [
  { key: "overview", label: "Overview", to: "/operations" },
  { key: "orders", label: "Orders", to: "/operations?view=orders" },
  { key: "shipping", label: "Shipping", to: "/operations?view=shipping" },
  { key: "stock", label: "Stock", to: "/inventory" },
  { key: "support", label: "Support", to: "/support/cases/TEST-ISS-021" },
  { key: "hub", label: "Shipping hub", to: "/operations?view=hub" },
];

/** Section navigation shared by the Operations screens (Figma "Section navigation", e.g. 4:32). The current one is aria-current. */
export function OpsTabs({ current, hrefs = {}, includeHub = true }: { current: OpsSection; hrefs?: Partial<Record<OpsSection, string>>; includeHub?: boolean }) {
  const location = useLocation();
  const native = useScope().scope.environment !== "demo";
  return (
    <nav aria-label="Operations sections" className={styles.tabs}>
      {TABS.filter(t => includeHub || t.key !== "hub").map((t) => (
        <LinkButton key={t.key} to={t.key === current ? location.pathname + location.search + location.hash : hrefs[t.key] ?? (native && t.key === "support" ? "/support/cases/queue" : t.to)} onClick={t.key === current ? event => event.preventDefault() : undefined} variant={t.key === current ? "primary" : "ghost"} aria-current={t.key === current ? "page" : undefined}>{t.label}</LinkButton>
      ))}
    </nav>
  );
}
