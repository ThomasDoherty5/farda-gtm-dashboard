import { digest, type ConfigBinding } from "./config.ts";
import { claimKey, evidencePacketSchema, nativePostIdentity, type ClaimDisposition, type EvidencePacket } from "./evidence.ts";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import type { OfferRepository } from "./offers/repository.ts";
import type { OperationsScope } from "./operations.ts";
import { assessCreator, rescoreOf } from "./policy.ts";
import type { ReviewerOverride } from "./assessmentSchema.ts";
import { resolveScorecardEvidence, type ScorecardAuthority } from "./routeEvidence.ts";
import { AgentConflict, type AgentStore, type CallerRequest, type StoredAssessment } from "./store.ts";

export type CreatorEvidenceWrite = { packet: EvidencePacket; expectedVersion: number; configHash: string | null };
export type CreatorEvidenceWriter = {
  /** Scoped privacy normalization applied to new intake and to every retry comparison. */
  protect(packet: EvidencePacket): EvidencePacket;
  /**
   * The only creator evidence writer. It protects comment authors, resolves server-held route proof, runs J02 and appends an
   * immutable revision. `fence` runs synchronously immediately before the append so a caller can recheck its own source lease.
   */
  write(input: CreatorEvidenceWrite, idempotencyKey: string, options?: {
    /** `reviewerDisposition`: the server re-assesses the latest packet right after a person rules on a collected claim. */
    origin?: "reviewer" | "collector" | "reviewerDisposition"; principal?: string; fence?: () => void }): Promise<StoredAssessment>;
};

/** Record identities only J20 assigns (`j20-…` posts, `media-…` canonical media); a reviewer never writes these. */
const J20_IDENTITY = /^(?:j20|media)-[0-9a-f]{32}$/;
const refuse = (): never => { throw new AgentConflict("J20_COLLECTION_READ_ONLY"); };

/**
 * Reviewer writes and J20 collection. While a reviewer keeps J20 evidence, the brief, route, collection marker, reviewed posts
 * and recent-post rows must come back exactly as the collected base stored them; only ratings, criterion ratings and their
 * references, gates and revision labels may change. The ONLY way out of collection is an audited detach that names the
 * latest collected revision of that brief and a reason; the server stamps the reviewer principal. Every uncollected write is
 * judged against the latest collected revision of its TARGET brief, so no brief hop can put uncollected facts there without
 * that detach. No reviewer write may carry J20 provenance, J20 record identities or a native post J20 collected for this
 * creator (NEEDS-OWNER: whether reviewers may reuse J20 values after a detach). Returns the packet to store.
 */
function reviewerWrite(store: AgentStore, packet: EvidencePacket, expectedVersion: number, protect: (packet: EvidencePacket) => EvidencePacket,
  principal: string): EvidencePacket {
  const history = store.history(packet.creatorId);
  const base = expectedVersion ? history.find(record => record.revision === expectedVersion) : null;
  if (expectedVersion && !base) throw new AgentConflict("VERSION_CONFLICT");
  const basis = base ? protect(base.packet) : null;
  const collectedFacts = (p: EvidencePacket) => digest({ creatorId: p.creatorId, briefId: p.briefId, checkoutRoute: p.checkoutRoute,
    posts: p.posts, recentPosts: p.recentPosts, collection: p.collection ?? null });
  if (packet.collection || packet.posts.some(post => post.source)) {
    if (!basis?.collection || packet.detachedCollection || collectedFacts(basis) !== collectedFacts(packet)) refuse();
    return packet;
  }
  // Uncollected facts: never J20 identities or natively the same footage J20 collected for this creator.
  const collected = history.filter(record => record.packet.collection);
  const j20Ids = new Set(collected.flatMap(record => [...record.packet.posts, ...record.packet.recentPosts].flatMap(post => [post.postId, post.canonicalMediaId])
    .concat(record.packet.collection!.exclusions.map(entry => entry.postId))));
  const j20Native = new Set(collected.flatMap(record => record.packet.posts.map(nativePostIdentity)));
  if ([...packet.posts, ...packet.recentPosts].some(post => J20_IDENTITY.test(post.postId) || J20_IDENTITY.test(post.canonicalMediaId) ||
      j20Ids.has(post.postId) || j20Ids.has(post.canonicalMediaId)) || packet.posts.some(post => j20Native.has(nativePostIdentity(post)))) refuse();
  const brief = history.filter(record => record.packet.briefId === packet.briefId);
  const lastCollected = [...brief].reverse().find(record => record.packet.collection);
  const lastDetach = lastCollected && [...brief].reverse().find(record => record.revision > lastCollected.revision &&
    record.packet.detachedCollection?.fromRevision === lastCollected.revision)?.packet.detachedCollection;
  const exit = packet.detachedCollection;
  if (basis?.collection || (lastCollected && !lastDetach)) {
    // Leaving collection: only an audited detach of the latest collected revision of this brief.
    const from = basis?.collection ? base! : lastCollected!;
    if (from.packet.briefId !== packet.briefId || !exit || exit.fromRevision !== from.revision || exit.fromEvidenceRevision !== from.packet.evidenceRevision ||
        (exit.reviewerRef !== undefined && exit.reviewerRef !== principal)) refuse();
    return { ...packet, detachedCollection: { ...exit!, reviewerRef: principal } };
  }
  // Otherwise a detach marker can only be carried exactly as recorded, or dropped to let J20 resume on this brief.
  if (exit && digest(exit) !== digest(lastDetach ?? null)) refuse();
  return packet;
}

/**
 * Copies people's claim dispositions, saved through the existing reviewer path, into the collected packet before J02 runs, so
 * every write (reviewer, collector or the disposition itself) assesses the current human rulings. Only the server reads
 * these from saved reviewer annotations; a collector or a packet write cannot supply one.
 */
function withDispositions(packet: EvidencePacket, saved: readonly ClaimDisposition[], latestLabel: string | null): EvidencePacket {
  const ledger = packet.collection?.claims;
  if (!packet.collection || !ledger?.length) return packet;
  const listed = new Set(ledger.map(entry => claimKey(entry.postId, entry.claim)));
  const merged = new Map((packet.collection.claimDispositions ?? []).map(entry => [entry.annotationRef, entry]));
  for (const entry of saved) if (listed.has(claimKey(entry.postId, entry.claim)) && !merged.has(entry.annotationRef)) merged.set(entry.annotationRef, entry);
  if (merged.size === (packet.collection.claimDispositions ?? []).length) return packet;
  const claimDispositions = [...merged.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.annotationRef.localeCompare(b.annotationRef)).slice(0, 200);
  // A changed disposition set is changed evidence: it keeps the writer's label unless that label is already the latest one.
  const evidenceRevision = packet.evidenceRevision !== latestLabel ? packet.evidenceRevision
    : `d-${digest({ from: packet.evidenceRevision, dispositions: claimDispositions.map(entry => entry.annotationRef) }).slice(0, 32)}`;
  return evidencePacketSchema.parse({ ...packet, evidenceRevision, collection: { ...packet.collection, claimDispositions } });
}

export function createCreatorEvidenceWriter(deps: { store: AgentStore; scope: OperationsScope; secret: string;
  scorecardAuthority?: ScorecardAuthority; modelBinding(route: EvidencePacket["checkoutRoute"]): ConfigBinding | null;
  acceptedTerms: OfferRepository["acceptedTerms"]; claimDispositions?: (creatorId: string) => ClaimDisposition[];
  /** J02-08: open reviewer challenges from the existing evidence-review annotations, recorded in the new snapshot. */
  reviewerOverrides?(packet: EvidencePacket, throughRevision: number): ReviewerOverride[];
  /** Append-only high-water mark of those challenges, re-read inside the save transaction. */
  challengeWatermark?(creatorId: string): string;
  offerCurrent?(terms: { offerId: string; version: string; manifestHash: string }): boolean }): CreatorEvidenceWriter {
  const protect = (packet: EvidencePacket) => protectCommentAuthors(packet, deps.scope, deps.secret);
  // The caller's own request, before any server augmentation; the store keeps it on the receipt row in the save transaction.
  const callerHashOf = (packet: EvidencePacket, expectedVersion: number, configHash: string | null, origin: string) =>
    digest({ origin, packet: protect(packet), expectedVersion, configHash });
  const callerOf = (input: CreatorEvidenceWrite, origin: string): CallerRequest => ({ hash: callerHashOf(input.packet, input.expectedVersion, input.configHash, origin),
    // Receipts from before the column were never augmented, so the stored packet is the caller's packet.
    legacyHash: original => callerHashOf(original.packet, original.revision - 1, original.assessment.config.hash, origin) });
  return {
    protect,
    async write(input, idempotencyKey, options = {}) {
      const binding = deps.modelBinding(input.packet.checkoutRoute);
      if (input.configHash !== (binding?.hash ?? null)) throw new AgentConflict("CONFIG_VERSION_CONFLICT");
      const origin = options.origin ?? "reviewer";
      const caller = callerOf(input, origin);
      const replayed = deps.store.settled(idempotencyKey, caller);
      if (replayed) return replayed;
      let packet = protect(input.packet);
      if (origin === "reviewer") packet = reviewerWrite(deps.store, packet, input.expectedVersion, protect, options.principal ?? "agent-reviewer");
      packet = withDispositions(packet, deps.claimDispositions?.(packet.creatorId) ?? [], deps.store.latest(packet.creatorId)?.packet.evidenceRevision ?? null);
      const proof = await resolveScorecardEvidence(deps.scorecardAuthority, { workspaceId: deps.scope.workspaceId, accountId: deps.scope.accountId },
        packet, Date.now(), id => deps.acceptedTerms(id));
      // J02 has no runtime family of its own: reviewer writes, the J20 collector and the server's re-assessment after a claim
      // ruling all rescore here, and the trigger is classified from the stored prior run rather than accepted from a caller.
      // The basis is the expected prior revision. A newer head makes the save replay or conflict, never use this result.
      const latest = deps.store.latest(packet.creatorId);
      const prior = latest?.revision === input.expectedVersion ? latest : null;
      const watermark = deps.challengeWatermark?.(packet.creatorId) ?? null;
      const reviewerOverrides = deps.reviewerOverrides?.(packet, input.expectedVersion) ?? [];
      const assessment = assessCreator(packet, binding, proof, { reviewerOverrides,
        rescore: rescoreOf(prior, packet, binding?.hash ?? null, reviewerOverrides, terms => deps.offerCurrent?.(terms) ?? false, Date.now(), origin) });
      options.fence?.();
      // A reviewer challenge recorded after the read above would be missing from this snapshot: refuse inside the transaction.
      // A same-key replay already settled above, and the store settles it again before this fence runs.
      return deps.store.save(packet, assessment, input.expectedVersion, idempotencyKey, protect, caller, () => {
        if ((deps.challengeWatermark?.(packet.creatorId) ?? null) !== watermark) throw new AgentConflict("REVIEWER_CHALLENGE_CHANGED");
      });
    },
  };
}
