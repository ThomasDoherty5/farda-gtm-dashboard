/**
 * Recruitment fixtures (Figma sources 38:131 and 38:348) — SYNTHETIC. Handles, rates and allocations are
 * illustrative drafts, not approved terms, and nothing here is sent. Never mix them with real creators.
 */
export type Publishing = "instagram" | "tiktok";
export type QueueRoute = "inbound" | "outbound";
export type QueueRow = { id: string; handle: string; assessment: string; state: string; network: "Instagram" | "TikTok" | "Unconfirmed"; route: QueueRoute; next: { label: string; to: "assessment" | "brief" | "evidence" } };

export type RecruitmentData = {
  datasetKey: "recruitment-demo";
  filters: { networks: "both" | Publishing; route: "queue" | QueueRoute };
  /** Historical planning allocation: samples by primary publishing network. Not current stock. */
  allocation: Record<Publishing, number>;
  crossPostExtraSamples: number;
  queue: QueueRow[];
  plan: { name: string; price: string; usage: "unknown" };
  draft: { recipient: string; reference: string; version: string };
};

export const RECRUITMENT_DEFAULT = { networks: "both", route: "queue" } as const;

const rows: QueueRow[] = [
  { id: "q1", handle: "@mira.moves", assessment: "Pending", state: "Lifestyle review", network: "Instagram", route: "outbound", next: { label: "Prior content score", to: "assessment" } },
  { id: "q2", handle: "@routine.with.ella", assessment: "Pending", state: "Terms draft", network: "Instagram", route: "inbound", next: { label: "Review brief", to: "brief" } },
  { id: "q3", handle: "@claire.everyday", assessment: "Pending", state: "Commerce evidence", network: "TikTok", route: "inbound", next: { label: "Review evidence", to: "evidence" } },
  { id: "q4", handle: "@new.creator", assessment: "N/A", state: "Needs data", network: "Unconfirmed", route: "outbound", next: { label: "Research profile", to: "evidence" } },
];

export const recruitmentDemo: RecruitmentData = {
  datasetKey: "recruitment-demo",
  filters: { ...RECRUITMENT_DEFAULT },
  allocation: { instagram: 17, tiktok: 5 },
  crossPostExtraSamples: 0,
  queue: rows,
  plan: { name: "Pro, with live headroom.", price: "$299 / month", usage: "unknown" },
  draft: { recipient: "@routine.with.ella", reference: "OP-SC-DEMO-051", version: "v1" },
};

/** The demo's answer to a filtered read. A creator whose network is unconfirmed shows only when no network is chosen. */
export function filterRecruitment(filters: RecruitmentData["filters"]): RecruitmentData {
  const network = (r: QueueRow) => filters.networks === "both" || r.network.toLowerCase() === filters.networks;
  const route = (r: QueueRow) => filters.route === "queue" || r.route === filters.route;
  return { ...recruitmentDemo, filters, queue: rows.filter((r) => network(r) && route(r)) };
}

/* ---------- TikTok invitation (38:348) ---------- */

export type InvitationData = {
  datasetKey: "invitation-demo";
  /** Canonical creators the source resolves exactly. A similar handle never resolves. */
  creators: { handle: string; suppression: "clear" | "suppressed"; identity: "resolved" }[];
  products: { name: string; listing: "unverified" }[];
  program: { maxCommissionPct: number; maxValidityDays: number; label: string };
  priorScore: { model: "TT-COMMERCE-v2"; value: number };
  quota: { state: "unknown"; reasonCode: "QUOTA_NOT_READ" };
  plannedSamples: number;
  draftVersion: string;
  automateInvitations: "off";
  sampleRequest: { id: string; handle: string; nativeDeadline: string; lastRead: string };
};

export const invitationDemo: InvitationData = {
  datasetKey: "invitation-demo",
  creators: [{ handle: "@studio.rae", suppression: "clear", identity: "resolved" }],
  products: [{ name: "Farda bottle + companion app", listing: "unverified" }],
  program: { maxCommissionPct: 30, maxValidityDays: 30, label: "Illustrative program limits, to be read from the live program" },
  priorScore: { model: "TT-COMMERCE-v2", value: 86 },
  quota: { state: "unknown", reasonCode: "QUOTA_NOT_READ" },
  plannedSamples: 15,
  draftVersion: "v2",
  automateInvitations: "off",
  sampleRequest: { id: "SAMPLE-DEMO-015", handle: "@studio.rae", nativeDeadline: "29 Oct, 16:00 PT · example", lastRead: "29 Oct, 10:40 PT · example" },
};
