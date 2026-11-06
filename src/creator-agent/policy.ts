import { creatorAssessmentSchema, POLICY_VERSION, AGENT_VERSION, AGENT_SCHEMA_VERSION } from "./assessmentSchema.ts";
import type { CreatorAssessment } from "./assessmentSchema.ts";
import { deriveCommentStats, deriveMetadataBaseline } from "./evidence.ts";
import type { EvidencePacket, PostEvidence } from "./evidence.ts";
import type { ConfigBinding, ModelConfig } from "./config.ts";
import { anchorFor } from "./ratingPolicy.ts";
import { criterionSource, sourceGates, type ScorecardProof } from "./routeEvidence.ts";
import { scoreOf } from "../features/scorecards/scorecardMath.ts";

export const MODEL_FOR_ROUTE = { website: "WEBSITE-AFFILIATE-v3", "tiktok-shop": "TIKTOK-SHOP-AFFILIATE-v3" } as const;
export function likeGate(post: PostEvidence): "pass" | "fail" | "unknown" {
  return post.nativeLikes.status !== "known" || !post.nativeLikes.exact ? "unknown" : post.nativeLikes.value > 200 ? "pass" : "fail";
}
/** Critical ratings use the reviewed post packet; every other numeric rating needs its own source proof. */
function creativeRating(packet: EvidencePacket, key: "routine" | "demo") {
  const reviewed = packet.posts.some(post => post.relevant && post.publishedAt && likeGate(post) === "pass" && post.review.status === "complete" && post.review.sourceRef);
  return reviewed ? packet.ratings[key] : null;
}
export function configuredRating(packet: EvidencePacket, config: ModelConfig, criterionId: string, proof?: ScorecardProof): number | null {
  if (criterionId === config.routineCriterionId) return creativeRating(packet, "routine");
  if (criterionId === config.demoCriterionId) return creativeRating(packet, "demo");
  const refs = packet.criterionEvidenceRefs?.[criterionId];
  if (!refs?.length || refs.some((ref) => !ref.trim())) return null;
  if (["verifiedCommerce", "audienceAlignment", "reliability", "offerEconomics"].includes(criterionId)) {
    const trustedRefs = criterionSource(proof?.snapshot, criterionId);
    if (proof?.snapshot?.criteria.find(c => c.id === criterionId)?.rating !== packet.criterionRatings[criterionId] || !trustedRefs?.length || !trustedRefs.every(ref => refs.includes(ref)) || refs.some(ref => !trustedRefs.includes(ref))) return null;
  }
  return packet.criterionRatings[criterionId] ?? null;
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
export function assessCreator(packet: EvidencePacket, binding: ConfigBinding | null, proof?: ScorecardProof): CreatorAssessment {
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
    const rating = creativeRating(packet, key);
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
  const providerGates = sourceGates(packet, proof);
  gates.push(...providerGates);
  let state: CreatorAssessment["state"];
  // Unknown provider facts permit public sourcing. An explicit ineligibility for this checkout route blocks its invitation.
  if (inviteGates.some((g) => g.state === "fail") || providerGates.some(g => g.id === "SOURCE:route" && g.state === "fail")) state = "hold";
  else if (inviteGates.some((g) => g.state === "unknown")) state = "reviewNeeded";
  else state = gates.every((g) => g.state === "pass") ? "activationReady" : "prospectiveInviteEligible";
  const baseline = deriveMetadataBaseline(packet.recentPosts);
  const comments = packet.posts.map((p) => {
    const s = deriveCommentStats(p.comments);
    return { postId: p.postId, status: s.status, rowCount: s.observedRows, uniqueAuthors: s.uniqueAuthors, unknownAuthorRows: s.unknownAuthorRows, promptedRows: s.promptedRows, creatorRows: s.creatorRows, promotionalRows: s.promotionalRows, categoryCounts: s.categoryCounts, ordering: s.ordering, reason: s.reason };
  });
  const rows = binding?.current.criteria.map(c => ({ ...c, rating: configuredRating(packet, binding.current, c.id, proof) })) ?? [];
  let score: CreatorAssessment["score"] = null;
  if (binding) {
    const c = binding.current;
    const numeric = scoreOf(rows);
    score = { earned: numeric.earned, max: numeric.max, total: numeric.total, unknownCount: numeric.unknownCount, band: numeric.total === null ? null : [...c.bands].sort((a, b) => b.min - a.min).find((b) => numeric.total! >= b.min)?.id ?? null };
  }
  // Numeric readiness is governed only by explicit bound rules, never guessed from a band's label.
  const rules = binding?.current.decisionRules;
  const coverage = rows.reduce((sum, c) => sum + (c.rating === null ? 0 : c.weight), 0);
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
  const snapshot = proof?.snapshot;
  const dateOrder = baseline.selected.map(p => p.publishedAt!).sort((a, b) => Date.parse(a) - Date.parse(b));
  const routeGate = providerGates.find(g => g.id === "SOURCE:route")!;
  const routeEvidence = {
    route: packet.checkoutRoute, status: routeGate.state === "pass" ? "verified" : routeGate.state === "fail" ? "failed" : "unknown",
    verifiedModelId: routeGate.state === "pass" && binding ? binding.current.modelId : null,
    reason: proof?.reason ?? "SOURCE_NOT_CONNECTED", sourceRef: snapshot?.sourceRef ?? null, provider: snapshot?.provider ?? null,
    programId: snapshot?.programId ?? null, programVersion: snapshot?.programVersion ?? null, market: snapshot?.market ?? null,
    creatorSourceId: snapshot?.creatorSourceId ?? null, observedAt: snapshot?.observedAt ?? null, validUntil: snapshot?.validUntil ?? null,
    confidence: { completePublicReviews: posts.length, distinctPublicationDates: dates.size,
      commentsObservedPosts: comments.filter(c => c.status === "observed").length,
      unassessedAudioPosts: packet.posts.filter(p => p.review.audioMethod === "unassessed").length,
      verifiedCriteria: rows.filter(c => c.rating !== null).length, configuredCriteria: rows.length,
      sourceCoverage: !snapshot ? "unknown" : providerGates.every(g => g.state !== "unknown") && rows.every(c => c.rating !== null) ? "complete" : "partial" },
    metrics: snapshot?.metrics ?? [], coveredWeight: coverage, acceptedTerms: snapshot?.terms ?? null, commerce: snapshot?.commerce ?? null,
    audience: snapshot?.audience ?? null,
    criteria: rows.map(c => {
      const isCreative = c.id === binding?.current.routineCriterionId || c.id === binding?.current.demoCriterionId;
      const refs = isCreative ? posts.flatMap(p => p.review.sourceRef ? [p.review.sourceRef] : []) : criterionSource(snapshot, c.id) ?? [];
      return { id: c.id, rating: c.rating, anchor: anchorFor(c.id, c.rating), sourceRefs: refs,
        rationale: isCreative ? null : snapshot?.criteria.find(entry => entry.id === c.id)?.rationale ?? null };
    }),
    comparison: { status: baseline.viewStats.status, count: baseline.viewStats.knownCount, median: baseline.viewStats.median,
      spread: baseline.viewStats.spread, definition: baseline.viewStats.definition, window: baseline.viewStats.window, paid: baseline.viewStats.paid,
      firstPublishedAt: dateOrder.at(0) ?? null, lastPublishedAt: dateOrder.at(-1) ?? null },
  };
  return creatorAssessmentSchema.parse({
    schemaVersion: AGENT_SCHEMA_VERSION, policyVersion: POLICY_VERSION, agentVersion: AGENT_VERSION,
    creatorId: packet.creatorId, briefId: packet.briefId, evidenceRevision: packet.evidenceRevision, termsRevision: packet.termsRevision, modelId,
    config: { status: binding ? "bound" : "unbound", version: binding?.current.version ?? null, hash: binding?.hash ?? null, baselineHash: binding?.baselineHash ?? null, numericHash: binding?.numericHash ?? null },
    configuration: binding ? { criteria: rows, bands: binding.current.bands, arithmetic: binding.current.arithmetic } : null,
    state, contentQualification, gates, packet: { qualifyingPosts: posts.length, publicationDates: dates.size, meaningfulUsePosts: usePosts.length, postIds: posts.map((p) => p.postId) }, criteria: { routine: creativeRating(packet, "routine"), demo: creativeRating(packet, "demo") }, score,
    metadata: { sampleSize: baseline.selected.length, coverage: baseline.coverage, reasonCodes: baseline.coverageReasons, postIds: baseline.selected.map((p) => p.postId), medianViews: baseline.viewStats.median, minViews: baseline.viewStats.min, maxViews: baseline.viewStats.max, comparableViewCount: baseline.viewStats.knownCount },
    comments, reviews: packet.posts.map((p) => ({ postId: p.postId, status: p.review.status, visualMethod: p.review.visualMethod, audioMethod: p.review.audioMethod, sampledPointCount: p.review.sampledPoints.length, continuousSeconds: secondsOf(p.review.watchedIntervals), likeGate: likeGate(p) })),
    routeEvidence,
    reasonCodes: gates.filter((g) => g.state !== "pass").map((g) => g.id),
  });
}
