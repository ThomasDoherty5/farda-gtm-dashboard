import { Notice } from "@/components/Panels";
import type { BasisFields, ReadinessBasis } from "@/fixtures/scorecards";

export type BasisPart = keyof ReadinessBasis;
const PARTS: BasisPart[] = ["media", "terms", "policy"];
const LABEL: Record<BasisPart, string> = { media: "media", terms: "accepted terms", policy: "policy" };

/** Which parts of what an assessment was made against have changed since. Unknown basis is not "unchanged": readiness is not claimed. */
export function changedBasis(r: BasisFields): { known: boolean; changed: BasisPart[] } {
  if (!r.assessedBasis || !r.currentBasis) return { known: false, changed: [] };
  return { known: true, changed: PARTS.filter((p) => r.assessedBasis![p] !== r.currentBasis![p]) };
}

export const invalidationText = (changed: BasisPart[]) => `Readiness invalidated: ${changed.map((c) => LABEL[c]).join(", ")} changed since this was assessed`;

/** Renders only when something changed, so an unchanged snapshot keeps its design layout. */
export function ReadinessNote({ record }: { record: BasisFields }) {
  const { changed } = changedBasis(record);
  if (!changed.length) return null;
  return (
    <Notice tone="warning" label="Invalidated" title={invalidationText(changed)} role="status" testId="readiness-invalidated">
      The earlier assessment cannot support an invitation or approval for the changed {changed.map((c) => LABEL[c]).join(" and ")}. Reassess against the current basis; this snapshot stays as it was.
    </Notice>
  );
}
