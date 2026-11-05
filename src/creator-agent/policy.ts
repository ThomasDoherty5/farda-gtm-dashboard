import { creatorAssessmentSchema, POLICY_VERSION, AGENT_VERSION, AGENT_SCHEMA_VERSION } from "./assessmentSchema.ts";
import type { CreatorAssessment } from "./assessmentSchema.ts";
import { deriveCommentStats, deriveMetadataBaseline } from "./evidence.ts";
import type { EvidencePacket, PostEvidence } from "./evidence.ts";
import type { ConfigBinding } from "./config.ts";
import { scoreOf } from "../features/scorecards/scorecardMath.ts";

export const MODEL_FOR_ROUTE = { website: "WEBSITE-AFFILIATE-v3", "tiktok-shop": "TIKTOK-SHOP-AFFILIATE-v3" } as const;
export function likeGate(post: PostEvidence): "pass" | "fail" | "unknown" {
  return post.nativeLikes.status !== "known" || !post.nativeLikes.exact ? "unknown" : post.nativeLikes.value > 200 ? "pass" : "fail";
}
function secondsOf(intervals: { startSec: number; endSec: number }[]): number {
  let end = 0, total = 0;
  for (const span of [...intervals].sort((a, b) => a.startSec - b.startSec)) {
    total += Math.max(0, span.endSec - Math.max(end, span.startSec));
    end = Math.max(end, span.endSec);
  }
  return total;
}

/** Deterministic J02 decision over authenticated, source-linked reviewed evidence. No guessed metrics or replacement weights. */
export function assessCreator(packet: EvidencePacket, binding: ConfigBinding | null): CreatorAssessment {
  const modelId = MODEL_FOR_ROUTE[packet.checkoutRoute];
  if (binding && binding.current.modelId !== modelId) throw new Error("WRONG_ROUTE_MODEL");
  const gates: CreatorAssessment["gates"] = [];
  const add = (id: string, state: "pass" | "fail" | "unknown", reason: string) => gates.push({ id, state, reason });
  // Cross-posts/reuploads cannot turn one demonstrated action into repeated evidence.
  const independent = new Map<string, PostEvidence>();
  for (const p of packet.posts) {
    if (p.relevant && likeGate(p) === "pass" && p.review.status === "complete" && p.publishedAt) {
      const existing = independent.get(p.canonicalMediaId);
      if (!existing || p.publishedAt < (existing.publishedAt ?? "")) independent.set(p.canonicalMediaId, p);
    }
  }
  const posts = [...independent.values()];
  const dates = new Set(posts.map((p) => new Date(p.publishedAt!).toISOString().slice(0, 10)));
  const usePosts = posts.filter((p) => packet.posts.some((related) => related.canonicalMediaId === p.canonicalMediaId && related.relevant && likeGate(related) === "pass" && related.review.status === "complete" && related.publishedAt && related.review.observedActions.some((a) => a.meaningfulUse)));
  add("QUALIFYING_POSTS", posts.length >= 3 ? "pass" : "unknown", `${posts.length}/3 independent relevant complete posts with exact native likes >200`);
  add("PUBLICATION_DATES", dates.size >= 2 ? "pass" : "unknown", `${dates.size}/2 publication dates`);
  add("MEANINGFUL_USE", usePosts.length >= 2 ? "pass" : "unknown", `${usePosts.length}/2 on-brief action/use examples`);
  for (const key of ["routine", "demo"] as const) {
    const rating = packet.ratings[key];
    add(key === "routine" ? "ROUTINE_FLOOR" : "DEMO_FLOOR", rating === null ? "unknown" : rating >= 3 ? "pass" : "fail", rating === null ? "Required criterion evidence is unknown" : `Verified rating ${rating}/5; minimum 3/5`);
  }
  const contentGates = [...gates];
  const contentQualification = contentGates.some((g) => g.state === "fail") ? "hold" : contentGates.some((g) => g.state === "unknown") ? "reviewNeeded" : "pass";
  add("CONFIG_BOUND", binding ? "pass" : "unknown", binding ? "Immutable current/baseline numeric configuration verified" : "No approved immutable numeric baseline is bound; historical fixtures are not a fallback");
  const requireGates = (required: string[], supplied: EvidencePacket["invitationGates"], prefix: string) => {
    for (const id of required) {
      const g = supplied.find((x) => x.id === id);
      add(`${prefix}:${id}`, !g || !g.sourceRef ? "unknown" : g.status, g?.sourceRef ? `${g.status}; source ${g.sourceRef}` : "Required stage evidence is unknown");
    }
  };
  requireGates(["identity", "sourcePermission", "suppression", "supportedBrief"], packet.invitationGates, "INVITE");
  const inviteGates = [...gates];
  requireGates(["audience", "terms", "programEligibility", "attribution", "supportedClaims", ...(packet.checkoutRoute === "tiktok-shop" ? ["nativeShopEligibility"] : ["websiteProgramEligibility"])], packet.activationGates, "ACTIVATE");
  let state: CreatorAssessment["state"];
  if (inviteGates.some((g) => g.state === "fail")) state = "hold";
  else if (inviteGates.some((g) => g.state === "unknown")) state = "reviewNeeded";
  else state = gates.every((g) => g.state === "pass") ? "activationReady" : "prospectiveInviteEligible";
  const baseline = deriveMetadataBaseline(packet.recentPosts);
  const comments = packet.posts.map((p) => {
    const s = deriveCommentStats(p.comments);
    return { postId: p.postId, status: s.status, rowCount: s.observedRows, uniqueAuthors: s.uniqueAuthors, unknownAuthorRows: s.unknownAuthorRows, promptedRows: s.promptedRows, creatorRows: s.creatorRows, promotionalRows: s.promotionalRows, categoryCounts: s.categoryCounts, ordering: s.ordering, reason: s.reason };
  });
  let score: CreatorAssessment["score"] = null;
  if (binding) {
    const c = binding.current;
    const rows = c.criteria.map((criterion) => ({ ...criterion, rating: criterion.id === c.routineCriterionId ? packet.ratings.routine : criterion.id === c.demoCriterionId ? packet.ratings.demo : packet.criterionRatings[criterion.id] ?? null }));
    const numeric = scoreOf(rows);
    score = { earned: numeric.earned, max: numeric.max, total: numeric.total, unknownCount: numeric.unknownCount, band: numeric.total === null ? null : [...c.bands].sort((a, b) => b.min - a.min).find((b) => numeric.total! >= b.min)?.id ?? null };
  }
  // Numeric readiness is governed only by explicit bound rules, never guessed from a band's label.
  const rules = binding?.current.decisionRules;
  const rowsForCoverage = binding?.current.criteria.map((c) => ({ weight: c.weight, rating: c.id === binding.current.routineCriterionId ? packet.ratings.routine : c.id === binding.current.demoCriterionId ? packet.ratings.demo : packet.criterionRatings[c.id] ?? null })) ?? [];
  const coverage = rowsForCoverage.reduce((sum, c) => sum + (c.rating === null ? 0 : c.weight), 0);
  if (!rules) {
    add("DECISION_RULES_BOUND", "unknown", "No approved numeric stage/coverage decision rules are bound");
    if (state !== "hold") state = "reviewNeeded";
  } else {
    const inviteNumeric = coverage >= rules.minCoveragePct && (rules.invitationMinScore === null || (score?.total !== null && score?.total !== undefined && score.total >= rules.invitationMinScore));
    add("INVITE_NUMERIC_RULES", inviteNumeric ? "pass" : "unknown", "Bound invitation score/coverage rules; missing criteria never rescale");
    if (!inviteNumeric && state !== "hold") state = "reviewNeeded";
    if (state === "activationReady" && (score?.total === null || score?.total === undefined || score.total < rules.activationMinScore)) {
      add("ACTIVATION_NUMERIC_RULES", "unknown", "Complete bound score and activation threshold are required");
      state = "prospectiveInviteEligible";
    }
  }
  return creatorAssessmentSchema.parse({
    schemaVersion: AGENT_SCHEMA_VERSION, policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION,
    creatorId: packet.creatorId, briefId: packet.briefId, evidenceRevision: packet.evidenceRevision, termsRevision: packet.termsRevision, modelId,
    config: { status: binding ? "bound" : "unbound", version: binding?.current.version ?? null, hash: binding?.hash ?? null, baselineHash: binding?.baselineHash ?? null, numericHash: binding?.numericHash ?? null },
    configuration: binding ? { criteria: binding.current.criteria.map((c) => ({ ...c, rating: c.id === binding.current.routineCriterionId ? packet.ratings.routine : c.id === binding.current.demoCriterionId ? packet.ratings.demo : packet.criterionRatings[c.id] ?? null })), bands: binding.current.bands, arithmetic: binding.current.arithmetic } : null,
    state, contentQualification, gates, packet: { qualifyingPosts: posts.length, publicationDates: dates.size, meaningfulUsePosts: usePosts.length, postIds: posts.map((p) => p.postId) }, criteria: packet.ratings, score,
    metadata: { sampleSize: baseline.selected.length, coverage: baseline.coverage, reasonCodes: baseline.coverageReasons, postIds: baseline.selected.map((p) => p.postId), medianViews: baseline.viewStats.median, minViews: baseline.viewStats.min, maxViews: baseline.viewStats.max, comparableViewCount: baseline.viewStats.knownCount },
    comments, reviews: packet.posts.map((p) => ({ postId: p.postId, status: p.review.status, visualMethod: p.review.visualMethod, audioMethod: p.review.audioMethod, sampledPointCount: p.review.sampledPoints.length, continuousSeconds: secondsOf(p.review.watchedIntervals), likeGate: likeGate(p) })),
    reasonCodes: gates.filter((g) => g.state !== "pass").map((g) => g.id),
  });
}
