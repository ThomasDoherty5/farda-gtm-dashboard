import { useScope } from "@/adapter/scope";

/** Always visible in demo. Never hidden by scroll, dismiss or route change. */
export function DemoBanner() {
  const { adapter } = useScope();
  if (adapter.environment !== "demo") return null;
  return (
    <div role="status" data-testid="demo-banner" style={{ position: "sticky", top: 0, zIndex: 5, padding: "var(--space-2) var(--space-4)", background: "var(--color-demo)", color: "var(--color-demo-text)", font: "var(--text-label)" }}>
      Demo data — synthetic records. Nothing here is sent, paid or shipped.
    </div>
  );
}
