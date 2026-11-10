import { z } from "zod";
import type { FreshnessState } from "../adapter/contract.ts";

/**
 * Mirror freshness (THO-254 family). Pure and client-safe: no Node, provider or storage imports, so the server read, the
 * dashboard badge and the source-health detail all derive a mirror's state from `classifyMirrorFreshness`.
 *
 * Freshness comes from complete-run coverage plus a coverage watermark, never from the newest row in a mirror:
 *  - a run reports its outcome. Only a `complete` run proves that every source change up to its `coverageWatermark`
 *    (a source as-of time) is mirrored. Partial, failed and revoked runs never advance the watermark;
 *  - age is `now - coverageWatermark` of the latest complete run. A complete run that found nothing new still advances
 *    the watermark, so a quiet source is current ("no change"), not stale;
 *  - a run record has no "newest row" field at all, and the strict schema rejects one.
 *
 * The states extend D-13 (`FreshnessState` in the adapter contract) with `stale`, `accessRevoked` and `unknown`.
 * Unknown is never zero, current or healthy.
 */

export const MIRROR_IDS = ["orders", "shipments", "stock", "support", "finance", "content", "collaborations"] as const;
export type MirrorId = (typeof MIRROR_IDS)[number];
/** Provider names as `operationsControls.ts` registers them. */
export const MIRROR_PROVIDERS = ["google-sheets", "quickbooks", "notion"] as const;
export type MirrorProvider = (typeof MIRROR_PROVIDERS)[number];

export const MIRROR_FRESHNESS_STATES = ["current", "noChange", "stale", "partial", "error", "neverSynced", "accessRevoked", "unknown"] as const;
export type MirrorFreshnessState = FreshnessState | "stale" | "accessRevoked" | "unknown";
// Compile-time proof that the list above and the D-13 extension are the same set.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statesMatch: Same<(typeof MIRROR_FRESHNESS_STATES)[number], MirrorFreshnessState> = true;
void statesMatch;

/** States that may be read as current. Every other state, unknown included, is unhealthy for alerting and badges. */
export const HEALTHY_MIRROR_STATES: readonly MirrorFreshnessState[] = ["current", "noChange"];

const instant = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), "Invalid timestamp.");
/** Opaque references only: no "@", spaces or URLs, so an email address or a name cannot pass as an identifier. */
export const mirrorRefSchema = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const mirrorReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const count = z.number().int().nonnegative().safe();
const minutes = (max: number) => z.number().int().min(1).max(max);

/* ---------- Configuration (AC1) ---------- */

/**
 * PROPOSED DEFAULTS, NOT OWNER-APPROVED. Sheets-backed mirrors go stale after 1 hour and the QuickBooks ledger after
 * 26 hours. The health check runs every 15 minutes. The Notion content and collaboration registries have no proposed
 * threshold, so they stay `unknown` until an owner configures one. Override per mirror through `resolveMirrorPolicies`.
 */
export const PROPOSED_DEFAULT_MIRROR_POLICIES: Readonly<Record<MirrorId, { label: string; provider: MirrorProvider; checkEveryMinutes: number; staleAfterMinutes: number | null }>> = {
  orders: { label: "Orders", provider: "google-sheets", checkEveryMinutes: 15, staleAfterMinutes: 60 },
  shipments: { label: "Shipments", provider: "google-sheets", checkEveryMinutes: 15, staleAfterMinutes: 60 },
  stock: { label: "Stock", provider: "google-sheets", checkEveryMinutes: 15, staleAfterMinutes: 60 },
  support: { label: "Support", provider: "google-sheets", checkEveryMinutes: 15, staleAfterMinutes: 60 },
  finance: { label: "Finance", provider: "quickbooks", checkEveryMinutes: 15, staleAfterMinutes: 26 * 60 },
  content: { label: "Content registry", provider: "notion", checkEveryMinutes: 15, staleAfterMinutes: null },
  collaborations: { label: "Collaboration registry", provider: "notion", checkEveryMinutes: 15, staleAfterMinutes: null },
};

export type MirrorPolicy = {
  mirrorId: MirrorId; label: string; provider: MirrorProvider;
  checkEveryMinutes: number; staleAfterMinutes: number | null;
  /** Where the numbers came from. `proposed-default` values are not owner-approved. */
  basis: "proposed-default" | "configured";
  /** False when the server has no mirror-freshness source configured. Every state is then `unknown`. */
  sourceConfigured: boolean;
};

export const mirrorPolicyOverrideSchema = z.object({
  checkEveryMinutes: minutes(1_440).optional(),
  staleAfterMinutes: minutes(43_200).nullable().optional(),
}).strict();
export const mirrorPolicyOverridesSchema = z.object(Object.fromEntries(MIRROR_IDS.map(id => [id, mirrorPolicyOverrideSchema.optional()])) as Record<MirrorId, z.ZodOptional<typeof mirrorPolicyOverrideSchema>>).strict();
export type MirrorPolicyOverrides = z.input<typeof mirrorPolicyOverridesSchema>;

export class MirrorPolicyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** Proposed defaults plus owner overrides. A check that runs less often than the threshold could miss a stale window, so it is refused. */
export function resolveMirrorPolicies(overrides: MirrorPolicyOverrides = {}, sourceConfigured = true): Record<MirrorId, MirrorPolicy> {
  const parsed = mirrorPolicyOverridesSchema.safeParse(overrides);
  if (!parsed.success) throw new MirrorPolicyError("INVALID_MIRROR_POLICY");
  return Object.fromEntries(MIRROR_IDS.map(mirrorId => {
    const base = PROPOSED_DEFAULT_MIRROR_POLICIES[mirrorId], override = parsed.data[mirrorId] ?? {};
    const policy: MirrorPolicy = { mirrorId, label: base.label, provider: base.provider,
      checkEveryMinutes: override.checkEveryMinutes ?? base.checkEveryMinutes,
      staleAfterMinutes: override.staleAfterMinutes === undefined ? base.staleAfterMinutes : override.staleAfterMinutes,
      basis: Object.keys(override).length ? "configured" : "proposed-default", sourceConfigured };
    if (policy.staleAfterMinutes !== null && policy.checkEveryMinutes > policy.staleAfterMinutes) throw new MirrorPolicyError("MIRROR_CHECK_SLOWER_THAN_THRESHOLD");
    return [mirrorId, policy];
  })) as Record<MirrorId, MirrorPolicy>;
}

/* ---------- Run records (AC2) ---------- */

export const MIRROR_RUN_OUTCOMES = ["complete", "partial", "failed", "accessRevoked"] as const;
/**
 * One finished sync run. Identifiers, times, counts and a reason code only: the strict schema rejects row contents,
 * names, emails, URLs and any "newest row" timestamp.
 */
export const mirrorRunSchema = z.object({
  runId: mirrorRefSchema,
  mirrorId: z.enum(MIRROR_IDS),
  startedAt: instant,
  finishedAt: instant,
  outcome: z.enum(MIRROR_RUN_OUTCOMES),
  /** Source as-of time through which this complete run proved coverage. Null for every other outcome. */
  coverageWatermark: instant.nullable(),
  counts: z.object({ rowsRead: count.nullable(), rowsChanged: count.nullable(), rowsExpected: count.nullable() }).strict(),
  reasonCode: mirrorReasonCodeSchema.nullable(),
}).strict().superRefine((run, ctx) => {
  const started = Date.parse(run.startedAt), finished = Date.parse(run.finishedAt);
  if (finished < started) ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "A run cannot finish before it starts." });
  if (run.outcome === "complete") {
    if (run.coverageWatermark === null) ctx.addIssue({ code: "custom", path: ["coverageWatermark"], message: "A complete run carries its coverage watermark." });
    else if (Date.parse(run.coverageWatermark) > finished) ctx.addIssue({ code: "custom", path: ["coverageWatermark"], message: "Coverage cannot extend past the run." });
    if (run.counts.rowsChanged === null) ctx.addIssue({ code: "custom", path: ["counts", "rowsChanged"], message: "A complete run knows how many rows changed." });
    if (run.counts.rowsExpected !== null && run.counts.rowsRead !== null && run.counts.rowsRead < run.counts.rowsExpected)
      ctx.addIssue({ code: "custom", path: ["counts"], message: "A run that read fewer rows than expected is partial." });
  } else if (run.coverageWatermark !== null) ctx.addIssue({ code: "custom", path: ["coverageWatermark"], message: "Only a complete run advances the watermark." });
});
export type MirrorRun = z.infer<typeof mirrorRunSchema>;

/** What classification reads: the latest finished run and the latest complete run. Both are public (ids, times, counts). */
export type MirrorFreshnessEvidence = {
  latestRun: { runId: string; outcome: MirrorRun["outcome"]; finishedAt: string; reasonCode: string | null; counts: MirrorRun["counts"] } | null;
  lastComplete: { runId: string; finishedAt: string; coverageWatermark: string; rowsChanged: number } | null;
};

export function evidenceFrom(latest: MirrorRun | null, lastComplete: MirrorRun | null): MirrorFreshnessEvidence {
  return {
    latestRun: latest ? { runId: latest.runId, outcome: latest.outcome, finishedAt: latest.finishedAt, reasonCode: latest.reasonCode, counts: latest.counts } : null,
    lastComplete: lastComplete && lastComplete.coverageWatermark !== null && lastComplete.counts.rowsChanged !== null
      ? { runId: lastComplete.runId, finishedAt: lastComplete.finishedAt, coverageWatermark: lastComplete.coverageWatermark, rowsChanged: lastComplete.counts.rowsChanged } : null,
  };
}

/* ---------- Classification (AC2, AC3) ---------- */

export type MirrorClassification = { state: MirrorFreshnessState; reasonCodes: string[]; ageMinutes: number | null; valuesAreCurrent: boolean };

const parse = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);

/**
 * The one function every surface uses. Precedence: unknown (no source, bad evidence) > never synced > access revoked >
 * failed (`error`) > partial > unknown (no threshold) > stale > no change > current. Every applicable reason is listed.
 */
export function classifyMirrorFreshness(policy: MirrorPolicy, evidence: MirrorFreshnessEvidence, at: number): MirrorClassification {
  const result = (state: MirrorFreshnessState, reasonCodes: string[], ageMinutes: number | null = null): MirrorClassification =>
    ({ state, reasonCodes: [...new Set(reasonCodes)], ageMinutes, valuesAreCurrent: HEALTHY_MIRROR_STATES.includes(state) });
  if (!policy.sourceConfigured) return result("unknown", ["MIRROR_FRESHNESS_NOT_CONFIGURED"]);
  const { latestRun, lastComplete } = evidence;
  const latestAt = parse(latestRun?.finishedAt), completeAt = parse(lastComplete?.finishedAt), watermark = parse(lastComplete?.coverageWatermark);
  const valid = Number.isSafeInteger(at) && at >= 0
    && (!latestRun || (Number.isFinite(latestAt) && latestAt <= at))
    && (!lastComplete || (!!latestRun && Number.isFinite(completeAt) && Number.isFinite(watermark) && watermark <= completeAt && completeAt <= latestAt))
    && (latestRun?.outcome !== "complete" || lastComplete?.runId === latestRun.runId);
  if (!valid) return result("unknown", ["INVALID_FRESHNESS_EVIDENCE"]);
  if (!latestRun) return result("neverSynced", ["MIRROR_NEVER_SYNCED"]);
  const ageMinutes = lastComplete ? Math.floor((at - watermark) / 60_000) : null;
  const overThreshold = ageMinutes !== null && policy.staleAfterMinutes !== null && ageMinutes > policy.staleAfterMinutes;
  const background = [...(lastComplete ? [] : ["MIRROR_NO_COMPLETE_RUN"]), ...(overThreshold ? ["MIRROR_STALE"] : []),
    ...(latestRun.reasonCode ? [latestRun.reasonCode] : [])];
  if (latestRun.outcome === "accessRevoked") return result("accessRevoked", ["MIRROR_ACCESS_REVOKED", ...background], ageMinutes);
  if (latestRun.outcome === "failed") return result("error", ["MIRROR_SYNC_FAILED", ...background], ageMinutes);
  if (latestRun.outcome === "partial") return result("partial", ["MIRROR_COVERAGE_PARTIAL", ...background], ageMinutes);
  if (policy.staleAfterMinutes === null) return result("unknown", ["MIRROR_THRESHOLD_NOT_CONFIGURED"], ageMinutes);
  if (overThreshold) return result("stale", ["MIRROR_STALE"], ageMinutes);
  return lastComplete!.rowsChanged === 0 ? result("noChange", ["MIRROR_NO_CHANGE"], ageMinutes) : result("current", [], ageMinutes);
}

/* ---------- The public summary and the surfaces that read it (AC7) ---------- */

export type MirrorFreshnessSummary = {
  mirrorId: MirrorId; label: string; provider: MirrorProvider;
  state: MirrorFreshnessState; reasonCodes: string[]; valuesAreCurrent: boolean; ageMinutes: number | null;
  checkedAt: string;
  policy: Pick<MirrorPolicy, "checkEveryMinutes" | "staleAfterMinutes" | "basis" | "sourceConfigured">;
  evidence: MirrorFreshnessEvidence;
};

export function summarizeMirrorFreshness(policy: MirrorPolicy, evidence: MirrorFreshnessEvidence, at: number): MirrorFreshnessSummary {
  const c = classifyMirrorFreshness(policy, evidence, at);
  return { mirrorId: policy.mirrorId, label: policy.label, provider: policy.provider, ...c,
    checkedAt: new Date(Number.isSafeInteger(at) && at >= 0 ? at : 0).toISOString(),
    policy: { checkEveryMinutes: policy.checkEveryMinutes, staleAfterMinutes: policy.staleAfterMinutes, basis: policy.basis, sourceConfigured: policy.sourceConfigured },
    evidence };
}

/**
 * Re-derives a summary's state from its own evidence at its own `checkedAt`, never the viewer's clock. A summary whose
 * stated state disagrees with its evidence is `unknown`. The badge and the detail both read through this.
 */
export function mirrorFreshnessStateOf(summary: MirrorFreshnessSummary | null | undefined): MirrorFreshnessState {
  if (!summary || !(MIRROR_IDS as readonly string[]).includes(summary.mirrorId)) return "unknown";
  const base = PROPOSED_DEFAULT_MIRROR_POLICIES[summary.mirrorId];
  const derived = classifyMirrorFreshness({ ...summary.policy, mirrorId: summary.mirrorId, label: base.label, provider: base.provider },
    summary.evidence, Date.parse(summary.checkedAt)).state;
  return derived === summary.state ? derived : "unknown";
}

export type MirrorFreshnessTone = "success" | "neutral" | "warning" | "danger";
export type MirrorFreshnessWords = { label: string; tone: MirrorFreshnessTone; meaning: string; valuesAreCurrent: boolean };

/** Same words as the analytics freshness vocabulary where the states overlap (see the parity test). */
export const MIRROR_FRESHNESS_WORDS: Record<MirrorFreshnessState, MirrorFreshnessWords> = {
  current: { label: "Current", tone: "success", meaning: "A complete sync covered the source within the freshness window.", valuesAreCurrent: true },
  noChange: { label: "No change", tone: "success", meaning: "The last sync succeeded and found nothing new. The values are current, not stale.", valuesAreCurrent: true },
  stale: { label: "Stale", tone: "warning", meaning: "The last good sync is older than the freshness window. Values are from then, not now.", valuesAreCurrent: false },
  partial: { label: "Partial", tone: "warning", meaning: "Some rows did not arrive. Totals cover only the rows observed.", valuesAreCurrent: false },
  error: { label: "Error", tone: "danger", meaning: "The last sync failed. Values shown are the last good ones, not current.", valuesAreCurrent: false },
  neverSynced: { label: "Never synced", tone: "neutral", meaning: "No sync has succeeded yet. Its metrics are N/A, not zero.", valuesAreCurrent: false },
  accessRevoked: { label: "Access revoked", tone: "danger", meaning: "The mirror can no longer read its source. Values shown are the last good ones, not current.", valuesAreCurrent: false },
  unknown: { label: "Unknown", tone: "neutral", meaning: "Freshness cannot be established. Treat values as unverified, not current and not zero.", valuesAreCurrent: false },
};

/** The dashboard freshness badge. */
export function mirrorFreshnessBadge(summary: MirrorFreshnessSummary | null | undefined) {
  const state = mirrorFreshnessStateOf(summary), words = MIRROR_FRESHNESS_WORDS[state];
  return { state, label: words.label, tone: words.tone };
}

/** The source-health detail. */
export function mirrorFreshnessDetail(summary: MirrorFreshnessSummary | null | undefined) {
  const state = mirrorFreshnessStateOf(summary), words = MIRROR_FRESHNESS_WORDS[state];
  const trusted = !!summary && state === summary.state;
  return { state, ...words, reasonCodes: trusted ? summary.reasonCodes : ["MIRROR_STATE_UNVERIFIED"],
    lastCompleteRunAt: trusted ? summary.evidence.lastComplete?.finishedAt ?? null : null,
    coverageWatermark: trusted ? summary.evidence.lastComplete?.coverageWatermark ?? null : null,
    ageMinutes: trusted ? summary.ageMinutes : null, staleAfterMinutes: summary?.policy.staleAfterMinutes ?? null,
    thresholdBasis: summary?.policy.basis ?? null };
}

/**
 * D-13 projection for a `sourceFreshness` entry. D-13 has no stale or revoked state, so both become `error` with a reason
 * code, as `freshnessStateOf` documents. Unknown has no D-13 verdict, so it projects to null and the client shows none.
 */
export function toD13SourceFreshness(summary: MirrorFreshnessSummary): { freshnessState: FreshnessState; staleReasonCode: string | null; lastSourceSuccessAt: string | null } | null {
  const state = mirrorFreshnessStateOf(summary);
  const lastSourceSuccessAt = summary.evidence.lastComplete?.coverageWatermark ?? null;
  switch (state) {
    case "unknown": return null;
    case "stale": return { freshnessState: "error", staleReasonCode: "MIRROR_STALE", lastSourceSuccessAt };
    case "accessRevoked": return { freshnessState: "error", staleReasonCode: "MIRROR_ACCESS_REVOKED", lastSourceSuccessAt };
    case "error": return { freshnessState: "error", staleReasonCode: "MIRROR_SYNC_FAILED", lastSourceSuccessAt };
    case "partial": return { freshnessState: "partial", staleReasonCode: "MIRROR_COVERAGE_PARTIAL", lastSourceSuccessAt };
    default: return { freshnessState: state, staleReasonCode: null, lastSourceSuccessAt };
  }
}

/* ---------- Incidents (AC5, AC6) ---------- */

export const MIRROR_INCIDENT_STATES = ["stale", "partial", "error", "neverSynced", "accessRevoked", "unknown"] as const;
export type MirrorIncidentState = (typeof MIRROR_INCIDENT_STATES)[number];

/** An unhealthy state raises an incident, except an unknown that only reflects missing owner configuration. */
export function incidentStateOf(summary: MirrorFreshnessSummary): MirrorIncidentState | null {
  if (HEALTHY_MIRROR_STATES.includes(summary.state)) return null;
  if (summary.state === "unknown" && summary.reasonCodes.every(code => code === "MIRROR_FRESHNESS_NOT_CONFIGURED" || code === "MIRROR_THRESHOLD_NOT_CONFIGURED")) return null;
  return summary.state as MirrorIncidentState;
}

export type OpenMirrorIncident = { incidentId: string; mirrorId: MirrorId; state: MirrorIncidentState; openedAfterRunSequence: number };
export type MirrorIncidentPlan = { open: MirrorIncidentState | null; suppress: string[]; clear: string[] };

/**
 * One mirror, one check. A repeat of an open (mirror, state) incident is suppressed. An incident clears only when this
 * check is healthy and rests on a complete run recorded after the incident opened; anything else leaves it open.
 */
export function planMirrorIncidents(summary: MirrorFreshnessSummary, open: readonly OpenMirrorIncident[], lastCompleteRunSequence: number | null): MirrorIncidentPlan {
  const mine = open.filter(incident => incident.mirrorId === summary.mirrorId);
  if (HEALTHY_MIRROR_STATES.includes(summary.state) && mirrorFreshnessStateOf(summary) === summary.state) {
    return { open: null, suppress: [], clear: lastCompleteRunSequence === null ? []
      : mine.filter(incident => lastCompleteRunSequence > incident.openedAfterRunSequence).map(incident => incident.incidentId) };
  }
  const state = incidentStateOf(summary);
  if (!state) return { open: null, suppress: [], clear: [] };
  const repeat = mine.filter(incident => incident.state === state).map(incident => incident.incidentId);
  return repeat.length ? { open: null, suppress: repeat, clear: [] } : { open: state, suppress: [], clear: [] };
}

/** The alert body. IDs, counts, times and reason codes only; the strict schema refuses anything else. */
export const mirrorIncidentPayloadSchema = z.object({
  schemaVersion: z.literal("mirror-freshness-incident.v1"),
  event: z.enum(["opened", "suppressed", "cleared"]),
  incidentId: z.string().regex(/^mfi-[a-f0-9]{32}$/),
  mirrorId: z.enum(MIRROR_IDS),
  provider: z.enum(MIRROR_PROVIDERS),
  state: z.enum(MIRROR_INCIDENT_STATES),
  reasonCodes: z.array(mirrorReasonCodeSchema).max(12),
  openedAt: instant,
  lastSeenAt: instant,
  clearedAt: instant.nullable(),
  occurrences: count.min(1),
  latestRunId: mirrorRefSchema.nullable(),
  clearedByRunId: mirrorRefSchema.nullable(),
  ageMinutes: count.nullable(),
  staleAfterMinutes: count.nullable(),
  counts: z.object({ rowsRead: count.nullable(), rowsChanged: count.nullable(), rowsExpected: count.nullable() }).strict().nullable(),
}).strict();
export type MirrorIncidentPayload = z.infer<typeof mirrorIncidentPayloadSchema>;
