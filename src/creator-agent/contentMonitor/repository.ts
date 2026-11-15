import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { RuntimeError } from "../jobs/runtimeSchema.ts";
import type { J08Access, J08Category, J08Metric, J08Network, J08Page, J08Policy, J08Ref, J08Stage, J08Subject } from "./contract.ts";
import { checkpointCapture, fardaAssignment, type FardaAssignment, type OrderAttribution } from "./rules.ts";

/** A runtime error, so the registered runtime retains the exact J08 reason when it holds an item. */
export class ContentMonitorError extends RuntimeError {
  constructor(code: string, status = 409) { super(code, status); this.name = "ContentMonitorError"; }
}
type Row = Record<string, unknown>;
/** Whether the runtime committed this run item as completed. J08 never treats its own write as a committed success. */
export type Committed = (runRef: string, itemRef: string) => boolean;
const json = <T>(value: unknown) => JSON.parse(String(value)) as T;
const str = (value: unknown) => value === null || value === undefined ? null : String(value);
export const contentKeyOf = (network: string, accountId: string, postId: string) => JSON.stringify([network, accountId, postId]);
const later = (a: string, b: string | null) => b === null || Date.parse(a) > Date.parse(b);
const transient = (access: J08Access | null) => access === "throttled" || access === "unavailable";

/** Per-run, per-row J08 outcome. The runtime item state decides terminality; this records the content semantics. */
export type J08ItemOutcome = {
  subjectRef: string; windowRef: string; category: J08Category | null; access: J08Access | null; reason: string | null;
  observedAt: string | null; receipts: string[]; lastSuccessAt: string | null; pages: number; healthRoute: string | null;
};
/** The publication-to-creative mapping from the funnel ledger's verified publication record; never taken from a social source page. */
export type Creative = { creativeRef: string | null; deliverableRef: string | null; receiptRef: string | null; unmappedReason: string | null };
export type StoredContent = {
  contentKey: string; contentRef: string; subjectRef: string; network: J08Network; accountId: string; postId: string; url: string | null;
  creative: Creative | null; publishedAt: string | null; firstRun: string; firstObservedAt: string; firstReceipt: string; lastObservedAt: string;
  assignment: FardaAssignment; attribution: OrderAttribution | null; attributionReason: string | null; conflict: boolean;
};
export type StoredMetric = { seriesKey: string; seq: number; contentKey: string; metricKey: J08Metric["metricKey"]; value: number | null; unit: string;
  definition: string; semantics: "cumulative" | "interval"; windowStart: string; windowEnd: string; context: string; missingReason: string | null;
  observedAt: string; confirmedThrough: string; receiptRef: string; runRef: string };
export type StoredStatus = { contentKey: string; seq: number; state: "public" | "private" | "deleted" | "expired" | "inaccessible"; access: string;
  observedAt: string; sourceUpdatedAt: string | null; method: string; receiptRef: string; runRef: string };
export type StoredCheckpoint = { contentKey: string; checkpointsVersion: string; hours: number; state: "captured" | "late"; observedAt: string;
  actualAgeHours: number; receiptRef: string; policyVersion: string; runRef: string };
export type StoredMessage = { messageKey: string; subjectRef: string; network: J08Network; accountId: string; messageId: string; conversationId: string;
  at: string; sourceUpdatedAt: string | null; kind: "reply" | "statusChange" | "post"; direction: "inbound" | "outbound"; receiptRef: string;
  pageObservedAt: string; firstRun: string };
/** Immutable per-window proposal output. There is no J09 owner on main: nothing routes, dispatches or transitions these. */
export type StoredProposal = { windowRef: string; itemKind: "content" | "message"; itemKey: string; ref: J08Ref; reason: string; owner: "J09"; createdAt: string };
export type FrozenWatchlist = { watchlistVersion: string; windowRef: string; eligibilityPolicyVersion: string; entries: { subjectRef: string; enrollmentRef: string }[]; frozenAt: string };

/**
 * J08's own outputs on the shared scoped SQLite file, in `content_monitor_*` tables: canonical content identity, deduplicated
 * observations, lifecycle status, checkpoints, Inbox receipts, the frozen watchlist and immutable per-window proposals. Windows,
 * pages, runs, items, leases, cursors and takeovers stay in the job runtime; source health stays with J14; orders stay in the funnel
 * ledger. Every write is one `BEGIN IMMEDIATE` transaction that runs the caller's synchronous source fence after the lock is held.
 */
export class ContentMonitorRepository {
  readonly db: DatabaseSync; readonly now: () => number;
  constructor(db: DatabaseSync, scope: OperationsScope, options: { now?: () => number } = {}) {
    this.db = db; this.now = options.now ?? Date.now;
    const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
    if (!bound || bound.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId || bound.environment !== scope.environment)
      throw new ContentMonitorError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS content_monitor_subjects(subject_ref TEXT PRIMARY KEY,network TEXT NOT NULL,account_id TEXT NOT NULL,profile_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_watchlists(watchlist_version TEXT PRIMARY KEY,window_ref TEXT UNIQUE NOT NULL,eligibility_policy_version TEXT NOT NULL,
        subjects TEXT NOT NULL,frozen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_items(run_ref TEXT NOT NULL,item_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,window_ref TEXT NOT NULL,
        last_success_at TEXT,failure_at TEXT,failure_access TEXT,failure_reason TEXT,health_route TEXT,body TEXT NOT NULL,PRIMARY KEY(run_ref,item_ref));
      CREATE INDEX IF NOT EXISTS content_monitor_items_subject ON content_monitor_items(subject_ref);
      CREATE TABLE IF NOT EXISTS content_monitor_pages(receipt_ref TEXT PRIMARY KEY,run_ref TEXT NOT NULL,item_ref TEXT NOT NULL,stage TEXT NOT NULL,
        method TEXT NOT NULL,body_hash TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_content(content_key TEXT PRIMARY KEY,content_ref TEXT UNIQUE NOT NULL,subject_ref TEXT NOT NULL,
        network TEXT NOT NULL,account_id TEXT NOT NULL,post_id TEXT NOT NULL,url TEXT,creative TEXT,published_at TEXT,first_run TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,first_receipt TEXT NOT NULL,last_observed_at TEXT NOT NULL,assignment TEXT NOT NULL,attribution TEXT,
        attribution_reason TEXT,conflict INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_metrics(series_key TEXT NOT NULL,seq INTEGER NOT NULL,content_key TEXT NOT NULL,metric_key TEXT NOT NULL,
        value INTEGER,unit TEXT NOT NULL,definition TEXT NOT NULL,semantics TEXT NOT NULL,window_start TEXT NOT NULL,window_end TEXT NOT NULL,
        context TEXT NOT NULL,missing_reason TEXT,observed_at TEXT NOT NULL,confirmed_through TEXT NOT NULL,receipt_ref TEXT NOT NULL,run_ref TEXT NOT NULL,
        PRIMARY KEY(series_key,seq));
      CREATE INDEX IF NOT EXISTS content_monitor_metrics_content ON content_monitor_metrics(content_key,observed_at);
      CREATE TABLE IF NOT EXISTS content_monitor_status(content_key TEXT NOT NULL,seq INTEGER NOT NULL,state TEXT NOT NULL,access TEXT NOT NULL,
        observed_at TEXT NOT NULL,source_updated_at TEXT,method TEXT NOT NULL,receipt_ref TEXT NOT NULL,run_ref TEXT NOT NULL,PRIMARY KEY(content_key,seq));
      CREATE TABLE IF NOT EXISTS content_monitor_checkpoints(content_key TEXT NOT NULL,checkpoints_version TEXT NOT NULL,hours INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('captured','late')),observed_at TEXT NOT NULL,actual_age_hours REAL NOT NULL,receipt_ref TEXT NOT NULL,
        policy_version TEXT NOT NULL,run_ref TEXT NOT NULL,PRIMARY KEY(content_key,checkpoints_version,hours));
      CREATE TABLE IF NOT EXISTS content_monitor_inbox(message_key TEXT PRIMARY KEY,subject_ref TEXT NOT NULL,network TEXT NOT NULL,account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,at TEXT NOT NULL,source_updated_at TEXT,kind TEXT NOT NULL,direction TEXT NOT NULL,
        receipt_ref TEXT NOT NULL,page_observed_at TEXT NOT NULL,first_run TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_proposals(window_ref TEXT NOT NULL,item_kind TEXT NOT NULL,item_key TEXT NOT NULL,reason TEXT NOT NULL,
        owner TEXT NOT NULL,ref TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(window_ref,item_kind,item_key,reason));`);
  }
  private tx<T>(fence: () => void, fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { fence(); const result = fn(); fence(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Freezes the window's whole eligible watchlist once, at first admission. Later pages and refreshes read this exact snapshot. */
  freezeWatchlist(windowRef: string, eligibilityPolicyVersion: string, rows: { subject: J08Subject; enrollmentRef: string }[]): FrozenWatchlist {
    const prior = this.watchlist(windowRef);
    if (prior) {
      if (prior.eligibilityPolicyVersion !== eligibilityPolicyVersion ||
          digest(prior.entries) !== digest(rows.map(r => ({ subjectRef: r.subject.subjectRef, enrollmentRef: r.enrollmentRef }))))
        throw new ContentMonitorError("J08_WATCHLIST_ALREADY_FROZEN");
      return prior;
    }
    this.tx(() => {}, () => {
      if (this.watchlist(windowRef)) return;
      for (const { subject: s } of rows) {
        const known = this.subject(s.subjectRef);
        if (known && digest(known) !== digest(s)) throw new ContentMonitorError("J08_SUBJECT_REF_REUSED");
        if (!known) this.db.prepare("INSERT INTO content_monitor_subjects VALUES(?,?,?,?)").run(s.subjectRef, s.network, s.accountId, s.profileId);
      }
      const entries = rows.map(r => ({ subjectRef: r.subject.subjectRef, enrollmentRef: r.enrollmentRef }));
      const version = `j08-watchlist:${digest([windowRef, eligibilityPolicyVersion, entries])}`;
      this.db.prepare("INSERT INTO content_monitor_watchlists VALUES(?,?,?,?,?)").run(version, windowRef, eligibilityPolicyVersion, JSON.stringify(entries), new Date(this.now()).toISOString());
    });
    return this.watchlist(windowRef)!;
  }
  watchlist(windowRef: string): FrozenWatchlist | null {
    const r = this.db.prepare("SELECT * FROM content_monitor_watchlists WHERE window_ref=?").get(windowRef);
    return r ? { watchlistVersion: String(r.watchlist_version), windowRef, eligibilityPolicyVersion: String(r.eligibility_policy_version),
      entries: json<FrozenWatchlist["entries"]>(r.subjects), frozenAt: String(r.frozen_at) } : null;
  }
  subject(subjectRef: string): J08Subject | null {
    const r = this.db.prepare("SELECT * FROM content_monitor_subjects WHERE subject_ref=?").get(subjectRef);
    return r ? { subjectRef, network: String(r.network) as J08Network, accountId: String(r.account_id), profileId: String(r.profile_id) } : null;
  }
  outcome(runRef: string, itemRef: string): J08ItemOutcome | null {
    const r = this.db.prepare("SELECT body FROM content_monitor_items WHERE run_ref=? AND item_ref=?").get(runRef, itemRef);
    return r ? json<J08ItemOutcome>(r.body) : null;
  }
  private putOutcome(runRef: string, itemRef: string, subjectRef: string, windowRef: string, update: (prior: J08ItemOutcome) => J08ItemOutcome) {
    const prior = this.outcome(runRef, itemRef) ?? { subjectRef, windowRef, category: null, access: null, reason: null, observedAt: null, receipts: [],
      lastSuccessAt: null, pages: 0, healthRoute: null };
    if (prior.subjectRef !== subjectRef || prior.windowRef !== windowRef) throw new ContentMonitorError("J08_ITEM_SUBJECT_MISMATCH");
    const next = update(prior), failed = next.access !== null && next.access !== "authorized" && !transient(next.access);
    this.db.prepare(`INSERT INTO content_monitor_items VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_ref,item_ref) DO UPDATE SET last_success_at=excluded.last_success_at,
      failure_at=excluded.failure_at,failure_access=excluded.failure_access,failure_reason=excluded.failure_reason,health_route=excluded.health_route,body=excluded.body`)
      .run(runRef, itemRef, subjectRef, windowRef, next.lastSuccessAt, failed ? next.observedAt : null, failed ? next.access : null, failed ? next.reason : null,
        next.healthRoute, JSON.stringify(next));
  }
  /** Latest complete, healthy source watermark for this row, optionally excluding one run so a retried completion is idempotent. */
  lastSuccess(subjectRef: string, committed: Committed, excludingRun: string | null = null): string | null {
    let best: string | null = null;
    for (const r of this.successes(subjectRef, committed)) if (r.runRef !== excludingRun && later(r.at, best)) best = r.at;
    return best;
  }
  /** Every complete, healthy source watermark for this row, with the window that produced it. */
  /** A J08 success counts only when the runtime committed that item as completed. */
  successes(subjectRef: string, committed: Committed): { runRef: string; windowRef: string; at: string }[] {
    return this.db.prepare("SELECT run_ref,item_ref,window_ref,last_success_at FROM content_monitor_items WHERE subject_ref=? AND last_success_at IS NOT NULL").all(subjectRef)
      .filter(r => committed(String(r.run_ref), String(r.item_ref))).map(r => ({ runRef: String(r.run_ref), windowRef: String(r.window_ref), at: String(r.last_success_at) }));
  }
  /** Durable J14 routing outbox: failures whose source-health route is missing or was unavailable, retried idempotently on every pass. */
  unroutedFailures(limit = 200): { runRef: string; itemRef: string; subjectRef: string; windowRef: string; reason: string }[] {
    return this.db.prepare("SELECT run_ref,item_ref,subject_ref,window_ref,failure_reason FROM content_monitor_items WHERE failure_at IS NOT NULL AND (health_route IS NULL OR health_route IN ('J14_ROUTE_UNAVAILABLE','J14_NOT_COMPOSED')) ORDER BY failure_at LIMIT ?")
      .all(limit).map(r => ({ runRef: String(r.run_ref), itemRef: String(r.item_ref), subjectRef: String(r.subject_ref), windowRef: String(r.window_ref), reason: String(r.failure_reason) }));
  }
  /** The row's current access from its own source watermarks: a non-transient failure stands until a later complete, healthy read. */
  subjectAccess(subjectRef: string, committed: Committed, asOf: string | null = null): { access: J08Access; at: string } | null {
    const within = (at: string) => asOf === null || Date.parse(at) <= Date.parse(asOf);
    let failure: { access: J08Access; at: string } | null = null;
    for (const r of this.db.prepare("SELECT failure_at,failure_access FROM content_monitor_items WHERE subject_ref=? AND failure_at IS NOT NULL").all(subjectRef))
      if (within(String(r.failure_at)) && later(String(r.failure_at), failure?.at ?? null)) failure = { access: String(r.failure_access) as J08Access, at: String(r.failure_at) };
    let success: string | null = null;
    for (const r of this.successes(subjectRef, committed)) if (within(r.at) && later(r.at, success)) success = r.at;
    return failure && (success === null || Date.parse(failure.at) > Date.parse(success)) ? failure : null;
  }
  private propose(windowRef: string, itemKind: StoredProposal["itemKind"], itemKey: string, ref: J08Ref, reason: string, at: string) {
    this.db.prepare("INSERT OR IGNORE INTO content_monitor_proposals VALUES(?,?,?,?,'J09',?,?)").run(windowRef, itemKind, itemKey, reason, JSON.stringify(ref), at);
  }

  /** Persists one authorized page. Repeated observations reuse canonical identity and observation keys. */
  recordPage(input: { runRef: string; itemRef: string; windowRef: string; subject: J08Subject; stage: J08Stage; page: J08Page; campaigns: readonly string[]; policy: J08Policy;
    creativeOf: (network: string, accountId: string, postId: string) => Creative },
    fence: () => void) {
    const { runRef, itemRef, subject, page } = input;
    if (page.access !== "authorized") throw new ContentMonitorError("J08_PAGE_NOT_AUTHORIZED", 500);
    return this.tx(fence, () => {
      const pageHash = digest(page), prior = this.db.prepare("SELECT body_hash FROM content_monitor_pages WHERE receipt_ref=?").get(page.receiptRef);
      // A replayed receipt must carry identical facts; a reused receipt with different facts is never accepted.
      if (prior && prior.body_hash !== pageHash) throw new ContentMonitorError("J08_SOURCE_RECEIPT_REUSED", 502);
      if (!prior) this.db.prepare("INSERT INTO content_monitor_pages VALUES(?,?,?,?,?,?,?)").run(page.receiptRef, runRef, itemRef, input.stage, page.method, pageHash, page.observedAt);
      for (const post of page.posts) this.recordPost(input, post);
      for (const m of page.inbox) {
        const messageKey = JSON.stringify([m.ref.provider, m.ref.accountId, m.ref.sourceId]);
        if (this.db.prepare("SELECT 1 FROM content_monitor_inbox WHERE message_key=?").get(messageKey)) continue;
        this.db.prepare("INSERT INTO content_monitor_inbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(messageKey, subject.subjectRef, m.ref.provider, m.ref.accountId,
          m.ref.sourceId, m.conversationId, m.at, m.sourceUpdatedAt, m.kind, m.direction, m.receiptRef, page.observedAt, runRef);
        if (m.direction === "inbound" && m.kind === "reply") this.propose(input.windowRef, "message", messageKey, m.ref, "INBOX_REPLY_REVIEW", page.observedAt);
      }
      this.putOutcome(runRef, itemRef, subject.subjectRef, input.windowRef, o => ({ ...o, access: "authorized", reason: null,
        observedAt: later(page.observedAt, o.observedAt) ? page.observedAt : o.observedAt, receipts: [...new Set([...o.receipts, page.receiptRef])].slice(-100), pages: o.pages + 1 }));
    });
  }
  private recordPost(input: { runRef: string; windowRef: string; subject: J08Subject; page: J08Page; campaigns: readonly string[]; policy: J08Policy;
    creativeOf: (network: string, accountId: string, postId: string) => Creative },
    post: J08Page["posts"][number]) {
    const { runRef, subject, page, policy } = input, at = page.observedAt;
    const key = contentKeyOf(post.ref.provider, post.ref.accountId, post.ref.sourceId);
    const assignment = fardaAssignment(post.fardaEvidence, input.campaigns), existing = this.content(key);
    const creative = JSON.stringify(input.creativeOf(post.ref.provider, post.ref.accountId, post.ref.sourceId));
    if (!existing) {
      const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM content_monitor_content").get()!.n);
      this.db.prepare("INSERT INTO content_monitor_content VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?)").run(key, `content-${digest(key).slice(0, 32)}`,
        subject.subjectRef, post.ref.provider, post.ref.accountId, post.ref.sourceId, post.ref.url, creative,
        post.publishedAt, runRef, at, page.receiptRef, at, JSON.stringify(assignment), sequence);
      if (assignment.state === "review") this.propose(input.windowRef, "content", key, post.ref, `ATTRIBUTION_${assignment.reason}`, at);
    } else if (existing.subjectRef !== subject.subjectRef) {
      // Two watchlist profiles claim one native post: quarantine it from Farda activity and record it for review.
      if (!existing.conflict) this.propose(input.windowRef, "content", key, post.ref, "CONTENT_OWNER_CONFLICT", at);
      this.db.prepare("UPDATE content_monitor_content SET conflict=1 WHERE content_key=?").run(key);
      return;
    } else if (later(at, existing.lastObservedAt)) {
      // Identity is the native network/account/post. Only a newer page updates mutable facts; an older page never overwrites them.
      const changed = existing.assignment.state !== assignment.state || existing.assignment.campaignId !== assignment.campaignId;
      this.db.prepare("UPDATE content_monitor_content SET url=COALESCE(?,url),creative=?,published_at=COALESCE(published_at,?),assignment=?,last_observed_at=? WHERE content_key=?")
        .run(post.ref.url, creative, post.publishedAt, JSON.stringify(assignment), at, key);
      if (changed && assignment.state === "review") this.propose(input.windowRef, "content", key, post.ref, `ATTRIBUTION_${assignment.reason}`, at);
    } else return;
    if (assignment.state === "unrelated") return;
    // Lifecycle is ordered by the page's own observation time; sourceUpdatedAt is kept as data only.
    const current = this.latestStatus(key), state = post.access === "authorized" ? post.visibility! : "inaccessible";
    if (!current || (current.state !== state || current.access !== post.access) && later(at, current.observedAt)) {
      this.db.prepare("INSERT INTO content_monitor_status VALUES(?,?,?,?,?,?,?,?,?)").run(key, (current?.seq ?? 0) + 1, state, post.access, at,
        post.sourceUpdatedAt, page.method, page.receiptRef, runRef);
      if (["private", "deleted", "expired"].includes(state)) this.propose(input.windowRef, "content", key, post.ref, `CONTENT_${state.toUpperCase()}`, at);
    }
    if (post.access !== "authorized") return;
    for (const m of post.metrics) {
      const seriesKey = digest([key, m.metricKey, m.definition, m.semantics, m.unit, m.window.start, m.semantics === "interval" ? m.window.end : null]);
      const last = this.db.prepare("SELECT * FROM content_monitor_metrics WHERE series_key=? ORDER BY seq DESC LIMIT 1").get(seriesKey);
      if (last && (last.value === null ? null : Number(last.value)) === m.value && str(last.missing_reason) === m.missingReason) {
        // Unchanged counters are a confirmation, not another snapshot or delta.
        if (later(at, String(last.confirmed_through))) this.db.prepare("UPDATE content_monitor_metrics SET confirmed_through=? WHERE series_key=? AND seq=?").run(at, seriesKey, Number(last.seq));
        continue;
      }
      if (last && !later(at, String(last.observed_at))) continue;
      this.db.prepare("INSERT INTO content_monitor_metrics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(seriesKey, Number(last?.seq ?? 0) + 1, key, m.metricKey,
        m.value, m.unit, m.definition, m.semantics, m.window.start, m.window.end, post.context, m.missingReason, at, at, page.receiptRef, runRef);
    }
    const publishedAt = post.publishedAt ?? existing?.publishedAt ?? null;
    if (post.metrics.length) {
      const recorded = this.checkpoints(key).filter(c => c.checkpointsVersion === policy.checkpoints.version).map(c => c.hours);
      const capture = checkpointCapture(publishedAt, at, policy.checkpoints.slots, recorded);
      if (capture) this.db.prepare("INSERT OR IGNORE INTO content_monitor_checkpoints VALUES(?,?,?,?,?,?,?,?,?)").run(key, policy.checkpoints.version, capture.hours,
        capture.state, at, capture.actualAgeHours, page.receiptRef, policy.version, runRef);
    }
  }

  /** Access failures preserve the checkpoint and prior confirmed receipts. Source health is J14's; takeovers are the runtime's. */
  recordAccessFailure(input: { runRef: string; itemRef: string; windowRef: string; subject: J08Subject; page: J08Page }, fence: () => void) {
    const { runRef, itemRef, subject, page } = input;
    const category: J08Category | null = transient(page.access) ? null : page.access === "uiDrift" ? "failed" : "inaccessible";
    const reason = `SOURCE_${page.access.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
    this.tx(fence, () => this.putOutcome(runRef, itemRef, subject.subjectRef, input.windowRef, o => ({ ...o, category, access: page.access, reason,
      observedAt: later(page.observedAt, o.observedAt) ? page.observedAt : o.observedAt, receipts: [...new Set([...o.receipts, page.receiptRef])].slice(-100) })));
    return { reason, category };
  }
  noteHealthRoute(runRef: string, itemRef: string, subjectRef: string, windowRef: string, route: string) {
    // Recorded after J14 answered; the failure itself was already persisted, so a crash before this point is replayed by the outbox.
    this.tx(() => {}, () => this.putOutcome(runRef, itemRef, subjectRef, windowRef, o => ({ ...o, healthRoute: route })));
  }

  /**
   * Completes a row after both stages read completely. New content is anything first observed after the row's previous complete
   * success, so content seen during a failed run is never swallowed. Retrying the same completion gives the same result.
   */
  finishItem(input: { runRef: string; itemRef: string; windowRef: string; subject: J08Subject; committed: Committed;
    attributions: Map<string, { attribution: OrderAttribution | null; reason: string }> }, fence: () => void) {
    const { runRef, itemRef, subject } = input;
    return this.tx(fence, () => {
      const outcome = this.outcome(runRef, itemRef);
      if (!outcome?.observedAt || outcome.access !== "authorized") throw new ContentMonitorError("J08_ITEM_INCOMPLETE", 500);
      for (const [key, result] of input.attributions)
        this.db.prepare("UPDATE content_monitor_content SET attribution=?,attribution_reason=? WHERE content_key=?").run(result.attribution ? JSON.stringify(result.attribution) : null, result.reason, key);
      const baseline = this.lastSuccess(subject.subjectRef, input.committed, runRef), after = baseline ?? "";
      const fresh = Number(this.db.prepare("SELECT COUNT(*) AS n FROM content_monitor_content WHERE subject_ref=? AND (?='' OR first_observed_at>?)").get(subject.subjectRef, after, after)!.n) +
        Number(this.db.prepare("SELECT COUNT(*) AS n FROM content_monitor_inbox WHERE subject_ref=? AND (?='' OR page_observed_at>?)").get(subject.subjectRef, after, after)!.n);
      const category: J08Category = fresh ? "newContent" : "unchanged";
      this.putOutcome(runRef, itemRef, subject.subjectRef, input.windowRef, o => ({ ...o, category, reason: null, lastSuccessAt: outcome.observedAt }));
      return category;
    });
  }

  private contentFrom(r: Row): StoredContent {
    return { contentKey: String(r.content_key), contentRef: String(r.content_ref), subjectRef: String(r.subject_ref), network: String(r.network) as J08Network,
      accountId: String(r.account_id), postId: String(r.post_id), url: str(r.url), creative: r.creative === null ? null : json<Creative>(r.creative),
      publishedAt: str(r.published_at), firstRun: String(r.first_run), firstObservedAt: String(r.first_observed_at), firstReceipt: String(r.first_receipt),
      lastObservedAt: String(r.last_observed_at), assignment: json<FardaAssignment>(r.assignment), attribution: r.attribution === null ? null : json<OrderAttribution>(r.attribution),
      attributionReason: str(r.attribution_reason), conflict: Boolean(r.conflict) };
  }
  content(contentKey: string): StoredContent | null {
    const r = this.db.prepare("SELECT * FROM content_monitor_content WHERE content_key=?").get(contentKey);
    return r ? this.contentFrom(r) : null;
  }
  allContent(): StoredContent[] { return this.db.prepare("SELECT * FROM content_monitor_content ORDER BY sequence").all().map(r => this.contentFrom(r)); }
  subjectContent(subjectRef: string): StoredContent[] {
    return this.db.prepare("SELECT * FROM content_monitor_content WHERE subject_ref=? ORDER BY sequence").all(subjectRef).map(r => this.contentFrom(r));
  }
  metrics(contentKey: string): StoredMetric[] {
    return this.db.prepare("SELECT * FROM content_monitor_metrics WHERE content_key=? ORDER BY observed_at,metric_key,seq").all(contentKey).map(r => ({
      seriesKey: String(r.series_key), seq: Number(r.seq), contentKey, metricKey: String(r.metric_key) as StoredMetric["metricKey"], value: r.value === null ? null : Number(r.value),
      unit: String(r.unit), definition: String(r.definition), semantics: String(r.semantics) as StoredMetric["semantics"], windowStart: String(r.window_start), windowEnd: String(r.window_end),
      context: String(r.context), missingReason: str(r.missing_reason), observedAt: String(r.observed_at), confirmedThrough: String(r.confirmed_through),
      receiptRef: String(r.receipt_ref), runRef: String(r.run_ref) }));
  }
  latestStatus(contentKey: string, asOf: string | null = null): StoredStatus | null {
    return this.status(contentKey).filter(s => asOf === null || Date.parse(s.observedAt) <= Date.parse(asOf)).at(-1) ?? null;
  }
  status(contentKey: string): StoredStatus[] {
    return this.db.prepare("SELECT * FROM content_monitor_status WHERE content_key=? ORDER BY seq").all(contentKey).map(r => ({ contentKey, seq: Number(r.seq),
      state: String(r.state) as StoredStatus["state"], access: String(r.access), observedAt: String(r.observed_at), sourceUpdatedAt: str(r.source_updated_at),
      method: String(r.method), receiptRef: String(r.receipt_ref), runRef: String(r.run_ref) }));
  }
  checkpoints(contentKey: string): StoredCheckpoint[] {
    return this.db.prepare("SELECT * FROM content_monitor_checkpoints WHERE content_key=? ORDER BY hours").all(contentKey).map(r => ({ contentKey,
      checkpointsVersion: String(r.checkpoints_version), hours: Number(r.hours), state: String(r.state) as StoredCheckpoint["state"], observedAt: String(r.observed_at),
      actualAgeHours: Number(r.actual_age_hours), receiptRef: String(r.receipt_ref), policyVersion: String(r.policy_version), runRef: String(r.run_ref) }));
  }
  messages(firstRuns?: readonly string[]): StoredMessage[] {
    return this.db.prepare("SELECT * FROM content_monitor_inbox ORDER BY at,message_key").all().filter(r => !firstRuns || firstRuns.includes(String(r.first_run))).map(r => ({
      messageKey: String(r.message_key), subjectRef: String(r.subject_ref), network: String(r.network) as J08Network, accountId: String(r.account_id),
      messageId: String(r.message_id), conversationId: String(r.conversation_id), at: String(r.at), sourceUpdatedAt: str(r.source_updated_at),
      kind: String(r.kind) as StoredMessage["kind"], direction: String(r.direction) as StoredMessage["direction"], receiptRef: String(r.receipt_ref),
      pageObservedAt: String(r.page_observed_at), firstRun: String(r.first_run) }));
  }
  proposals(windowRef?: string): StoredProposal[] {
    return (windowRef ? this.db.prepare("SELECT * FROM content_monitor_proposals WHERE window_ref=? ORDER BY created_at,item_key").all(windowRef)
      : this.db.prepare("SELECT * FROM content_monitor_proposals ORDER BY created_at,item_key").all()).map(r => ({ windowRef: String(r.window_ref),
      itemKind: String(r.item_kind) as StoredProposal["itemKind"], itemKey: String(r.item_key), reason: String(r.reason), owner: "J09" as const,
      ref: json<J08Ref>(r.ref), createdAt: String(r.created_at) }));
  }
  pageMethod(receiptRef: string): string | null { return str(this.db.prepare("SELECT method FROM content_monitor_pages WHERE receipt_ref=?").get(receiptRef)?.method); }
}
