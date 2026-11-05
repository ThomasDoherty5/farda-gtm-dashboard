import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./config.ts";
import { AgentConflict } from "./store.ts";
import { portfolioActionSchema, portfolioPacketSchema, portfolioReviewKey, reviewPortfolio, type PortfolioPacket, type PortfolioProposal } from "./portfolio.ts";

const ref = z.string().trim().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({ workspaceId: ref, accountId: ref }).strict();
export type PortfolioScope = z.infer<typeof scopeSchema>;
export const portfolioWriteSchema = z.object({ scope: scopeSchema, expectedVersion: z.number().int().nonnegative(), packet: portfolioPacketSchema }).strict();
export const portfolioDecisionRequestSchema = z.object({ scope: scopeSchema, expectedVersion: z.number().int().positive(), reviewHash: hash, linearDecisionRef: ref }).strict();
export const verifiedPortfolioDecisionSchema = z.object({
  scope: scopeSchema,
  linearDecisionRef: ref, reviewKey: hash, revision: z.number().int().positive(), reviewHash: hash,
  decision: z.enum(["approved", "rejected"]), decidedAt: z.string().datetime({ offset: true }), founderRef: ref,
  creatorDecisions: z.array(z.object({ creatorId: ref, action: portfolioActionSchema }).strict()).max(100),
}).strict();
export type VerifiedPortfolioDecision = z.infer<typeof verifiedPortfolioDecisionSchema>;
export const verifiedPortfolioOnDemandApprovalSchema = z.object({
  scope: scopeSchema, approvalRef: ref, eventId: ref, approved: z.boolean(),
}).strict();
export type VerifiedPortfolioOnDemandApproval = z.infer<typeof verifiedPortfolioOnDemandApprovalSchema>;
/** Only trusted server-side resolution may return a verified founder decision. No body flag grants authority. */
export interface PortfolioDecisionAuthority {
  resolveDecision(linearDecisionRef: string, scope: PortfolioScope): Promise<VerifiedPortfolioDecision | null>;
  resolveOnDemandApproval(approvalRef: string, eventId: string, scope: PortfolioScope): Promise<VerifiedPortfolioOnDemandApproval | null>;
  resolveParticipation?(sourceReceiptRef: string, scope: PortfolioScope): Promise<VerifiedPortfolioParticipation | null>;
}
const unavailableAuthority: PortfolioDecisionAuthority = { resolveDecision: async () => null, resolveOnDemandApproval: async () => null };
export type StoredPortfolioReview = { scope: PortfolioScope; reviewKey: string; runId: string; revision: number; recordedAt: string; packetHash: string; reviewHash: string; packet: PortfolioPacket; proposal: PortfolioProposal };
export type StoredPortfolioDecision = VerifiedPortfolioDecision & {
  decisionId: string; recordedAt: string; executionState: "approved-awaiting-existing-workflow" | "rejected";
  handoffs: { creatorId: string; jobs: string[] }[]; dispatchAuthorized: false;
};
export const portfolioParticipationSchema = z.object({
  scope: scopeSchema,
  decisionId: ref, creatorId: ref, state: z.enum(["accepted", "declined", "activated", "outcome"]),
  nextCollaborationIds: z.array(ref).max(100), sourceReceiptRef: ref,
  occurredAt: z.string().datetime({ offset: true }), outcomeRefs: z.array(ref).max(100),
}).strict().superRefine((input, context) => {
  if ((input.state === "activated" || input.state === "outcome") && !input.nextCollaborationIds.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Activated participation requires next collaboration IDs" });
  if (input.state === "outcome" && !input.outcomeRefs.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Outcome receipts are required" });
  if (new Set(input.nextCollaborationIds).size !== input.nextCollaborationIds.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate next collaboration" });
});
export type StoredPortfolioParticipation = z.infer<typeof portfolioParticipationSchema> & { participationId: string; recordedAt: string };
const verifiedParticipationSchema = z.object({ reviewKey: hash, participation: portfolioParticipationSchema }).strict();
export type VerifiedPortfolioParticipation = z.infer<typeof verifiedParticipationSchema>;
export class PortfolioAuthorityUnavailable extends Error {}

/** Uses the already scoped AgentStore connection. No second CRM, scheduler or database connection. */
export class PortfolioRepository {
  private readonly database: DatabaseSync;
  private readonly scope: PortfolioScope;
  private readonly authority: PortfolioDecisionAuthority;
  constructor(database: DatabaseSync, scope: PortfolioScope, authority: PortfolioDecisionAuthority = unavailableAuthority) {
    this.database = database;
    this.scope = scope;
    this.authority = authority;
    scopeSchema.parse(scope);
    const persistedScope = database.prepare("SELECT workspace_id, account_id FROM agent_scope WHERE id=1").get();
    if (persistedScope?.workspace_id !== scope.workspaceId || persistedScope.account_id !== scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
    database.exec(`CREATE TABLE IF NOT EXISTS portfolio_reviews (
      review_key TEXT NOT NULL, revision INTEGER NOT NULL, packet_hash TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(review_key,revision));
      CREATE TABLE IF NOT EXISTS portfolio_requests (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_events (event_id TEXT PRIMARY KEY, review_key TEXT NOT NULL, packet_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_decisions (decision_id TEXT PRIMARY KEY, review_key TEXT NOT NULL, revision INTEGER NOT NULL, linear_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL, UNIQUE(review_key,revision));
      CREATE TABLE IF NOT EXISTS portfolio_source_receipts (receipt_ref TEXT PRIMARY KEY, request_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portfolio_participation (participation_id TEXT PRIMARY KEY, review_key TEXT NOT NULL, decision_id TEXT NOT NULL, creator_id TEXT NOT NULL, recorded_at TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  private checkScope(scope: PortfolioScope) {
    if (scope.workspaceId !== this.scope.workspaceId || scope.accountId !== this.scope.accountId) throw new AgentConflict("PORTFOLIO_SCOPE_MISMATCH");
  }
  latest(reviewKey: string): StoredPortfolioReview | null {
    const row = this.database.prepare("SELECT body FROM portfolio_reviews WHERE review_key=? ORDER BY revision DESC LIMIT 1").get(reviewKey);
    return row ? JSON.parse(String(row.body)) as StoredPortfolioReview : null;
  }
  history(reviewKey: string) {
    return {
      reviews: this.database.prepare("SELECT body FROM portfolio_reviews WHERE review_key=? ORDER BY revision").all(reviewKey).map((row) => JSON.parse(String(row.body)) as StoredPortfolioReview),
      decisions: this.database.prepare("SELECT body FROM portfolio_decisions WHERE review_key=? ORDER BY revision").all(reviewKey).map((row) => JSON.parse(String(row.body)) as StoredPortfolioDecision),
      participation: this.database.prepare("SELECT body FROM portfolio_participation WHERE review_key=? ORDER BY rowid").all(reviewKey).map((row) => JSON.parse(String(row.body)) as StoredPortfolioParticipation),
    };
  }
  private replay<T>(key: string, requestHash: string): T | null {
    const prior = this.database.prepare("SELECT request_hash,body FROM portfolio_requests WHERE key=?").get(key);
    if (!prior) return null;
    if (prior.request_hash !== requestHash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(String(prior.body)) as T;
  }
  private transactional<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.database.exec("COMMIT"); return value; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private receipt(key: string, requestHash: string, value: unknown) {
    this.database.prepare("INSERT INTO portfolio_requests VALUES(?,?,?)").run(key, requestHash, JSON.stringify(value));
  }
  async review(raw: unknown, idempotencyKey: string): Promise<StoredPortfolioReview> {
    const input = portfolioWriteSchema.parse(raw);
    this.checkScope(input.scope);
    const requestHash = digest({ operation: "portfolio.review", input });
    const replay = this.replay<StoredPortfolioReview>(idempotencyKey, requestHash);
    if (replay) return replay;
    if (input.packet.trigger.kind === "approved-on-demand") {
      const trigger = input.packet.trigger;
      const resolved = await this.authority.resolveOnDemandApproval(trigger.approvalRef, trigger.eventId, this.scope);
      if (!resolved) throw new PortfolioAuthorityUnavailable("ON_DEMAND_APPROVAL_UNVERIFIED");
      const approval = verifiedPortfolioOnDemandApprovalSchema.parse(resolved);
      this.checkScope(approval.scope);
      if (approval.approvalRef !== trigger.approvalRef || approval.eventId !== trigger.eventId) throw new AgentConflict("ON_DEMAND_APPROVAL_BINDING_MISMATCH");
      if (!approval.approved) throw new PortfolioAuthorityUnavailable("ON_DEMAND_APPROVAL_UNVERIFIED");
    }
    return this.transactional(() => {
      const retry = this.replay<StoredPortfolioReview>(idempotencyKey, requestHash);
      if (retry) return retry;
      const reviewKey = portfolioReviewKey(input.packet);
      const packetHash = digest(input.packet);
      const event = this.database.prepare("SELECT review_key,packet_hash,body FROM portfolio_events WHERE event_id=?").get(input.packet.trigger.eventId);
      if (event) {
        if (event.review_key !== reviewKey || event.packet_hash !== packetHash) throw new AgentConflict("REVIEW_EVENT_REUSED");
        const existing = JSON.parse(String(event.body)) as StoredPortfolioReview;
        this.receipt(idempotencyKey, requestHash, existing);
        return existing;
      }
      const latest = this.latest(reviewKey);
      if ((latest?.revision ?? 0) !== input.expectedVersion) throw new AgentConflict("VERSION_CONFLICT");
      if (latest && latest.packet.evidenceRevision === input.packet.evidenceRevision) throw new AgentConflict("EVIDENCE_REVISION_REUSED");
      const proposal = reviewPortfolio(input.packet);
      const record: StoredPortfolioReview = { scope: this.scope, reviewKey, runId: randomUUID(), revision: input.expectedVersion + 1, recordedAt: new Date().toISOString(), packetHash, reviewHash: digest({ scope: this.scope, packetHash, proposal }), packet: input.packet, proposal };
      const body = JSON.stringify(record);
      this.database.prepare("INSERT INTO portfolio_reviews VALUES(?,?,?,?)").run(reviewKey, record.revision, packetHash, body);
      this.database.prepare("INSERT INTO portfolio_events VALUES(?,?,?,?)").run(input.packet.trigger.eventId, reviewKey, packetHash, body);
      this.receipt(idempotencyKey, requestHash, record);
      return record;
    });
  }
  async decide(reviewKey: string, raw: unknown, idempotencyKey: string): Promise<StoredPortfolioDecision> {
    const input = portfolioDecisionRequestSchema.parse(raw);
    this.checkScope(input.scope);
    const requestHash = digest({ operation: "portfolio.decide", reviewKey, input });
    const replay = this.replay<StoredPortfolioDecision>(idempotencyKey, requestHash);
    if (replay) return replay;
    const resolved = await this.authority.resolveDecision(input.linearDecisionRef, this.scope);
    if (!resolved) throw new PortfolioAuthorityUnavailable("LINEAR_DECISION_UNVERIFIED");
    const decision = verifiedPortfolioDecisionSchema.parse(resolved);
    this.checkScope(decision.scope);
    if (decision.linearDecisionRef !== input.linearDecisionRef || decision.reviewKey !== reviewKey || decision.revision !== input.expectedVersion || decision.reviewHash !== input.reviewHash)
      throw new AgentConflict("DECISION_SCOPE_MISMATCH");
    return this.transactional(() => {
      const retry = this.replay<StoredPortfolioDecision>(idempotencyKey, requestHash);
      if (retry) return retry;
      const latest = this.latest(reviewKey);
      if (!latest) throw new AgentConflict("REVIEW_NOT_FOUND");
      if (latest.revision !== input.expectedVersion || latest.reviewHash !== input.reviewHash) throw new AgentConflict("STALE_PORTFOLIO_DECISION");
      if (new Set(decision.creatorDecisions.map((c) => c.creatorId)).size !== decision.creatorDecisions.length || decision.creatorDecisions.length !== latest.proposal.recommendations.length)
        throw new AgentConflict("DECISION_CREATOR_SET_MISMATCH");
      for (const choice of decision.creatorDecisions) {
        const recommendation = latest.proposal.recommendations.find((c) => c.creatorId === choice.creatorId);
        if (!recommendation) throw new AgentConflict("DECISION_CREATOR_SET_MISMATCH");
        if (choice.action !== recommendation.action) throw new AgentConflict("DECISION_PROPOSAL_CHANGED");
      }
      const prior = this.database.prepare("SELECT body FROM portfolio_decisions WHERE review_key=? AND revision=?").get(reviewKey, latest.revision);
      if (prior) {
        const existing = JSON.parse(String(prior.body)) as StoredPortfolioDecision;
        if (existing.linearDecisionRef !== decision.linearDecisionRef) throw new AgentConflict("DECISION_ALREADY_RECORDED");
        if (digest(verifiedPortfolioDecisionSchema.strip().parse(existing)) !== digest(decision)) throw new AgentConflict("LINEAR_DECISION_RECEIPT_CHANGED");
        this.receipt(idempotencyKey, requestHash, existing);
        return existing;
      }
      if (this.database.prepare("SELECT decision_id FROM portfolio_decisions WHERE linear_ref=?").get(decision.linearDecisionRef)) throw new AgentConflict("LINEAR_DECISION_RECEIPT_REUSED");
      const record: StoredPortfolioDecision = { ...decision, decisionId: randomUUID(), recordedAt: new Date().toISOString(), executionState: decision.decision === "approved" ? "approved-awaiting-existing-workflow" : "rejected", dispatchAuthorized: false,
        handoffs: decision.decision === "approved" ? latest.proposal.cohort.selectedCreatorIds.map((creatorId) => {
          const c = latest.packet.creators.find((candidate) => candidate.creatorId === creatorId)!;
          return { creatorId, jobs: ["J03", "J04", "J05/J06", ...(c.next.alreadyHasUsableProduct.value === true ? [] : ["J07"])] };
        }) : [],
      };
      this.database.prepare("INSERT INTO portfolio_decisions VALUES(?,?,?,?,?)").run(record.decisionId, reviewKey, latest.revision, record.linearDecisionRef, JSON.stringify(record));
      this.receipt(idempotencyKey, requestHash, record);
      return record;
    });
  }
  async recordParticipation(reviewKey: string, raw: unknown, idempotencyKey: string): Promise<StoredPortfolioParticipation> {
    const input = portfolioParticipationSchema.parse(raw);
    this.checkScope(input.scope);
    const requestHash = digest({ operation: "portfolio.participation", reviewKey, input });
    const replay = this.replay<StoredPortfolioParticipation>(idempotencyKey, requestHash);
    if (replay) return replay;
    const resolved = await this.authority.resolveParticipation?.(input.sourceReceiptRef, this.scope);
    if (!resolved) throw new PortfolioAuthorityUnavailable("PARTICIPATION_RECEIPT_UNVERIFIED");
    const verified = verifiedParticipationSchema.parse(resolved);
    this.checkScope(verified.participation.scope);
    if (verified.reviewKey !== reviewKey || digest(verified.participation) !== digest(input)) throw new AgentConflict("PARTICIPATION_RECEIPT_SCOPE_MISMATCH");
    return this.transactional(() => {
      const replay = this.replay<StoredPortfolioParticipation>(idempotencyKey, requestHash);
      if (replay) return replay;
      const receipt = this.database.prepare("SELECT request_hash,body FROM portfolio_source_receipts WHERE receipt_ref=?").get(input.sourceReceiptRef);
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new AgentConflict("PARTICIPATION_RECEIPT_REUSED");
        const original = JSON.parse(String(receipt.body)) as StoredPortfolioParticipation;
        this.receipt(idempotencyKey, requestHash, original);
        return original;
      }
      const row = this.database.prepare("SELECT review_key,body FROM portfolio_decisions WHERE decision_id=?").get(input.decisionId);
      if (!row || row.review_key !== reviewKey) throw new AgentConflict("DECISION_NOT_FOUND");
      const decision = JSON.parse(String(row.body)) as StoredPortfolioDecision;
      if (decision.decision !== "approved" || !decision.handoffs.some((c) => c.creatorId === input.creatorId)) throw new AgentConflict("PARTICIPATION_NOT_APPROVED");
      const priorRow = this.database.prepare("SELECT body FROM portfolio_participation WHERE decision_id=? AND creator_id=? ORDER BY rowid DESC LIMIT 1").get(input.decisionId, input.creatorId);
      const prior = priorRow ? JSON.parse(String(priorRow.body)) as StoredPortfolioParticipation : null;
      const allowed = !prior ? ["accepted", "declined"] : prior.state === "accepted" ? ["declined", "activated"] : prior.state === "activated" || prior.state === "outcome" ? ["outcome"] : [];
      if (!allowed.includes(input.state)) throw new AgentConflict("PARTICIPATION_TRANSITION_INVALID");
      if (Date.parse(input.occurredAt) < Date.parse(prior?.occurredAt ?? decision.decidedAt)) throw new AgentConflict("PARTICIPATION_TIME_REVERSED");
      if (prior && (prior.state === "activated" || prior.state === "outcome") && digest([...prior.nextCollaborationIds].sort()) !== digest([...input.nextCollaborationIds].sort())) throw new AgentConflict("NEXT_COLLABORATION_CHANGED");
      const record = { ...input, participationId: randomUUID(), recordedAt: new Date().toISOString() };
      this.database.prepare("INSERT INTO portfolio_participation VALUES(?,?,?,?,?,?)").run(record.participationId, reviewKey, input.decisionId, input.creatorId, record.recordedAt, JSON.stringify(record));
      this.database.prepare("INSERT INTO portfolio_source_receipts VALUES(?,?,?)").run(input.sourceReceiptRef, requestHash, JSON.stringify(record));
      this.receipt(idempotencyKey, requestHash, record);
      return record;
    });
  }
}
