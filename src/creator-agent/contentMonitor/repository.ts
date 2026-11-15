import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { RuntimeError, type RuntimeWindow } from "../jobs/runtimeSchema.ts";
import type { J08Access, J08Category, J08Metric, J08Network, J08Page, J08Policy, J08Stage, J08Subject } from "./contract.ts";
import { checkpointCapture, fardaAssignment, type FardaAssignment, type OrderAttribution } from "./rules.ts";

/** A runtime error, so the registered runtime retains the exact J08 reason when it holds an item. */
export class ContentMonitorError extends RuntimeError {
  constructor(code: string, status = 409) { super(code, status); this.name = "ContentMonitorError"; }
}
type Row = Record<string, unknown>;
const json = <T>(value: unknown) => JSON.parse(String(value)) as T;
const str = (value: unknown) => value === null || value === undefined ? null : String(value);
export const contentKeyOf = (network: string, accountId: string, postId: string) => JSON.stringify([network, accountId, postId]);
const later = (a: string, b: string | null) => b === null || Date.parse(a) > Date.parse(b);

/** Per-run, per-row J08 outcome. The runtime item state decides terminality; this records the content semantics. */
export type J08ItemOutcome = {
  subjectRef: string; category: J08Category | null; access: J08Access | null; reason: string | null; owner: "J09" | "J14" | null;
  observedAt: string | null; receipts: string[]; lastSuccessAt: string | null; pages: number;
};
export type StoredContent = {
  contentKey: string; contentRef: string; creatorId: string; subjectRef: string; network: J08Network; accountId: string; postId: string;
  url: string | null; creativeRef: string | null; role: "original" | "crosspost"; publishedAt: string | null; firstRun: string; firstObservedAt: string;
  firstReceipt: string; assignment: FardaAssignment; attribution: OrderAttribution | null; attributionReason: string | null; conflict: boolean;
};
export type StoredMetric = { seriesKey: string; seq: number; contentKey: string; metricKey: J08Metric["metricKey"]; value: number | null; unit: string;
  definition: string; semantics: "cumulative" | "interval"; windowStart: string; windowEnd: string; context: string; missingReason: string | null;
  observedAt: string; confirmedThrough: string; receiptRef: string; runRef: string };
export type StoredStatus = { contentKey: string; seq: number; state: "public" | "private" | "deleted" | "expired" | "inaccessible"; access: string;
  sourceAt: string; receiptRef: string; runRef: string };
export type StoredCheckpoint = { contentKey: string; checkpointsVersion: string; hours: number; observedAt: string; actualAgeHours: number;
  receiptRef: string; policyVersion: string; runRef: string };
export type StoredMessage = { messageKey: string; subjectRef: string; network: J08Network; accountId: string; messageId: string; conversationId: string;
  at: string; kind: "reply" | "statusChange" | "post"; direction: "inbound" | "outbound"; receiptRef: string; pageObservedAt: string; firstRun: string };
export type StoredIncident = { incidentKey: string; subjectRef: string; contentKey: string | null; reason: string; owner: "J14";
  state: "open" | "closed"; openedRun: string; openedAt: string; closedRun: string | null; closedAt: string | null; closedReceipt: string | null };
export type StoredAction = { actionKey: string; itemKind: "content" | "message" | "subject"; itemKey: string; reason: string; owner: "J09" | "J14";
  firstRun: string; lastRun: string; state: "proposed" | "resolvedByObservation" };
export type StoredRun = { runRef: string; windowRef: string; intendedAt: string; windowStart: string; windowEnd: string; registrationVersion: number };

/**
 * J08's own outputs on the shared scoped SQLite file, in `content_monitor_*` tables: canonical content identity, deduplicated
 * observations, lifecycle status, checkpoints, Inbox receipts, incidents and proposal-only next actions. Orders, membership, runs,
 * leases and checkpoints keep their existing owners. Every write is one `BEGIN IMMEDIATE` transaction that runs the caller's
 * synchronous source fence after the lock is held.
 */
export class ContentMonitorRepository {
  readonly db: DatabaseSync; readonly now: () => number;
  constructor(db: DatabaseSync, scope: OperationsScope, options: { now?: () => number } = {}) {
    this.db = db; this.now = options.now ?? Date.now;
    const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
    if (!bound || bound.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId || bound.environment !== scope.environment)
      throw new ContentMonitorError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS content_monitor_subjects(subject_ref TEXT PRIMARY KEY,creator_id TEXT NOT NULL,network TEXT NOT NULL,
        account_id TEXT NOT NULL,profile_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_runs(run_ref TEXT PRIMARY KEY,window_ref TEXT NOT NULL,intended_at TEXT NOT NULL,window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,registration_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_items(run_ref TEXT NOT NULL,item_ref TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_ref,item_ref));
      CREATE TABLE IF NOT EXISTS content_monitor_cursors(cursor_ref TEXT PRIMARY KEY,run_ref TEXT NOT NULL,item_ref TEXT NOT NULL,stage TEXT NOT NULL,source_cursor TEXT);
      CREATE TABLE IF NOT EXISTS content_monitor_pages(receipt_ref TEXT PRIMARY KEY,run_ref TEXT NOT NULL,item_ref TEXT NOT NULL,stage TEXT NOT NULL,
        body_hash TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_content(content_key TEXT PRIMARY KEY,content_ref TEXT UNIQUE NOT NULL,creator_id TEXT NOT NULL,
        subject_ref TEXT NOT NULL,network TEXT NOT NULL,account_id TEXT NOT NULL,post_id TEXT NOT NULL,url TEXT,creative_ref TEXT,published_at TEXT,
        first_run TEXT NOT NULL,first_observed_at TEXT NOT NULL,first_receipt TEXT NOT NULL,assignment TEXT NOT NULL,attribution TEXT,
        attribution_reason TEXT,conflict INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_metrics(series_key TEXT NOT NULL,seq INTEGER NOT NULL,content_key TEXT NOT NULL,metric_key TEXT NOT NULL,
        value INTEGER,unit TEXT NOT NULL,definition TEXT NOT NULL,semantics TEXT NOT NULL,window_start TEXT NOT NULL,window_end TEXT NOT NULL,
        context TEXT NOT NULL,missing_reason TEXT,observed_at TEXT NOT NULL,confirmed_through TEXT NOT NULL,receipt_ref TEXT NOT NULL,run_ref TEXT NOT NULL,
        PRIMARY KEY(series_key,seq));
      CREATE INDEX IF NOT EXISTS content_monitor_metrics_content ON content_monitor_metrics(content_key,observed_at);
      CREATE TABLE IF NOT EXISTS content_monitor_status(content_key TEXT NOT NULL,seq INTEGER NOT NULL,state TEXT NOT NULL,access TEXT NOT NULL,
        source_at TEXT NOT NULL,receipt_ref TEXT NOT NULL,run_ref TEXT NOT NULL,PRIMARY KEY(content_key,seq));
      CREATE TABLE IF NOT EXISTS content_monitor_checkpoints(content_key TEXT NOT NULL,checkpoints_version TEXT NOT NULL,hours INTEGER NOT NULL,
        observed_at TEXT NOT NULL,actual_age_hours REAL NOT NULL,receipt_ref TEXT NOT NULL,policy_version TEXT NOT NULL,run_ref TEXT NOT NULL,
        PRIMARY KEY(content_key,checkpoints_version,hours));
      CREATE TABLE IF NOT EXISTS content_monitor_inbox(message_key TEXT PRIMARY KEY,subject_ref TEXT NOT NULL,network TEXT NOT NULL,account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,direction TEXT NOT NULL,receipt_ref TEXT NOT NULL,
        page_observed_at TEXT NOT NULL,first_run TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_incidents(incident_key TEXT PRIMARY KEY,subject_ref TEXT NOT NULL,content_key TEXT,reason TEXT NOT NULL,
        owner TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','closed')),opened_run TEXT NOT NULL,opened_at TEXT NOT NULL,closed_run TEXT,
        closed_at TEXT,closed_receipt TEXT);
      CREATE TABLE IF NOT EXISTS content_monitor_actions(action_key TEXT PRIMARY KEY,item_kind TEXT NOT NULL,item_key TEXT NOT NULL,reason TEXT NOT NULL,
        owner TEXT NOT NULL,first_run TEXT NOT NULL,last_run TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_monitor_plans(window_ref TEXT NOT NULL,continuation TEXT NOT NULL,intended_at TEXT NOT NULL,coverage TEXT NOT NULL,
        body TEXT NOT NULL,PRIMARY KEY(window_ref,continuation));
      CREATE TABLE IF NOT EXISTS content_monitor_success(subject_ref TEXT PRIMARY KEY,last_success_at TEXT NOT NULL,receipt_ref TEXT NOT NULL,run_ref TEXT NOT NULL);`);
  }
  private tx<T>(fence: () => void, fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { fence(); const result = fn(); fence(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  saveSubjects(subjects: J08Subject[]) {
    this.tx(() => {}, () => {
      for (const s of subjects) {
        const prior = this.subject(s.subjectRef);
        if (prior && digest(prior) !== digest(s)) throw new ContentMonitorError("J08_SUBJECT_REF_REUSED");
        if (!prior) this.db.prepare("INSERT INTO content_monitor_subjects VALUES(?,?,?,?,?)").run(s.subjectRef, s.creatorId, s.network, s.accountId, s.profileId);
      }
    });
  }
  subject(subjectRef: string): J08Subject | null {
    const r = this.db.prepare("SELECT * FROM content_monitor_subjects WHERE subject_ref=?").get(subjectRef);
    return r ? { subjectRef, creatorId: String(r.creator_id), network: String(r.network) as J08Network, accountId: String(r.account_id), profileId: String(r.profile_id) } : null;
  }
  noteRun(runRef: string, window: RuntimeWindow) {
    const prior = this.run(runRef);
    if (prior && prior.windowRef !== window.windowRef) throw new ContentMonitorError("J08_RUN_WINDOW_MISMATCH");
    if (!prior) this.db.prepare("INSERT OR IGNORE INTO content_monitor_runs VALUES(?,?,?,?,?,?)")
      .run(runRef, window.windowRef, window.intendedAt, window.windowStart, window.windowEnd, window.registrationVersion);
  }
  run(runRef: string): StoredRun | null {
    const r = this.db.prepare("SELECT * FROM content_monitor_runs WHERE run_ref=?").get(runRef);
    return r ? { runRef, windowRef: String(r.window_ref), intendedAt: String(r.intended_at), windowStart: String(r.window_start),
      windowEnd: String(r.window_end), registrationVersion: Number(r.registration_version) } : null;
  }
  runs(limit = 24): StoredRun[] {
    return this.db.prepare("SELECT run_ref FROM content_monitor_runs ORDER BY intended_at DESC,run_ref LIMIT ?").all(limit).map(r => this.run(String(r.run_ref))!);
  }
  /** Freezes one finite watchlist page for a window. A refresh returns the same frozen facts; later membership changes act per item. */
  freezePlan<T extends { coverage: "complete" | "partial" }>(window: RuntimeWindow, continuation: string | null, compute: () => T): T {
    const prior = this.db.prepare("SELECT body FROM content_monitor_plans WHERE window_ref=? AND continuation=?").get(window.windowRef, continuation ?? "");
    if (prior) return json<T>(prior.body);
    const plan = compute();
    this.db.prepare("INSERT OR IGNORE INTO content_monitor_plans VALUES(?,?,?,?,?)").run(window.windowRef, continuation ?? "", window.intendedAt, plan.coverage, JSON.stringify(plan));
    return json<T>(this.db.prepare("SELECT body FROM content_monitor_plans WHERE window_ref=? AND continuation=?").get(window.windowRef, continuation ?? "")!.body);
  }
  /** A window is completely planned only when every recorded page of its membership was complete. */
  planComplete(windowRef: string) {
    const rows = this.db.prepare("SELECT coverage FROM content_monitor_plans WHERE window_ref=?").all(windowRef);
    return rows.length > 0 && rows.every(r => r.coverage === "complete");
  }
  /** The newest planned window, admitted or not; a newer unvisited window keeps the projection partial. */
  latestPlannedAt(): string | null {
    return str(this.db.prepare("SELECT MAX(intended_at) AS at FROM content_monitor_plans").get()?.at);
  }
  saveCursor(runRef: string, itemRef: string, stage: J08Stage, sourceCursor: string | null) {
    const cursorRef = `j08-cursor:${digest([runRef, itemRef, stage, sourceCursor])}`;
    this.db.prepare("INSERT OR IGNORE INTO content_monitor_cursors VALUES(?,?,?,?,?)").run(cursorRef, runRef, itemRef, stage, sourceCursor);
    return cursorRef;
  }
  cursor(cursorRef: string) {
    const r = this.db.prepare("SELECT * FROM content_monitor_cursors WHERE cursor_ref=?").get(cursorRef);
    return r ? { runRef: String(r.run_ref), itemRef: String(r.item_ref), stage: String(r.stage) as J08Stage, sourceCursor: str(r.source_cursor) } : null;
  }
  outcome(runRef: string, itemRef: string): J08ItemOutcome | null {
    const r = this.db.prepare("SELECT body FROM content_monitor_items WHERE run_ref=? AND item_ref=?").get(runRef, itemRef);
    return r ? json<J08ItemOutcome>(r.body) : null;
  }
  private putOutcome(runRef: string, itemRef: string, subjectRef: string, update: (prior: J08ItemOutcome) => J08ItemOutcome) {
    const prior = this.outcome(runRef, itemRef) ?? { subjectRef, category: null, access: null, reason: null, owner: null, observedAt: null, receipts: [],
      lastSuccessAt: this.lastSuccess(subjectRef), pages: 0 };
    if (prior.subjectRef !== subjectRef) throw new ContentMonitorError("J08_ITEM_SUBJECT_MISMATCH");
    const next = update(prior);
    this.db.prepare("INSERT INTO content_monitor_items VALUES(?,?,?) ON CONFLICT(run_ref,item_ref) DO UPDATE SET body=excluded.body").run(runRef, itemRef, JSON.stringify(next));
  }
  /** Latest complete, healthy source watermark for this row across all runs. */
  lastSuccess(subjectRef: string): string | null {
    return str(this.db.prepare("SELECT last_success_at FROM content_monitor_success WHERE subject_ref=?").get(subjectRef)?.last_success_at);
  }
  private propose(itemKind: StoredAction["itemKind"], itemKey: string, reason: string, owner: "J09" | "J14", runRef: string) {
    const actionKey = `j08-action:${digest([owner, reason, itemKind, itemKey])}`;
    const prior = this.db.prepare("SELECT state FROM content_monitor_actions WHERE action_key=?").get(actionKey);
    if (prior) this.db.prepare("UPDATE content_monitor_actions SET last_run=?,state='proposed' WHERE action_key=?").run(runRef, actionKey);
    else this.db.prepare("INSERT INTO content_monitor_actions VALUES(?,?,?,?,?,?,?,'proposed')").run(actionKey, itemKind, itemKey, reason, owner, runRef, runRef);
  }
  private openIncident(subjectRef: string, contentKey: string | null, reason: string, runRef: string, sourceAt: string) {
    const incidentKey = `j08-incident:${digest([subjectRef, contentKey])}`;
    const prior = this.db.prepare("SELECT state FROM content_monitor_incidents WHERE incident_key=?").get(incidentKey);
    if (prior?.state === "open") return;
    this.db.prepare(`INSERT INTO content_monitor_incidents VALUES(?,?,?,?,'J14','open',?,?,NULL,NULL,NULL)
      ON CONFLICT(incident_key) DO UPDATE SET reason=excluded.reason,state='open',opened_run=excluded.opened_run,opened_at=excluded.opened_at,
      closed_run=NULL,closed_at=NULL,closed_receipt=NULL`).run(incidentKey, subjectRef, contentKey, reason, runRef, sourceAt);
  }
  /** Only a later complete, healthy source observation closes an incident; unbinding, removal or reconfiguration never does. */
  private closeIncident(subjectRef: string, contentKey: string | null, runRef: string, sourceAt: string, receiptRef: string) {
    const incidentKey = `j08-incident:${digest([subjectRef, contentKey])}`;
    const row = this.db.prepare("SELECT opened_at FROM content_monitor_incidents WHERE incident_key=? AND state='open'").get(incidentKey);
    if (!row || !later(sourceAt, String(row.opened_at))) return false;
    this.db.prepare("UPDATE content_monitor_incidents SET state='closed',closed_run=?,closed_at=?,closed_receipt=? WHERE incident_key=?").run(runRef, sourceAt, receiptRef, incidentKey);
    this.db.prepare("UPDATE content_monitor_actions SET state='resolvedByObservation' WHERE owner='J14' AND item_kind=? AND item_key=?")
      .run(contentKey ? "content" : "subject", contentKey ?? subjectRef);
    return true;
  }

  /** Persists one authorized page. Repeated observations reuse canonical identity and observation keys. */
  recordPage(input: { runRef: string; itemRef: string; subject: J08Subject; stage: J08Stage; page: J08Page; campaigns: readonly string[]; policy: J08Policy },
    fence: () => void) {
    const { runRef, itemRef, subject, page } = input;
    if (page.access !== "authorized") throw new ContentMonitorError("J08_PAGE_NOT_AUTHORIZED", 500);
    return this.tx(fence, () => {
      const pageHash = digest(page), prior = this.db.prepare("SELECT body_hash,run_ref,item_ref FROM content_monitor_pages WHERE receipt_ref=?").get(page.receiptRef);
      // A replayed receipt must carry identical facts; a reused receipt with different facts is never accepted.
      if (prior && prior.body_hash !== pageHash) throw new ContentMonitorError("J08_SOURCE_RECEIPT_REUSED", 502);
      if (!prior) this.db.prepare("INSERT INTO content_monitor_pages VALUES(?,?,?,?,?,?)").run(page.receiptRef, runRef, itemRef, input.stage, pageHash, page.observedAt);
      for (const post of page.posts) this.recordPost(input, post);
      for (const m of page.inbox) {
        const messageKey = JSON.stringify([m.ref.provider, m.ref.accountId, m.ref.sourceId]);
        if (this.db.prepare("SELECT 1 FROM content_monitor_inbox WHERE message_key=?").get(messageKey)) continue;
        this.db.prepare("INSERT INTO content_monitor_inbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(messageKey, subject.subjectRef, m.ref.provider, m.ref.accountId,
          m.ref.sourceId, m.conversationId, m.at, m.kind, m.direction, m.receiptRef, page.observedAt, runRef);
        if (m.direction === "inbound" && m.kind === "reply") this.propose("message", messageKey, "INBOX_REPLY_REVIEW", "J09", runRef);
      }
      this.putOutcome(runRef, itemRef, subject.subjectRef, o => ({ ...o, access: "authorized", observedAt: later(page.observedAt, o.observedAt) ? page.observedAt : o.observedAt,
        receipts: [...new Set([...o.receipts, page.receiptRef])].slice(-100), pages: o.pages + 1 }));
    });
  }
  private recordPost(input: { runRef: string; subject: J08Subject; page: J08Page; campaigns: readonly string[]; policy: J08Policy }, post: J08Page["posts"][number]) {
    const { runRef, subject, page, policy } = input;
    const key = contentKeyOf(post.ref.provider, post.ref.accountId, post.ref.sourceId), watermark = post.sourceUpdatedAt ?? page.observedAt;
    const assignment = fardaAssignment(post.fardaEvidence, input.campaigns);
    const existing = this.content(key);
    if (!existing) {
      // The first observed content for a creative is its original; others are crossposts with their own native identity.
      const sharesCreative = post.creativeRef !== null && Boolean(this.db.prepare("SELECT 1 FROM content_monitor_content WHERE creator_id=? AND creative_ref=? LIMIT 1").get(subject.creatorId, post.creativeRef));
      const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM content_monitor_content").get()!.n);
      this.db.prepare("INSERT INTO content_monitor_content VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?)").run(key, `content-${digest(key).slice(0, 32)}`, subject.creatorId,
        subject.subjectRef, post.ref.provider, post.ref.accountId, post.ref.sourceId, post.ref.url, post.creativeRef, post.publishedAt, runRef, page.observedAt,
        page.receiptRef, JSON.stringify({ ...assignment, role: sharesCreative ? "crosspost" : "original" }), sequence);
      if (assignment.state === "review") this.propose("content", key, `ATTRIBUTION_${assignment.reason}`, "J09", runRef);
    } else {
      // Identity is the native network/account/post; changed URLs, creatives or evidence never create another post.
      if (existing.creatorId !== subject.creatorId) {
        // Two canonical creators claim one native post: quarantine it from Farda activity and route it to review.
        this.db.prepare("UPDATE content_monitor_content SET conflict=1 WHERE content_key=?").run(key);
        this.propose("content", key, "CONTENT_OWNER_CONFLICT", "J09", runRef);
      }
      const changed = existing.assignment.state !== assignment.state || existing.assignment.campaignId !== assignment.campaignId;
      this.db.prepare("UPDATE content_monitor_content SET url=COALESCE(?,url),creative_ref=COALESCE(creative_ref,?),published_at=COALESCE(published_at,?),assignment=? WHERE content_key=?")
        .run(post.ref.url, post.creativeRef, post.publishedAt, JSON.stringify({ ...assignment, role: existing.role }), key);
      if (changed && assignment.state === "review") this.propose("content", key, `ATTRIBUTION_${assignment.reason}`, "J09", runRef);
    }
    if (assignment.state === "unrelated") return;
    // Lifecycle: a new status row only when the confirmed state or access changes, and never from an older watermark.
    const current = this.latestStatus(key), state = post.access === "authorized" ? post.visibility! : "inaccessible";
    if (!current || (current.state !== state || current.access !== post.access) && later(watermark, current.sourceAt)) {
      this.db.prepare("INSERT INTO content_monitor_status VALUES(?,?,?,?,?,?,?)").run(key, (current?.seq ?? 0) + 1, state, post.access, watermark, page.receiptRef, runRef);
      if (["private", "deleted", "expired"].includes(state)) this.propose("content", key, `CONTENT_${state.toUpperCase()}`, "J09", runRef);
    }
    if (post.access !== "authorized") {
      const reason = post.access === "denied" ? "CONTENT_ACCESS_DENIED" : "CONTENT_READ_UNAVAILABLE";
      this.openIncident(subject.subjectRef, key, reason, runRef, watermark); this.propose("content", key, reason, "J14", runRef); return;
    }
    this.closeIncident(subject.subjectRef, key, runRef, watermark, page.receiptRef);
    for (const m of post.metrics) {
      const seriesKey = digest([key, m.metricKey, m.definition, m.semantics, m.unit, m.window.start, m.semantics === "interval" ? m.window.end : null]);
      const last = this.db.prepare("SELECT * FROM content_monitor_metrics WHERE series_key=? ORDER BY seq DESC LIMIT 1").get(seriesKey);
      if (last && (last.value === null ? null : Number(last.value)) === m.value && str(last.missing_reason) === m.missingReason) {
        // Unchanged counters are a confirmation, not another snapshot or delta.
        if (later(page.observedAt, String(last.confirmed_through))) this.db.prepare("UPDATE content_monitor_metrics SET confirmed_through=? WHERE series_key=? AND seq=?").run(page.observedAt, seriesKey, Number(last.seq));
        continue;
      }
      if (last && !later(page.observedAt, String(last.observed_at))) continue;
      this.db.prepare("INSERT INTO content_monitor_metrics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(seriesKey, Number(last?.seq ?? 0) + 1, key, m.metricKey,
        m.value, m.unit, m.definition, m.semantics, m.window.start, m.window.end, post.context, m.missingReason, page.observedAt, page.observedAt, page.receiptRef, runRef);
    }
    const publishedAt = post.publishedAt ?? existing?.publishedAt ?? null;
    if (post.metrics.length) {
      const captured = this.checkpoints(key).filter(c => c.checkpointsVersion === policy.checkpoints.version).map(c => c.hours);
      const capture = checkpointCapture(publishedAt, page.observedAt, policy.checkpoints.hours, captured);
      if (capture) this.db.prepare("INSERT INTO content_monitor_checkpoints VALUES(?,?,?,?,?,?,?,?)").run(key, policy.checkpoints.version, capture.hours,
        page.observedAt, capture.actualAgeHours, page.receiptRef, policy.version, runRef);
    }
  }

  /** Access failures preserve the checkpoint and prior confirmed receipts; they open an owned incident when access is not transient. */
  recordAccessFailure(input: { runRef: string; itemRef: string; subject: J08Subject; page: J08Page }, fence: () => void) {
    const { runRef, itemRef, subject, page } = input;
    const transient = page.access === "throttled" || page.access === "unavailable";
    const category: J08Category | null = transient ? null : page.access === "uiDrift" ? "failed" : "inaccessible";
    const reason = `SOURCE_${page.access.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
    this.tx(fence, () => {
      if (!transient) { this.openIncident(subject.subjectRef, null, reason, runRef, page.observedAt); this.propose("subject", subject.subjectRef, reason, "J14", runRef); }
      this.putOutcome(runRef, itemRef, subject.subjectRef, o => ({ ...o, category, access: page.access, reason, owner: "J14",
        observedAt: later(page.observedAt, o.observedAt) ? page.observedAt : o.observedAt, receipts: [...new Set([...o.receipts, page.receiptRef])].slice(-100) }));
    });
    return { reason, category };
  }
  /** Completes a row after both stages read completely: closes older incidents, refreshes order attribution and sets the category. */
  finishItem(input: { runRef: string; itemRef: string; subject: J08Subject; attributions: Map<string, { attribution: OrderAttribution | null; reason: string }> },
    fence: () => void) {
    const { runRef, itemRef, subject } = input;
    return this.tx(fence, () => {
      const outcome = this.outcome(runRef, itemRef);
      if (!outcome?.observedAt || outcome.access !== "authorized") throw new ContentMonitorError("J08_ITEM_INCOMPLETE", 500);
      const receipt = outcome.receipts.at(-1)!;
      this.closeIncident(subject.subjectRef, null, runRef, outcome.observedAt, receipt);
      for (const [key, result] of input.attributions)
        this.db.prepare("UPDATE content_monitor_content SET attribution=?,attribution_reason=? WHERE content_key=?").run(result.attribution ? JSON.stringify(result.attribution) : null, result.reason, key);
      const fresh = Number(this.db.prepare("SELECT COUNT(*) AS n FROM content_monitor_content WHERE first_run=? AND subject_ref=?").get(runRef, subject.subjectRef)!.n) +
        Number(this.db.prepare("SELECT COUNT(*) AS n FROM content_monitor_inbox WHERE first_run=? AND subject_ref=?").get(runRef, subject.subjectRef)!.n);
      const category: J08Category = fresh ? "newContent" : "unchanged";
      const prior = this.lastSuccess(subject.subjectRef), success = later(outcome.observedAt, prior) ? outcome.observedAt : prior!;
      if (success !== prior) this.db.prepare("INSERT INTO content_monitor_success VALUES(?,?,?,?) ON CONFLICT(subject_ref) DO UPDATE SET last_success_at=excluded.last_success_at,receipt_ref=excluded.receipt_ref,run_ref=excluded.run_ref")
        .run(subject.subjectRef, success, receipt, runRef);
      this.putOutcome(runRef, itemRef, subject.subjectRef, o => ({ ...o, category, reason: null, owner: null, lastSuccessAt: success }));
      return category;
    });
  }

  private contentFrom(r: Row): StoredContent {
    const assignment = json<FardaAssignment & { role: "original" | "crosspost" }>(r.assignment);
    return { contentKey: String(r.content_key), contentRef: String(r.content_ref), creatorId: String(r.creator_id), subjectRef: String(r.subject_ref),
      network: String(r.network) as J08Network, accountId: String(r.account_id), postId: String(r.post_id), url: str(r.url), creativeRef: str(r.creative_ref),
      role: assignment.role, publishedAt: str(r.published_at), firstRun: String(r.first_run), firstObservedAt: String(r.first_observed_at), firstReceipt: String(r.first_receipt),
      assignment: { state: assignment.state, campaignId: assignment.campaignId, reason: assignment.reason, receipts: assignment.receipts },
      attribution: r.attribution === null ? null : json<OrderAttribution>(r.attribution), attributionReason: str(r.attribution_reason), conflict: Boolean(r.conflict) };
  }
  content(contentKey: string): StoredContent | null {
    const r = this.db.prepare("SELECT * FROM content_monitor_content WHERE content_key=?").get(contentKey);
    return r ? this.contentFrom(r) : null;
  }
  allContent(): StoredContent[] { return this.db.prepare("SELECT * FROM content_monitor_content ORDER BY sequence").all().map(r => this.contentFrom(r)); }
  subjectContent(subjectRef: string): StoredContent[] { return this.allContent().filter(c => c.subjectRef === subjectRef); }
  metrics(contentKey: string): StoredMetric[] {
    return this.db.prepare("SELECT * FROM content_monitor_metrics WHERE content_key=? ORDER BY observed_at,metric_key,seq").all(contentKey).map(r => ({
      seriesKey: String(r.series_key), seq: Number(r.seq), contentKey, metricKey: String(r.metric_key) as StoredMetric["metricKey"], value: r.value === null ? null : Number(r.value),
      unit: String(r.unit), definition: String(r.definition), semantics: String(r.semantics) as StoredMetric["semantics"], windowStart: String(r.window_start), windowEnd: String(r.window_end),
      context: String(r.context), missingReason: str(r.missing_reason), observedAt: String(r.observed_at), confirmedThrough: String(r.confirmed_through),
      receiptRef: String(r.receipt_ref), runRef: String(r.run_ref) }));
  }
  latestStatus(contentKey: string): StoredStatus | null { return this.status(contentKey).at(-1) ?? null; }
  status(contentKey: string): StoredStatus[] {
    return this.db.prepare("SELECT * FROM content_monitor_status WHERE content_key=? ORDER BY seq").all(contentKey).map(r => ({ contentKey, seq: Number(r.seq),
      state: String(r.state) as StoredStatus["state"], access: String(r.access), sourceAt: String(r.source_at), receiptRef: String(r.receipt_ref), runRef: String(r.run_ref) }));
  }
  checkpoints(contentKey: string): StoredCheckpoint[] {
    return this.db.prepare("SELECT * FROM content_monitor_checkpoints WHERE content_key=? ORDER BY hours").all(contentKey).map(r => ({ contentKey,
      checkpointsVersion: String(r.checkpoints_version), hours: Number(r.hours), observedAt: String(r.observed_at), actualAgeHours: Number(r.actual_age_hours),
      receiptRef: String(r.receipt_ref), policyVersion: String(r.policy_version), runRef: String(r.run_ref) }));
  }
  messages(firstRun?: string): StoredMessage[] {
    const rows = firstRun ? this.db.prepare("SELECT * FROM content_monitor_inbox WHERE first_run=? ORDER BY at,message_key").all(firstRun)
      : this.db.prepare("SELECT * FROM content_monitor_inbox ORDER BY at,message_key").all();
    return rows.map(r => ({ messageKey: String(r.message_key), subjectRef: String(r.subject_ref), network: String(r.network) as J08Network, accountId: String(r.account_id),
      messageId: String(r.message_id), conversationId: String(r.conversation_id), at: String(r.at), kind: String(r.kind) as StoredMessage["kind"],
      direction: String(r.direction) as StoredMessage["direction"], receiptRef: String(r.receipt_ref), pageObservedAt: String(r.page_observed_at), firstRun: String(r.first_run) }));
  }
  incidents(): StoredIncident[] {
    return this.db.prepare("SELECT * FROM content_monitor_incidents ORDER BY opened_at,incident_key").all().map(r => ({ incidentKey: String(r.incident_key),
      subjectRef: String(r.subject_ref), contentKey: str(r.content_key), reason: String(r.reason), owner: "J14" as const, state: String(r.state) as "open" | "closed",
      openedRun: String(r.opened_run), openedAt: String(r.opened_at), closedRun: str(r.closed_run), closedAt: str(r.closed_at), closedReceipt: str(r.closed_receipt) }));
  }
  actions(): StoredAction[] {
    return this.db.prepare("SELECT * FROM content_monitor_actions ORDER BY first_run,action_key").all().map(r => ({ actionKey: String(r.action_key),
      itemKind: String(r.item_kind) as StoredAction["itemKind"], itemKey: String(r.item_key), reason: String(r.reason), owner: String(r.owner) as "J09" | "J14",
      firstRun: String(r.first_run), lastRun: String(r.last_run), state: String(r.state) as StoredAction["state"] }));
  }
}
