import { SectionTabs } from "@/components/SectionTabs";
import { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID } from "@/fixtures/ids";

const evidencePath = `/creators/${DEMO_CREATOR_ID}/evidence/${DEMO_EVIDENCE_ID}`;

export type AcquisitionTab = "Pipeline" | "Daily sourcing" | "Video evidence" | "Social Cat" | "TikTok Shop" | "Content monitor";

/** The acquisition section navigation shared by ACQ01, ACQ02 and ACQ03 (Figma 102:100). */
export function AcquisitionTabs({ current }: { current: AcquisitionTab }) {
  const tabs = [
    { label: "Pipeline", to: "/creators/pipeline", width: 100 },
    { label: "Daily sourcing", to: "/creators/discovery", width: 130 },
    { label: "Video evidence", to: evidencePath, width: 130 },
    { label: "Social Cat", to: "/creators/social-cat?view=dashboard", width: 102 },
    { label: "TikTok Shop", to: "/creators/tiktok?view=dashboard", width: 109 },
    { label: "Content monitor", to: "/content", width: 137 },
  ] as const;
  return <SectionTabs label="Acquisition sections" tabs={tabs.map((t) => ({ ...t, current: t.label === current }))} />;
}
