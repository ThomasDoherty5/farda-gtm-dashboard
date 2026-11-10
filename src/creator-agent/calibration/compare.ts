import { digest } from "../config.ts";
import { evidencePacketSchema, type EvidencePacket, type PostEvidence } from "../evidence.ts";
import { CalibrationError, baselineEvidencePolicy, candidateSetSchema, type BaselineWeakening, type CandidateComparison, type CandidateSetInput, type ComparisonReport, type EvidencePolicyConfig,
  type GateResult, type GateState, type PolicyChange, type Recommendation } from "./contract.ts";

/**
 * The content gates of `assessCreator`, parameterised by an evidence-policy config. At the baseline config the
 * gate ids, states and reasons match `policy.ts` on the 10-packet synthetic boundary set in `conformance.test.ts`, which also
 * fails if a baseline literal drifts from where `policy.ts` flips a gate.
 */
export function likeGateAt(post: PostEvidence, config: EvidencePolicyConfig): GateState {
  return post.nativeLikes.status !== "known" || !post.nativeLikes.exact ? "unknown" : post.nativeLikes.value > config.likeGate.minNativeLikesExclusive ? "pass" : "fail";
}
const reviewed = (post: PostEvidence, config: EvidencePolicyConfig) =>
  post.relevant && !!post.publishedAt && likeGateAt(post, config) === "pass" && post.review.status === "complete";
function creativeRating(packet: EvidencePacket, config: EvidencePolicyConfig, key: "routine" | "demo"): number | null {
  return packet.posts.some(post => reviewed(post, config) && post.review.sourceRef) ? packet.ratings[key] : null;
}

export function evaluateEvidencePolicy(packet: EvidencePacket, config: EvidencePolicyConfig): { recommendation: Recommendation; gates: GateResult[] } {
  const gates: GateResult[] = [];
  const add = (id: string, state: GateState, reason: string) => gates.push({ id, state, reason });
  const independent = new Map<string, PostEvidence>();
  for (const post of packet.posts) if (reviewed(post, config)) {
    const existing = independent.get(post.canonicalMediaId);
    if (!existing || post.publishedAt! < (existing.publishedAt ?? "")) independent.set(post.canonicalMediaId, post);
  }
  const posts = [...independent.values()];
  const dates = new Set(posts.map(post => new Date(post.publishedAt!).toISOString().slice(0, 10)));
  const usePosts = posts.filter(post => packet.posts.some(related => related.canonicalMediaId === post.canonicalMediaId && reviewed(related, config)
    && related.review.observedActions.some(action => action.meaningfulUse)));
  const { minIndependentPosts, minPublicationDates, minMeaningfulUsePosts } = config.packet;
  add("QUALIFYING_POSTS", posts.length >= minIndependentPosts ? "pass" : "unknown",
    `${posts.length}/${minIndependentPosts} independent relevant complete posts with exact native likes >${config.likeGate.minNativeLikesExclusive}`);
  add("PUBLICATION_DATES", dates.size >= minPublicationDates ? "pass" : "unknown", `${dates.size}/${minPublicationDates} publication dates`);
  add("MEANINGFUL_USE", usePosts.length >= minMeaningfulUsePosts ? "pass" : "unknown", `${usePosts.length}/${minMeaningfulUsePosts} on-brief action/use examples`);
  for (const key of ["routine", "demo"] as const) {
    const rating = creativeRating(packet, config, key);
    const minimum = key === "routine" ? config.criticalFloors.routineFit : config.criticalFloors.demonstrationStorytelling;
    add(key === "routine" ? "ROUTINE_FLOOR" : "DEMO_FLOOR", rating === null ? "unknown" : rating >= minimum ? "pass" : "fail",
      rating === null ? "Required criterion evidence is unknown" : `Verified rating ${rating}/5; minimum ${minimum}/5`);
  }
  const recommendation: Recommendation = gates.some(g => g.state === "fail") ? "hold" : gates.some(g => g.state === "unknown") ? "reviewNeeded" : "pass";
  return { recommendation, gates };
}

/** Which config leaves can move each gate. Used to explain a changed recommendation. */
const GATE_DRIVERS: Record<string, string[]> = {
  QUALIFYING_POSTS: ["likeGate.minNativeLikesExclusive", "packet.minIndependentPosts"],
  PUBLICATION_DATES: ["likeGate.minNativeLikesExclusive", "packet.minPublicationDates"],
  MEANINGFUL_USE: ["likeGate.minNativeLikesExclusive", "packet.minMeaningfulUsePosts"],
  ROUTINE_FLOOR: ["likeGate.minNativeLikesExclusive", "criticalFloors.routineFit"],
  DEMO_FLOOR: ["likeGate.minNativeLikesExclusive", "criticalFloors.demonstrationStorytelling"],
};

const GATE_PATHS = ["likeGate.minNativeLikesExclusive", "packet.minIndependentPosts", "packet.minPublicationDates", "packet.minMeaningfulUsePosts",
  "criticalFloors.routineFit", "criticalFloors.demonstrationStorytelling"] as const;
/** Every gate the config sets below the launch baseline, whatever the proposal's own base version was. */
export function baselineWeakenings(config: EvidencePolicyConfig): BaselineWeakening[] {
  const baseline = baselineEvidencePolicy();
  const read = (value: EvidencePolicyConfig, path: string) => path.split(".").reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)[key], value) as number;
  return GATE_PATHS.flatMap(path => read(config, path) < read(baseline, path)
    ? [{ path, baseline: read(baseline, path), proposed: read(config, path), disablesGate: read(config, path) === 0 }] : []);
}

/** Synthetic rows only: candidate identities must be visibly fictional so no creator data enters a proposal. */
export function parseCandidateSet(raw: CandidateSetInput) {
  const parsed = candidateSetSchema.safeParse(raw);
  if (!parsed.success) throw new CalibrationError("CANDIDATE_SET_INVALID", 422);
  const candidates = parsed.data.candidates.map(candidate => {
    const packet = evidencePacketSchema.safeParse(candidate.packet);
    if (!packet.success) throw new CalibrationError("CANDIDATE_PACKET_INVALID", 422);
    if (!/^synthetic[-:]/.test(packet.data.creatorId) || !/^synthetic[-:]/.test(candidate.candidateRef))
      throw new CalibrationError("CANDIDATE_NOT_SYNTHETIC", 422);
    return { candidateRef: candidate.candidateRef, label: candidate.label, packet: packet.data };
  });
  return { ...parsed.data, candidates };
}

export function compareConfigs(prior: EvidencePolicyConfig, proposed: EvidencePolicyConfig, changes: PolicyChange[], raw: CandidateSetInput): ComparisonReport {
  const set = parseCandidateSet(raw);
  const changedPaths = new Set(changes.map(change => change.path));
  const results: CandidateComparison[] = set.candidates.map(candidate => {
    const before = evaluateEvidencePolicy(candidate.packet, prior), after = evaluateEvidencePolicy(candidate.packet, proposed);
    const gateChanges = before.gates.flatMap((gate, index) => {
      const next = after.gates[index]!;
      return gate.state === next.state && gate.reason === next.reason ? []
        : [{ id: gate.id, before: gate, after: next, drivenBy: (GATE_DRIVERS[gate.id] ?? []).filter(path => changedPaths.has(path)) }];
    });
    return { candidateRef: candidate.candidateRef, label: candidate.label, prior: before.recommendation, proposed: after.recommendation,
      changed: before.recommendation !== after.recommendation, gateChanges };
  });
  const transitions: Record<string, number> = {};
  for (const result of results) if (result.changed) transitions[`${result.prior}->${result.proposed}`] = (transitions[`${result.prior}->${result.proposed}`] ?? 0) + 1;
  const weakensBaseline = baselineWeakenings(proposed);
  return {
    weakensBaseline,
    candidateSet: { setRef: set.setRef, label: set.label, provenance: "synthetic", limit: set.limit, candidateCount: set.candidates.length, hash: digest(raw) },
    scope: "Synthetic, explicitly limited candidate set. Not a population estimate, not creator data, and not a sales or demographic inference.",
    numericScoring: "unchanged-not-evaluated",
    results,
    anchorChanges: changes.filter(change => change.path.startsWith("anchors.")).map(change => ({ path: change.path, reviewImpact: "humanReReviewRequired" as const })),
    summary: { changed: results.filter(r => r.changed).length, unchanged: results.filter(r => !r.changed).length, transitions, weakensBaseline: weakensBaseline.length },
  };
}
