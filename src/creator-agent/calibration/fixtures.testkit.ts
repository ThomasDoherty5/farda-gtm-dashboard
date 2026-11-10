/** Fictional calibration inputs only. No creator, sales, audience or production approval data. */
import { evidencePacketSchema, type EvidencePacket } from "../evidence.ts";
import { syntheticPacket, syntheticPost } from "../testFixtures.ts";
import { approvalFixture, approvalTestScope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import { CALIBRATION_ACTION_KIND, type CandidateSetInput, type EvidenceBasis, type EvidenceBasisQuery, type EvidenceBasisResolver, type KnownOrUnknown, type ProposalInput } from "./contract.ts";
import { CalibrationRepository, type CalibrationApprovalAuthority } from "./repository.ts";
import { createCalibrationApprovalRegistry } from "./approvalBridge.ts";
import type { ProposalOutcome } from "./repository.ts";

function packet(name: string, change: (packet: EvidencePacket) => void = () => {}): EvidencePacket {
  const value = syntheticPacket("website");
  value.creatorId = `synthetic-calibration-${name}`;
  change(value);
  return evidencePacketSchema.parse(value);
}
/** Each row isolates one evidence-policy boundary. */
export function syntheticCandidatePackets(): Record<string, EvidencePacket> {
  return {
    "baseline-pass": packet("baseline-pass"),
    "likes-at-200": packet("likes-at-200", p => { p.posts[2]!.nativeLikes = { status: "known", value: 200, exact: true, sourceRef: "synthetic:metric:3" }; }),
    "two-posts": packet("two-posts", p => { p.posts = p.posts.slice(0, 2); }),
    "routine-below-floor": packet("routine-below-floor", p => { p.ratings = { routine: 2, demo: 4 }; }),
    "single-date": packet("single-date", p => { for (const post of p.posts) post.publishedAt = "2026-10-02T12:00:00.000Z"; }),
    "unknown-likes": packet("unknown-likes", p => { for (const post of p.posts) post.nativeLikes = { status: "unknown", reason: "Synthetic source did not expose likes." }; }),
    "inexact-likes": packet("inexact-likes", p => { p.posts[0]!.nativeLikes = { status: "known", value: 5000, exact: false, sourceRef: "synthetic:rounded" }; }),
    "cross-post": packet("cross-post", p => { p.posts[2] = { ...syntheticPost(3), canonicalMediaId: "synthetic-media-1" }; }),
    "incomplete-review": packet("incomplete-review", p => { p.posts[0]!.review = { ...p.posts[0]!.review, status: "partial" } as never; }),
    "ratings-unknown": packet("ratings-unknown", p => { p.ratings = { routine: null, demo: null }; }),
  };
}

export function syntheticCandidateSet(names?: string[]): CandidateSetInput {
  const all = syntheticCandidatePackets(), selected = names ?? ["baseline-pass", "likes-at-200", "two-posts", "routine-below-floor", "single-date", "unknown-likes"];
  return { setRef: "synthetic:candidate-set:calibration-v1", label: "Synthetic boundary candidates for evidence-policy comparison", provenance: "synthetic", limit: selected.length,
    candidates: selected.map(name => ({ candidateRef: `synthetic:candidate:${name}`, label: `Synthetic ${name}`, packet: all[name]! })) };
}

export function syntheticBasis(overrides: Partial<EvidenceBasis> = {}): EvidenceBasis {
  return { kind: "reviewedEvidence", basisRef: "synthetic:review-basis", basisVersion: "synthetic-basis-v1",
    window: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" }, sourceKinds: ["completedPostReviews", "reviewerAnnotations"],
    reviewedPackets: { state: "known", value: 24 }, distinctCreators: { state: "known", value: 12 }, reviewerDisagreements: { state: "known", value: 3 },
    retainedSalesCohorts: { state: "unavailable", reason: "No mature retained-sales cohorts exist yet." },
    limits: ["Fictional review counts.", "Packet gates only; no outcome or score evidence."], ...overrides };
}

/**
 * Fictional server-side resolver. It answers for the synthetic basis only and reports whatever counts the test sets,
 * observed at the injected clock. Deployment must supply a resolver over authoritative review records.
 */
export function syntheticBasisResolver(now: () => number) {
  const state = { reviewedPackets: { state: "known", value: 24 } as KnownOrUnknown, distinctCreators: { state: "known", value: 12 } as KnownOrUnknown,
    fail: false, override: null as null | ((query: EvidenceBasisQuery) => unknown), calls: 0 };
  const resolve: EvidenceBasisResolver = async query => {
    state.calls++;
    if (state.fail) throw new Error("Synthetic resolver outage");
    if (state.override) return state.override(query);
    return { scope: query.scope, basisRef: query.basisRef, basisVersion: query.basisVersion, window: query.window, sourceKinds: query.sourceKinds,
      reviewedPackets: state.reviewedPackets, distinctCreators: state.distinctCreators, observedAt: new Date(now()).toISOString() };
  };
  return { state, resolve };
}

export function packetChangeInput(now: number, overrides: Partial<ProposalInput> = {}): ProposalInput {
  return { mode: "evidencePolicy", baseVersionRef: "evidence-policy.2026-11-04.launch-v1",
    rationale: "Synthetic reviewers found two independent on-brief posts on two dates sufficient for review.",
    changes: [{ path: "packet.minIndependentPosts", before: 3, after: 2, rationale: "Fictional review agreement on a smaller packet." }],
    evidenceBasis: syntheticBasis(), candidateSet: syntheticCandidateSet(), expiresAt: new Date(now + 3_600_000).toISOString(), ...overrides };
}

export function proposed(outcome: ProposalOutcome) {
  if (outcome.status !== "proposed") throw new Error(`Expected a stored proposal, got ${outcome.status}: ${outcome.reasonCodes.join(",")} ${outcome.detail.join(" ")}`);
  return outcome.read.proposal;
}

/** Real J04 approval repository on the same SQLite connection, with the calibration registry and fictional humans. */
export function calibrationFixture() {
  const a = approvalFixture();
  let approvals: ApprovalRepository | null = null;
  const basis = syntheticBasisResolver(() => a.state.now);
  const authority: CalibrationApprovalAuthority = {
    database: a.db,
    recordOutcomeLink: input => approvals!.recordOutcomeLink(input),
    resolveCurrentProof: binding => approvals!.resolveCurrentProof(binding),
    assertCurrentProof: (proof, now) => approvals!.assertCurrentProof(proof, now),
    readApproval: (ref, version) => approvals!.readApproval(ref, version),
  };
  const calibration = new CalibrationRepository(a.db, { scope: approvalTestScope, now: () => a.state.now, approvals: authority, basisResolver: basis.resolve });
  const registry = createCalibrationApprovalRegistry(calibration, { policyVersion: a.policy.version, linearIssueRef: "synthetic:owning-issue" }, () => a.state.now);
  approvals = new ApprovalRepository(a.db, { ...a.options, registry, verifyOutcome: input => calibration.verifyOutcome(input) });
  let events = 0;
  /** Proposer previews and requests the decision; a distinct human decides in the fictional Slack source. */
  async function decide(proposal: { proposalRef: string; proposalHash: string }, decision: "approved" | "rejected" | "canceled" = "approved",
    decider = "synthetic:founder", proposer = "synthetic:requester") {
    const command = { actionKind: CALIBRATION_ACTION_KIND, entityRef: proposal.proposalRef, entityVersion: proposal.proposalHash, selectionRefs: [proposal.proposalRef], expectedVersion: 0 };
    const preview = await approvals!.preparePreview(command, { principalRef: proposer }, `preview-${proposal.proposalRef.slice(-12)}`);
    const requested = await approvals!.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: preview.manifest.manifestVersion }, { principalRef: proposer }, `request-${proposal.proposalRef.slice(-12)}`);
    const event = a.event(requested, decision, decider, `synthetic:event-${++events}`);
    const read = await approvals!.observeDecision(event.locator, { ingressRef: "synthetic:authenticated-ingress" });
    return { read, binding: approvalDispatchBinding(read.manifest, proposal.proposalRef) };
  }
  return { a, calibration, approvals: approvals!, registry, decide, basis, authority };
}
