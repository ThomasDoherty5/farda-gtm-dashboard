import { digest, type ConfigBinding } from "./config.ts";
import { claimKey, evidencePacketSchema, nativePostIdentity, type ClaimDisposition, type EvidencePacket } from "./evidence.ts";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import type { OfferRepository } from "./offers/repository.ts";
import type { OperationsScope } from "./operations.ts";
import { assessCreator } from "./policy.ts";
import { resolveScorecardEvidence, type ScorecardAuthority } from "./routeEvidence.ts";
import { AgentConflict, type AgentStore, type StoredAssessment } from "./store.ts";

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
  acceptedTerms: OfferRepository["acceptedTerms"]; claimDispositions?: (creatorId: string) => ClaimDisposition[] }): CreatorEvidenceWriter {
  const protect = (packet: EvidencePacket) => protectCommentAuthors(packet, deps.scope, deps.secret);
  const db = deps.store.database;
  // The caller's own request, before any server augmentation, so a same-key replay settles from its original receipt.
  db.exec("CREATE TABLE IF NOT EXISTS creator_evidence_caller_requests (key TEXT PRIMARY KEY, caller_hash TEXT NOT NULL)");
  const callerHash = (input: CreatorEvidenceWrite, origin: string) => digest({ origin, packet: protect(input.packet), expectedVersion: input.expectedVersion, configHash: input.configHash });
  /** An existing receipt for this key: the original record for the same caller request, a conflict for a different one, or null. */
  const settled = (input: CreatorEvidenceWrite, key: string, origin: string): StoredAssessment | null => {
    const prior = db.prepare("SELECT response FROM requests WHERE key=?").get(key);
    if (!prior) return null;
    const original = JSON.parse(String(prior.response)) as StoredAssessment;
    const caller = db.prepare("SELECT caller_hash FROM creator_evidence_caller_requests WHERE key=?").get(key);
    // Receipts recorded before caller hashes existed were never augmented, so the stored packet is the caller's packet.
    const same = caller ? caller.caller_hash === callerHash(input, origin)
      : digest({ packet: protect(original.packet), expectedVersion: original.revision - 1, configHash: original.assessment.config.hash }) ===
        digest({ packet: protect(input.packet), expectedVersion: input.expectedVersion, configHash: input.configHash });
    if (!same) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
    return original;
  };
  return {
    protect,
    async write(input, idempotencyKey, options = {}) {
      const binding = deps.modelBinding(input.packet.checkoutRoute);
      if (input.configHash !== (binding?.hash ?? null)) throw new AgentConflict("CONFIG_VERSION_CONFLICT");
      const origin = options.origin ?? "reviewer";
      const replayed = settled(input, idempotencyKey, origin);
      if (replayed) return replayed;
      let packet = protect(input.packet);
      if (origin === "reviewer") packet = reviewerWrite(deps.store, packet, input.expectedVersion, protect, options.principal ?? "agent-reviewer");
      packet = withDispositions(packet, deps.claimDispositions?.(packet.creatorId) ?? [], deps.store.latest(packet.creatorId)?.packet.evidenceRevision ?? null);
      const proof = await resolveScorecardEvidence(deps.scorecardAuthority, { workspaceId: deps.scope.workspaceId, accountId: deps.scope.accountId },
        packet, Date.now(), id => deps.acceptedTerms(id));
      const assessment = assessCreator(packet, binding, proof);
      options.fence?.();
      const saved = deps.store.save(packet, assessment, input.expectedVersion, idempotencyKey, protect);
      db.prepare("INSERT OR IGNORE INTO creator_evidence_caller_requests VALUES(?,?)").run(idempotencyKey, callerHash(input, origin));
      return saved;
    },
  };
}
