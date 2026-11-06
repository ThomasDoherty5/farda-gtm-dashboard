import { z } from "zod";
import type { AgentStore, StoredAssessment } from "./store.ts";
import type { CreatorAssessment } from "./assessmentSchema.ts";

const ref = z.string().min(1).max(240);
const selection = z.array(z.object({ creatorId: ref, runId: ref }).strict()).max(25)
  .refine(rows => new Set(rows.map(row => row.creatorId)).size === rows.length, "Select each creator once.");
export const scorecardPreviewFilters = z.object({ batchId: z.literal("scorecard-preview"), selection }).strict();
export type ScorecardSelection = z.infer<typeof selection>;
const item = z.object({
  creatorId: ref, runId: ref, status: z.enum(["review", "hold", "eligible", "unavailable"]),
  route: z.enum(["website", "tiktok-shop"]).nullable(), modelId: ref.nullable(), configHash: ref.nullable(), policyVersion: ref.nullable(),
  evidenceRevision: ref.nullable(), termsRevision: ref.nullable(), sourceRef: ref.nullable(), evidencePostId: ref.nullable(),
  score: z.number().nullable(), stale: z.boolean(), reasonCodes: z.array(ref),
  acceptedOffer: z.object({ offerId: ref, version: ref, manifestHash: z.string().min(1).max(500) }).strict().nullable(),
  criteria: z.array(z.object({ id: ref, weight: z.number().positive(), rating: z.number().int().min(0).max(5).nullable() }).strict()),
}).strict();
export const scorecardPreviewSchema = z.object({
  kind: z.literal("agent-scorecard-preview"), selectedCount: z.number().int().min(0).max(25), items: z.array(item).max(25), dispatchAuthorized: z.literal(false),
}).strict().refine(d => d.selectedCount === d.items.length && new Set(d.items.map(i => i.creatorId)).size === d.items.length,
  "Preview rows must exactly match the finite selection.");
export type ScorecardPreview = z.infer<typeof scorecardPreviewSchema>;
export function readScorecardPreview(store: Pick<AgentStore,"findRun" | "latest">, members: ScorecardSelection,
  current: (stored: StoredAssessment, superseded: boolean) => { assessment: CreatorAssessment; stale: boolean }): ScorecardPreview {
  const exact = selection.parse(members);
  const items = exact.map(({creatorId, runId}): z.infer<typeof item> => {
    const stored = store.findRun(creatorId, runId);
    if (!stored) return { creatorId, runId, status: "unavailable", route: null, modelId: null, configHash: null, policyVersion: null,
      evidenceRevision: null, termsRevision: null, sourceRef: null, evidencePostId: null, score: null, stale: false,
      reasonCodes: ["EXACT_RUN_UNAVAILABLE"], acceptedOffer: null, criteria: [] };
    const superseded = store.latest(creatorId)?.runId !== runId;
    const { assessment: a, stale } = current(stored, superseded);
    const verifiedTerms = !stale && a.gates.some(g => g.id === "SOURCE:terms" && g.state === "pass") ? a.routeEvidence?.acceptedTerms : null;
    return {
      creatorId, runId, status: stale || a.state === "reviewNeeded" ? "review" : a.state === "hold" ? "hold" : "eligible",
      route: stored.packet.checkoutRoute, modelId: a.modelId, configHash: a.config.hash, policyVersion: a.policyVersion,
      evidenceRevision: a.evidenceRevision, termsRevision: a.termsRevision, sourceRef: a.routeEvidence?.sourceRef ?? null,
      evidencePostId: superseded ? null : stored.packet.posts[0]?.postId ?? null, score: a.score?.total ?? null, stale,
      reasonCodes: a.reasonCodes, acceptedOffer: verifiedTerms ? { offerId: verifiedTerms.offerId, version: verifiedTerms.version, manifestHash: verifiedTerms.manifestHash } : null,
      criteria: a.configuration?.criteria.map(c => ({ id: c.id, weight: c.weight, rating: c.rating })) ?? [],
    };
  });
  return scorecardPreviewSchema.parse({ kind: "agent-scorecard-preview", selectedCount: items.length, items, dispatchAuthorized: false });
}
export function scorecardPreviewPath(members: ScorecardSelection): string {
  const query = new URLSearchParams();
  for (const m of members) query.append("member", JSON.stringify([m.creatorId, m.runId]));
  return "/batches/scorecard-preview" + (query.size ? `?${query}` : "");
}
export function parseScorecardSelection(params: URLSearchParams): ScorecardSelection | null {
  try {
    const pairs = z.array(z.tuple([ref,ref])).max(25).parse(params.getAll("member").map(s => JSON.parse(s)));
    return selection.parse(pairs.map(([creatorId, runId]) => ({ creatorId, runId })));
  } catch { return null; }
}
