import { randomUUID } from "node:crypto";
import { canonicalJson, digest } from "./config.ts";
import { nativePostIdentity, type PostEvidence } from "./evidence.ts";
import { reviewInputSchema, type EvidenceAnnotation, type SourceReview } from "./evidenceReviewContract.ts";
import type { AgentStore, StoredAssessment } from "./store.ts";

export class EvidenceReviewError extends Error {
  readonly code: string; readonly status: number; readonly currentVersion?: string;
  constructor(code: string, status: number, currentVersion?: string) {
    super(code); this.code = code; this.status = status; this.currentVersion = currentVersion;
  }
}
type Scope = { workspaceId: string; accountId: string };
type Effective = StoredAssessment & { stale: boolean };
type Current = (record: StoredAssessment, superseded?: boolean) => Effective;

type Interval = { startSec:number; endSec:number };
function intervalUnion(spans: Interval[]) {
  const result: Interval[] = [];
  for (const span of [...spans].sort((a,b) => a.startSec-b.startSec)) {
    const previous = result.at(-1);
    if (previous && span.startSec <= previous.endSec) previous.endSec = Math.max(previous.endSec,span.endSec);
    else result.push({...span});
  }
  return result;
}
function coversInterval(spans: Interval[], start: number, end: number) {
  return intervalUnion(spans).some(span => span.startSec <= start && span.endSec >= end);
}

function sourceTargets(post: PostEvidence): SourceReview["targets"] {
  return [
    { id: "review", label: `Source review: ${post.review.status}, visual ${post.review.visualMethod}, audio ${post.review.audioMethod}` },
    ...post.review.observedActions.map((a, i) => ({ id: `action-${i}`, label: `${a.atSec}s · Visual action · ${a.action}` })),
    ...post.review.claims.map((c, i) => ({ id: `claim-${i}`, label: `${c.atSec}s · ${c.method} claim · ${c.text}` })),
    ...post.review.inferences.map((text, i) => ({ id: `inference-${i}`, label: `Reviewer inference · ${text}` })),
  ];
}
function reviewBasis(scope: Scope, stored: StoredAssessment, post: PostEvidence) {
  return digest({ scope, runId: stored.runId, packetHash: stored.packetHash,
    postId: post.postId, canonicalMediaId: post.canonicalMediaId, nativeIdentity: nativePostIdentity(post),
    evidence: stored.packet.evidenceRevision, terms: stored.packet.termsRevision, policy: stored.assessment.policyVersion,
    model: stored.assessment.modelId, config: stored.assessment.config.hash, agentVersion: stored.assessment.agentVersion });
}
function sameReviewFacts(a: PostEvidence, b: PostEvidence) {
  // Reordering or duplicating an identical timestamped fact does not change what the review observed.
  const factSet = (items: unknown[]) => [...new Set(items.map(canonicalJson))].sort();
  const facts = (p: PostEvidence) => [p.review.status,p.review.visualMethod,p.review.audioMethod,
    factSet(p.review.observedActions),factSet(p.review.claims),factSet(p.review.inferences),factSet(p.review.sampledPoints),
    intervalUnion(p.review.watchedIntervals),intervalUnion(p.review.heardIntervals ?? [])];
  return digest(facts(a))===digest(facts(b));
}
function resolvedByReview(prior: PostEvidence, current: PostEvidence, annotation: EvidenceAnnotation) {
  const before = Date.parse(prior.review.reviewedAt ?? prior.observedAt);
  const after = Date.parse(current.review.reviewedAt ?? "");
  const challengedAt = Date.parse(annotation.recordedAt);
  if (current.review.status !== "complete" || !current.review.sourceRef || current.review.sourceRef === prior.review.sourceRef ||
      !Number.isFinite(after) || !Number.isFinite(before) || !Number.isFinite(challengedAt) ||
      after <= Math.max(before,challengedAt) || after > Date.now() || !annotation.original) return false;
  if (annotation.original.id === "review") return !sameReviewFacts(prior,current);
  // A reordering keeps the same claim. Changes to a different observation cannot clear this challenge.
  const targetId = annotation.original.id;
  const match = /^(action|claim|inference)-(\d+)$/.exec(targetId);
  if (!match) return false; // A disputed reviewer note needs explicit review outside this intake.
  const facts = (post: PostEvidence): unknown[] => match[1] === "action" ? post.review.observedActions :
    match[1] === "claim" ? post.review.claims : post.review.inferences;
  const priorFact = facts(prior)[Number(match[2])];
  return priorFact !== undefined && !facts(current).some(f => digest(f) === digest(priorFact));
}
function projection(record: Effective, post: PostEvidence, sourceReview: SourceReview, version: string) {
  const unknown = (reasonCode: string) => ({ state: "unknown" as const, value: null, reasonCode, evidenceRefs: [],
    sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: record.recordedAt });
  return {
    evidenceRef: post.postId, creatorHandle: record.packet.creatorId, version, mediaUrl: post.sourceUrl, checkoutRoute: record.packet.checkoutRoute,
    observations: [], savedAt: null, reviewerRole: null,
    modelPublication: { label: record.assessment.config.version ?? "Configuration unbound", note: "Configuration recorded with this assessment." },
    assessments: { creative: unknown("NO_CREATIVE_WEIGHT_BINDING"), routine: unknown("SEE_AGENT_QUALIFICATION"), commerce: unknown("NO_VERIFIED_ORDER_EVIDENCE") },
    firstReview: null, disputes: [], readiness: { state: "notReady" as const, reasonCodes: sourceReview.contested ? ["CONTESTED"] : ["AGENT_ASSESSMENT_READ_ONLY"] },
    qualification: record.assessment, agentEvidence: record.packet, sourceReview,
  };
}
type Receipt = { resourceRef: string; version: string; resource: EvidenceAnnotation; updatedAt: string; persistedByRef: string; reasonCodes: string[] };

/** Append reviewer observations beside the immutable J20 packet. No operation changes a source fact, score or send state. */
export class EvidenceReviewRepository {
  readonly store: AgentStore; readonly scope: Scope; readonly current: Current;
  constructor(store: AgentStore, scope: Scope, current: Current) {
    this.store = store; this.scope = scope; this.current = current;
    const bound = store.database.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (bound?.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId)
      throw new EvidenceReviewError("DATABASE_SCOPE_MISMATCH", 403);
    store.database.exec(`CREATE TABLE IF NOT EXISTS evidence_review_annotations(
      basis TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(basis,revision));
      CREATE TABLE IF NOT EXISTS evidence_review_requests(
      request_key TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_review_run_kind ON evidence_review_annotations(
        json_extract(body,'$.input.runId'),json_extract(body,'$.input.kind'));
      CREATE INDEX IF NOT EXISTS evidence_review_creator_kind ON evidence_review_annotations(
        json_extract(body,'$.input.creatorId'),json_extract(body,'$.input.kind'));`);
  }
  contested(record: StoredAssessment): boolean {
    const rows = this.store.database.prepare(`SELECT n.body AS annotation,a.body AS source FROM evidence_review_annotations n
      JOIN assessments a ON a.run_id=json_extract(n.body,'$.input.runId')
      WHERE json_extract(n.body,'$.input.creatorId')=? AND json_extract(n.body,'$.input.kind') IN ('disagree','override')
      AND a.revision<=?`).iterate(record.packet.creatorId,record.revision);
    for (const row of rows) {
      const annotation = JSON.parse(String(row.annotation)) as EvidenceAnnotation;
      const original = JSON.parse(String(row.source)) as StoredAssessment;
      const prior = original.packet.posts.find(p => annotation.postId ? p.postId === annotation.postId : reviewBasis(this.scope,original,p) === annotation.input.basisHash);
      if (!prior) return true;
      if (record.packet.posts.some(post => (post.canonicalMediaId === prior.canonicalMediaId || nativePostIdentity(post) === nativePostIdentity(prior))
        && !resolvedByReview(prior,post,annotation))) return true;
    }
    return false;
  }
  private adjacent(creatorId: string, postId: string, revision: number, newer: boolean): string | null {
    // Locate a prior/next receipt for this exact post even when it disappeared from an intermediate packet.
    const sql = `SELECT a.run_id FROM assessments a WHERE a.creator_id=? AND a.revision ${newer ? ">" : "<"} ?
      AND EXISTS(SELECT 1 FROM json_each(a.body,'$.packet.posts') p WHERE json_extract(p.value,'$.postId')=?)
      ORDER BY a.revision ${newer ? "ASC" : "DESC"} LIMIT 1`;
    const row = this.store.database.prepare(sql).get(creatorId,revision,postId);
    return row ? String(row.run_id) : null;
  }
  private project(creatorId: string, evidenceId: string, runId?: string) {
    const latest = this.store.latest(creatorId);
    const stored = runId ? this.store.findRun(creatorId,runId) : latest;
    const post = stored?.packet.posts.find(p => p.postId === evidenceId);
    if (!stored || !post) return null;
    const superseded = latest?.runId !== stored.runId;
    const record = this.current(stored,superseded);
    const basisHash = reviewBasis(this.scope,stored,post);
    const rows = this.store.database.prepare("SELECT body FROM evidence_review_annotations WHERE basis=? ORDER BY revision").all(basisHash);
    const annotations = rows.map(row => JSON.parse(String(row.body)) as EvidenceAnnotation);
    const sourceReview: SourceReview = { runId: stored.runId, creatorId, postId: post.postId, canonicalMediaId: post.canonicalMediaId,
      nativeIdentity: nativePostIdentity(post), basisHash, evidenceRevision: stored.packet.evidenceRevision, termsRevision: stored.packet.termsRevision,
      policyVersion: stored.assessment.policyVersion, modelId: stored.assessment.modelId, configHash: stored.assessment.config.hash,
      access: post.accessObservation ?? null, recordedAt: stored.recordedAt, superseded, stale: record.stale, contested: this.contested(stored),
      olderRunId: this.adjacent(creatorId,evidenceId,stored.revision,false), newerRunId: this.adjacent(creatorId,evidenceId,stored.revision,true),
      targets: sourceTargets(post), annotations };
    const version = `er-${basisHash}-${annotations.length}`;
    const effective = sourceReview.contested ? { ...record, assessment: { ...record.assessment, state: "reviewNeeded" as const,
      reasonCodes: [...new Set([...record.assessment.reasonCodes,"EVIDENCE_DISPUTED"])] } } : record;
    return { data: projection(effective,post,sourceReview,version), stale: record.stale || sourceReview.contested,
      canAnnotate: !record.stale && !superseded && annotations.length < 100 };
  }
  read(creatorId: string, evidenceId: string, runId?: string) {
    const db = this.store.database;
    db.exec("BEGIN");
    try { const result = this.project(creatorId,evidenceId,runId); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  saveFromAdapter(resourceRef: string, expectedVersion: string | null, payload: unknown, key: string, reviewer: string,
    resourceKind?: "evidenceDraft" | "reviewerAssessment"): Receipt {
    const parsed = reviewInputSchema.safeParse(payload);
    if (!parsed.success || !key.trim() || key.length > 240 || !reviewer.trim()) throw new EvidenceReviewError("VALIDATION_FAILED",422);
    const input = parsed.data, db = this.store.database;
    if (resourceKind && resourceKind !== (input.kind === "observation" ? "evidenceDraft" : "reviewerAssessment"))
      throw new EvidenceReviewError("VALIDATION_FAILED",422);
    const hash = digest([this.scope,resourceRef,expectedVersion,input,reviewer]);
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT digest,receipt FROM evidence_review_requests WHERE request_key=?").get(key);
      if (previous) {
        if (previous.digest !== hash) throw new EvidenceReviewError("IDEMPOTENCY_KEY_REUSED",409);
        const receipt = JSON.parse(String(previous.receipt)) as Receipt;
        db.exec("COMMIT"); return receipt;
      }
      const result = this.project(input.creatorId,resourceRef,input.runId);
      if (!result) throw new EvidenceReviewError("RECORD_NOT_FOUND",404);
      const review = result.data.sourceReview;
      if (input.basisHash !== review.basisHash || result.data.version !== expectedVersion || review.stale || review.superseded)
        throw new EvidenceReviewError("STALE_VERSION",409,result.data.version);
      if (!result.canAnnotate) throw new EvidenceReviewError("EVIDENCE_REVIEW_LIMIT",409);
      if (input.kind === "observation") {
        const post = result.data.agentEvidence.posts.find(p => p.postId === resourceRef)!;
        const spans = input.note.category === "audio" ? post.review.heardIntervals ?? [] : post.review.watchedIntervals;
        if (!coversInterval(spans,input.note.startSec,input.note.endSec))
          throw new EvidenceReviewError("OBSERVATION_OUTSIDE_REVIEW",422);
      }
      const noteTargets = review.annotations.flatMap(a => a.input.kind === "observation" ? [{ id: a.id,
        label: `${a.input.note.startSec}–${a.input.note.endSec}s · ${a.input.note.category} · ${a.input.note.text}` }] : []);
      const original = input.kind === "observation" ? null : [...review.targets,...noteTargets].find(t => t.id === input.targetId) ?? null;
      if (input.kind !== "observation" && !original) throw new EvidenceReviewError("VALIDATION_FAILED",422);
      const annotation: EvidenceAnnotation = { id: randomUUID(), postId: resourceRef, revision: review.annotations.length+1, input,
        original, reviewer, recordedAt: new Date().toISOString() };
      db.prepare("INSERT INTO evidence_review_annotations VALUES(?,?,?)").run(review.basisHash,annotation.revision,JSON.stringify(annotation));
      const receipt: Receipt = { resourceRef, version: `er-${review.basisHash}-${annotation.revision}`, resource: annotation,
        updatedAt: annotation.recordedAt, persistedByRef: reviewer, reasonCodes: [] };
      db.prepare("INSERT INTO evidence_review_requests VALUES(?,?,?)").run(key,hash,JSON.stringify(receipt));
      db.exec("COMMIT"); return receipt;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
