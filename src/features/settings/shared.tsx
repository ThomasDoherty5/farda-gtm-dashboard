import type { ReactNode } from "react";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Notice } from "@/components/PageKit";
import { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID } from "@/fixtures/ids";

export const evidencePath = `/creators/${DEMO_CREATOR_ID}/evidence/${DEMO_EVIDENCE_ID}`;

type NavKey = "runs" | "zaps" | "connections" | "reporting" | "reconciliation";

/** Section navigation across Automations (Figma "Workspace navigation", e.g. 14:663). These are links, so the current one uses aria-current. */
export function AutomationNav({ current, width }: { current: NavKey; width: number }) {
  const items: { key: NavKey; label: string; to: string }[] = [
    { key: "runs", label: "Agent runs", to: "/automations" },
    { key: "zaps", label: "Zaps", to: "/automations?tab=zaps" },
    { key: "connections", label: "Connections", to: "/settings/connections" },
    { key: "reporting", label: "Reporting", to: "/automations?tab=reporting" },
    { key: "reconciliation", label: "Reconciliation", to: "/automations?tab=reconciliation" },
  ];
  return (
    <nav aria-label="Automation sections" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-8)" }}>
      {items.map((i) => (
        <LinkButton key={i.key} to={i.to} variant={i.key === current ? "primary" : "ghost"} aria-current={i.key === current ? "page" : undefined} style={{ minWidth: width }}>{i.label}</LinkButton>
      ))}
    </nav>
  );
}

/** The violet box that separates daily sourcing from hourly monitoring (e.g. 109:416). Copy differs per screen. */
export function CadenceNotice({ title, children, funnel = false }: { title: string; children: ReactNode; funnel?: boolean }) {
  return (
    <Notice
      title={title}
      actionsGap={10}
      actions={
        <>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to={evidencePath} style={{ minWidth: 223.5 }}>Review lifestyle evidence</LinkButton>
          {funnel && <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>}
        </>
      }
    >
      {children}
    </Notice>
  );
}

/** A dialog for a control whose real target (a source link, a trace, evidence) the demo doesn't have. It says so and does nothing else. */
export function InfoDialog({ open, title, demo, onClose, children }: { open: boolean; title: string; demo: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog open={open} title={title} badge={demo ? "Demo" : undefined} onClose={onClose}>
      {children}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}
