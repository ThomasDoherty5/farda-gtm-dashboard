import type { DatabaseSync } from "node:sqlite";
import { digest } from "./config.ts";
import {
  FUNNEL_VERSION,
  funnelEnvelopeSchema,
  funnelFilterSchema,
  type FunnelEnvelope,
  type FunnelEvent,
  type FunnelFilters,
} from "./funnelContract.ts";
import { projectFunnel } from "./funnelProjection.ts";

type Scope = { workspaceId: string; accountId: string };
export class FunnelError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
/** Trusted server-side resolver of the independently retained producer receipt. A reviewer token is insufficient evidence. */
export type FunnelAuthority = {
  resolve: (
    scope: Scope,
    request: Pick<FunnelEnvelope, "jobId" | "jobVersion" | "correlationId" | "actor" | "mode">,
    provenanceRef: string,
  ) => Promise<{ eventHash: string; workspaceId: string; accountId: string } | null>;
};
const NULL_AUTHORITY: FunnelAuthority = { resolve: async () => null };
const RECEIPT_LIMIT = 2000;
const rowReceipt = (id: string, replayed: boolean) => ({
  storedEventRef: id,
  projectionVersion: FUNNEL_VERSION,
  replayed,
});
function eventContext(event: FunnelEvent) {
  return digest({
    cohort: event.campaignCohortRef.canonicalId ?? event.campaignCohortRef.sourceId,
    cohortStart: Date.parse(event.cohortStart),
    route: event.route,
  });
}
function checkIdentity(previous: FunnelEvent, next: FunnelEvent, history: FunnelEvent[]) {
  const before = previous.creatorRef,
    after = next.creatorRef;
  if (before.canonicalId && after.canonicalId && before.canonicalId !== after.canonicalId)
    throw new FunnelError("FUNNEL_IDENTITY_CONFLICT", 409);
  const sameNative = before.source === after.source && !!before.sourceId && before.sourceId === after.sourceId;
  if ((before.canonicalId && before.canonicalId === after.canonicalId) || sameNative) return;
  // A verified bridge is required before identities from two different provider accounts can be joined.
  const unresolved = before.canonicalId ? next : previous;
  const resolved = before.canonicalId ? previous : next;
  const bridge = [resolved, next, ...history]
    .map((e) => e.details.identityCrosswalk)
    .find(
      (b) =>
        b &&
        b.canonicalId === resolved.creatorRef.canonicalId &&
        b.fromSource === unresolved.creatorRef.source &&
        b.fromId === (unresolved.creatorRef.sourceId ?? unresolved.ingestIdentity.fingerprint),
    );
  if (
    !bridge ||
    bridge.canonicalId !== resolved.creatorRef.canonicalId ||
    bridge.fromSource !== unresolved.creatorRef.source ||
    bridge.fromId !== (unresolved.creatorRef.sourceId ?? unresolved.ingestIdentity.fingerprint)
  )
    throw new FunnelError("FUNNEL_IDENTITY_CROSSWALK_REQUIRED", 409);
}
function sourceKey(e: FunnelEvent) {
  return digest([
    e.sourceAccount.source,
    e.sourceAccount.accountId,
    e.sourceAccount.sourceId,
    e.eventType,
    e.ingestIdentity.nativeId ? "native" : "crosswalk",
    e.ingestIdentity.nativeId ?? e.ingestIdentity.fingerprint,
    e.ingestIdentity.sourceVersion,
    e.opportunityId,
  ]);
}
function replayHash(e: FunnelEvent) {
  // Another sync may observe the same native revision later under a different transport ID.
  return digest(Object.fromEntries(Object.entries(e).filter(([key]) => key !== "eventId" && key !== "observedAt")));
}
export class FunnelRepository {
  private readonly db: DatabaseSync;
  private readonly scope: Scope;
  private readonly authority: FunnelAuthority;
  private readonly now: () => Date;
  constructor(
    db: DatabaseSync,
    scope: Scope,
    authority: FunnelAuthority = NULL_AUTHORITY,
    now: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.scope = scope;
    this.authority = authority;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS funnel_events_v1 (
      seq INTEGER PRIMARY KEY, workspace TEXT NOT NULL, account TEXT NOT NULL,
      event_id TEXT NOT NULL, native_key TEXT NOT NULL, opportunity TEXT NOT NULL, context_hash TEXT NOT NULL,
      cohort_start INTEGER NOT NULL, recorded_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, corrects TEXT,
      event_hash TEXT NOT NULL, fact_hash TEXT NOT NULL, body TEXT NOT NULL, envelope TEXT NOT NULL,
      UNIQUE(workspace,account,event_id), UNIQUE(workspace,account,native_key), UNIQUE(workspace,account,corrects));
      CREATE INDEX IF NOT EXISTS funnel_events_scope ON funnel_events_v1(workspace,account,cohort_start,opportunity,recorded_at);
      CREATE TABLE IF NOT EXISTS funnel_replays_v1(workspace TEXT NOT NULL, account TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(workspace,account,key));
    `);
  }
  private replay(key: string, hash: string) {
    const row = this.db
      .prepare("SELECT hash,event_id FROM funnel_replays_v1 WHERE workspace=? AND account=? AND key=?")
      .get(this.scope.workspaceId, this.scope.accountId, key);
    if (!row) return null;
    if (row.hash !== hash) throw new FunnelError("FUNNEL_KEY_CONFLICT", 409);
    return rowReceipt(String(row.event_id), true);
  }
  async ingest(raw: unknown) {
    const env = funnelEnvelopeSchema.parse(raw),
      e = env.event;
    if (
      env.accountRef.accountId !== this.scope.accountId ||
      [
        e.sourceAccount,
        e.creatorRef,
        e.campaignCohortRef,
        e.relationshipRef,
        e.collaborationRef,
        e.acquisitionRef,
      ].some((ref) => ref && ref.accountId !== this.scope.accountId)
    )
      throw new FunnelError("FUNNEL_SCOPE_MISMATCH", 403);
    const hash = digest(e);
    if (env.inputHash !== hash || env.policyVersion !== e.policyOfferApprovalVersions.policy)
      throw new FunnelError("FUNNEL_BINDING_INVALID", 400);
    if (!!e.correctsEventId && env.mode !== "reconcile") throw new FunnelError("FUNNEL_CORRECTION_MODE_REQUIRED", 400);
    const previous = this.replay(env.idempotencyKey, hash);
    if (previous) return previous;
    const checkedAt = this.now().getTime();
    if (
      Date.parse(env.requestedAt) > checkedAt ||
      Date.parse(e.observedAt) > checkedAt ||
      (env.deadline && Date.parse(env.deadline) < checkedAt)
    )
      throw new FunnelError("FUNNEL_TIME_INVALID", 409);
    const proof = await this.authority.resolve(this.scope, env, e.evidenceRef.provenanceRef);
    if (
      !proof ||
      proof.workspaceId !== this.scope.workspaceId ||
      proof.accountId !== this.scope.accountId ||
      proof.eventHash !== hash
    )
      throw new FunnelError("FUNNEL_PRODUCER_RECEIPT_REQUIRED", 403);
    const scopeArgs = [this.scope.workspaceId, this.scope.accountId];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let receipt = this.replay(env.idempotencyKey, hash);
      if (!receipt) {
        const key = sourceKey(e),
          factHash = replayHash(e),
          context = eventContext(e);
        const byId = this.db
          .prepare(
            "SELECT event_id,event_hash,native_key FROM funnel_events_v1 WHERE workspace=? AND account=? AND event_id=?",
          )
          .get(...scopeArgs, e.eventId);
        if (byId && (byId.event_hash !== hash || byId.native_key !== key))
          throw new FunnelError("FUNNEL_EVENT_CONFLICT", 409);
        const bySource = this.db
          .prepare("SELECT event_id,fact_hash FROM funnel_events_v1 WHERE workspace=? AND account=? AND native_key=?")
          .get(...scopeArgs, key);
        if (bySource && bySource.fact_hash !== factHash) throw new FunnelError("FUNNEL_SOURCE_CONFLICT", 409);
        if (bySource) receipt = rowReceipt(String(bySource.event_id), true);
        else {
          const anchors = this.db
            .prepare(
              "SELECT context_hash,body FROM funnel_events_v1 WHERE workspace=? AND account=? AND opportunity=? ORDER BY seq",
            )
            .all(...scopeArgs, e.opportunityId);
          const history = anchors.map((anchor) => JSON.parse(String(anchor.body)) as FunnelEvent);
          for (const [index, anchor] of anchors.entries()) {
            if (anchor.context_hash !== context) throw new FunnelError("FUNNEL_OPPORTUNITY_CONTEXT_CHANGED", 409);
            const prior = history[index]!;
            checkIdentity(prior, e, history);
            if (
              prior.acquisitionRef &&
              e.acquisitionRef &&
              (prior.acquisitionRef.source !== e.acquisitionRef.source ||
                prior.acquisitionRef.sourceId !== e.acquisitionRef.sourceId)
            )
              throw new FunnelError("FUNNEL_ACQUISITION_CONTEXT_CHANGED", 409);
          }
          if (e.correctsEventId) {
            const target = this.db
              .prepare("SELECT opportunity,body FROM funnel_events_v1 WHERE workspace=? AND account=? AND event_id=?")
              .get(...scopeArgs, e.correctsEventId);
            const replaced = this.db
              .prepare("SELECT event_id FROM funnel_events_v1 WHERE workspace=? AND account=? AND corrects=?")
              .get(...scopeArgs, e.correctsEventId);
            if (!target || target.opportunity !== e.opportunityId || replaced)
              throw new FunnelError("FUNNEL_CORRECTION_CONFLICT", 409);
            const prior = JSON.parse(String(target.body)) as FunnelEvent;
            const priorIdentity = prior.ingestIdentity.nativeId ?? prior.ingestIdentity.fingerprint;
            const replacementIdentity = e.ingestIdentity.nativeId ?? e.ingestIdentity.fingerprint;
            if (
              prior.eventType !== e.eventType ||
              priorIdentity !== replacementIdentity ||
              prior.sourceAccount.source !== e.sourceAccount.source ||
              prior.sourceAccount.sourceId !== e.sourceAccount.sourceId ||
              prior.details.orderId !== e.details.orderId ||
              prior.details.postId !== e.details.postId ||
              Date.parse(prior.observedAt) > Date.parse(e.observedAt)
            )
              throw new FunnelError("FUNNEL_CORRECTION_MISMATCH", 409);
          }
          this.db
            .prepare(
              "INSERT INTO funnel_events_v1(workspace,account,event_id,native_key,opportunity,context_hash,cohort_start,recorded_at,observed_at,corrects,event_hash,fact_hash,body,envelope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              ...scopeArgs,
              e.eventId,
              key,
              e.opportunityId,
              context,
              Date.parse(e.cohortStart),
              this.now().getTime(),
              Date.parse(e.observedAt),
              e.correctsEventId,
              hash,
              factHash,
              JSON.stringify(e),
              JSON.stringify({ ...env, event: undefined }),
            );
          receipt = rowReceipt(e.eventId, false);
        }
        this.db
          .prepare("INSERT INTO funnel_replays_v1 VALUES(?,?,?,?,?)")
          .run(...scopeArgs, env.idempotencyKey, hash, receipt.storedEventRef);
      }
      this.db.exec("COMMIT");
      return receipt;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  read(raw: FunnelFilters | unknown = {}) {
    return this.snapshot(raw).projection;
  }
  /** The dashboard uses the same corrected events and current-stage engine with a fixed insertion watermark for pagination. */
  snapshot(raw: FunnelFilters | unknown = {}, watermark?: number) {
    const f = funnelFilterSchema.parse(raw),
      now = this.now().getTime(),
      asOf = f.asOf ?? new Date(now).toISOString(),
      until = Date.parse(asOf);
    if (until > now) throw new FunnelError("FUNNEL_FUTURE_SNAPSHOT", 400);
    const head = Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS head FROM funnel_events_v1 WHERE workspace=? AND account=?")
      .get(this.scope.workspaceId, this.scope.accountId)!.head);
    const bound = watermark ?? head;
    if (!Number.isSafeInteger(bound) || bound < 0 || bound > head) throw new FunnelError("FUNNEL_INVALID_WATERMARK", 400);
    const clauses = ["workspace=?", "account=?", "recorded_at<=?", "observed_at<=?", "cohort_start<=?", "seq<=?"],
      params: (string | number)[] = [this.scope.workspaceId, this.scope.accountId, until, until, until, bound];
    if (f.start) {
      clauses.push("cohort_start>=?");
      params.push(Date.parse(f.start));
    }
    if (f.end) {
      clauses.push("cohort_start<?");
      params.push(Date.parse(f.end));
    }
    if (f.opportunity) {
      clauses.push("opportunity=?");
      params.push(f.opportunity);
    }
    const rows = this.db
      .prepare("SELECT body FROM funnel_events_v1 WHERE " + clauses.join(" AND ") + " ORDER BY seq LIMIT ?")
      .all(...params, RECEIPT_LIMIT + 1);
    if (rows.length > RECEIPT_LIMIT) throw new FunnelError("FUNNEL_NARROW_COHORT_WINDOW", 422);
    const events = rows.map(row => JSON.parse(String(row.body)) as FunnelEvent);
    return { events, watermark: bound, projection: projectFunnel(events, f, new Date(until).toISOString()) };
  }
}
