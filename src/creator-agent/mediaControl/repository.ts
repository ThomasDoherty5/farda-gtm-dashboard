import type { DispatchApprovalBinding, VerifiedApprovalProof } from "../approvals/contract.ts";
import type { DispatchReceipt, ResourceGrant } from "../jobs/dispatchSchema.ts";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import type { CampaignView, MediaProvider, MutationView } from "../media/contract.ts";
import type { MediaOperationIdentity } from "../media/canonicalContract.ts";
import { MediaSourceUnavailable, type PaidMediaRepository } from "../media/repository.ts";
import { HEALTH_CHECKS, changeInputSchema, healthSchema, orderFeedSchema, parameterSetSchema, ref, spendReportSchema, stageDecisionSchema, stageInputSchema, treasurySchema, type Allocation, type ChangeKind, type ChangeView, type ControlScope, type EconomicsView, type ExposureView, type HealthCheck, type Incident, type LaunchView, type ObservationView, type OrderFeed, type ParameterSet, type ReservationState, type SafetyRunView, type SpendReport, type StageDecision, type StageInput, type StageState, type StageView, type TreasuryView } from "./contract.ts";

/** Trusted, server-configured sources. A caller never supplies these objects. Every one may be missing, malformed or stale: that is unknown. */
export interface MediaControlAuthority {
  /** The owner-adopted economic parameter set (THO-193 versioned economics). */
  parameters?(scope: ControlScope): unknown;
  /** The J04 Linear decision for one stage release. */
  stageDecision?(decisionRef: string, scope: ControlScope): unknown;
  /** Cumulative spend, native limits and platform-attributed conversions for one account (THO-191 reporting). */
  spendReport?(binding: { provider: MediaProvider; providerAccountRef: string; environment: "sandbox" | "production" }, scope: ControlScope): unknown;
  /** Canonical retained commerce orders and refunds for the stage window. */
  orders?(window: { stageRef: string; startAt: string; endAt: string }, scope: ControlScope): unknown;
  /** Qualified stock, actual-offer checkout, rights, native permission and measurement health. */
  health?(stageRef: string, scope: ControlScope): unknown;
  /** Actual treasury cash, founder investment, commitments and payout timing. */
  treasury?(scope: ControlScope): unknown;
}
/** A media write may have reached the provider before the error. The route reports it as uncertain, never as not applied. */
export class MediaControlUncertain extends Error {}

type StoredStage = {
  stageRef: string; revision: number; state: StageState; terms: StageInput; subjectHash: string; proposedAt: string; heldReasons: string[];
  decisionRef: string | null; decision: "none" | "approved" | "rejected"; decisionValidUntil: string | null; releasedAt: string | null;
  canonical?: { binding: DispatchApprovalBinding; receipt: DispatchReceipt; decisionReceiptRef: string };
  incidents: Incident[]; lastObservationId: string | null; lastObservedAt: string | null; history: { state: StageState; at: string; ref: string | null }[];
};
type StoredReservation = {
  reservationId: string; stageRef: string; campaignId: string; provider: MediaProvider; providerAccountRef: string; environment: "sandbox" | "production";
  nativeCampaignId: string | null; plannedMaxMinor: number; approvedLifetimeMinor: number; state: ReservationState; createdAt: string;
  confirmedAt: string | null; lastChangeAt: string | null; pausedAt: string | null; gates: { gate: string; state: string }[];
  /** Resource ownership only; JobRepository remains the execution lease owner. */
  canonicalGrant?: ResourceGrant;
  canonicalPendingKey?: string | null;
  canonicalSettledAttemptRef?: string;
  /** Historical legacy launch lease, never issued by canonical execution. */
  lease?: { token: string; until: string } | null;
  /** A safety trigger that fired while this launch was in flight. It is never dropped: the launch and later safety runs must clear it. */
  safetyHold?: { codes: string[]; policyRef: string; at: string; resolvedAt: string | null } | null;
};
type StoredChange = Omit<ChangeView, "kind" | "stageRef" | "changeKind"> & { stageRef: string; kind: ChangeKind; createdAt: string };
type SpendRow = {
  key: string; provider: MediaProvider; providerAccountRef: string; environment: string; nativeCampaignId: string; status: string; spendMinor: number | null;
  lifetimeBudgetMinor: number | null; dailyBudgetMinor: number | null; endAt: string | null; extrasEnabled: boolean; sourceRef: string;
  sourceUpdatedAt: string; observedAt: string;
};
type OrderRow = OrderFeed["orders"][number] & { key: string };
type ConversionRow = { key: string; provider: string; nativeKey: string; channel: "native" | "mirror"; convertedAt: string; valueMinor: number; firstSeenAt: string };
type Evaluation = {
  view: Omit<ObservationView, "observationId">; spendRows: SpendRow[]; orders: OrderRow[]; conversions: ConversionRow[];
  reconcile: { reservationId: string; to: ReservationState; nativeCampaignId: string | null; gates: { gate: string; state: string }[]; paused: boolean }[];
  /** Active campaigns in stage accounts with no active reservation; campaignId is known when Farda launched it before. */
  untracked: { key: string; campaignId: string | null }[];
  gateUpdates: { reservationId: string; gates: { gate: string; state: string }[] }[];
};

const LIVE = ["ACTIVE", "IN_REVIEW"];
const NOT_WRITTEN = ["held", "draft", "approved", "rejected", "provider-rejected"];
const parse = <T>(schema: z.ZodType<T>, value: unknown): T | null => { const r = schema.safeParse(value); return r.success ? r.data : null; };
const sameScope = (a: ControlScope, b: ControlScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;
const ms = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);
const requireKey = (key: string) => { if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED"); };
const headroom = (minor: number, bps: number) => Math.ceil((minor * bps) / 10_000);
const sum = (values: (number | null)[]) => (values.some((v) => v === null) ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0));
const allocKey = (a: { provider: string; providerAccountRef: string; environment: string }) => `${a.provider}|${a.providerAccountRef}|${a.environment}`;
/** Provider-local IDs are namespaced by kind, provider, account and environment so they never collide across providers or accounts. */
const campaignKey = (a: { provider: string; providerAccountRef: string; environment: string }, nativeId: string) => `campaign|${allocKey(a)}|${nativeId}`;
const passthrough = (error: unknown) => error instanceof AgentConflict || error instanceof MediaSourceUnavailable;
const HEALTH_TRIGGER: Record<HealthCheck, string> = {
  stock: "QUALIFIED_STOCK_SHORTAGE", checkout: "CHECKOUT_FAILED", rights: "RIGHTS_REVOKED_OR_EXPIRED", permission: "PERMISSION_UNAVAILABLE",
  measurement: "MEASUREMENT_UNTRUSTWORTHY",
};

export class MediaReleaseController {
  private readonly db: DatabaseSync;
  private readonly scope: ControlScope;
  private readonly authority: MediaControlAuthority;
  private readonly media: PaidMediaRepository;
  private readonly now: () => Date;
  constructor(db: DatabaseSync, scope: ControlScope, authority: MediaControlAuthority = {}, media: PaidMediaRepository, now: () => Date = () => new Date()) {
    this.db = db; this.scope = scope; this.authority = authority; this.media = media; this.now = now;
    const actual = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (actual?.workspace_id !== scope.workspaceId || actual.account_id !== scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
    db.exec(`CREATE TABLE IF NOT EXISTS media_control_stages (stage_ref TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_reservations (reservation_id TEXT PRIMARY KEY, stage_ref TEXT NOT NULL, campaign_id TEXT NOT NULL,
        active INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS media_control_one_reservation ON media_control_reservations(campaign_id) WHERE active=1;
      CREATE TABLE IF NOT EXISTS media_control_changes (change_id TEXT PRIMARY KEY, stage_ref TEXT NOT NULL, campaign_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_spend (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_orders (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_conversions (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_corrections (id INTEGER PRIMARY KEY AUTOINCREMENT, stage_ref TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_observations (observation_id TEXT PRIMARY KEY, stage_ref TEXT NOT NULL, observed_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_control_receipts (source_ref TEXT PRIMARY KEY, subject TEXT NOT NULL);`);
  }

  // ---------- storage ----------
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private iso() { return this.now().toISOString(); }
  /** Binds a key to exactly one command. Returns the stored result reference of an earlier identical call, if any. */
  private bindKey(key: string, command: unknown): string | null {
    requireKey(key);
    const hash = digest(command);
    return this.tx(() => {
      const prior = this.db.prepare("SELECT hash,body FROM media_control_commands WHERE key=?").get(key);
      if (prior && prior.hash !== hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      if (!prior) this.db.prepare("INSERT INTO media_control_commands VALUES(?,?,?)").run(key, hash, "null");
      return prior ? (JSON.parse(String(prior.body)) as string | null) : null;
    });
  }
  private recordResult(key: string, resultRef: string) { this.db.prepare("UPDATE media_control_commands SET body=? WHERE key=?").run(JSON.stringify(resultRef), key); }
  private loadStage(stageRef: string): StoredStage | null {
    const row = this.db.prepare("SELECT body FROM media_control_stages WHERE stage_ref=?").get(ref.parse(stageRef));
    return row ? JSON.parse(String(row.body)) as StoredStage : null;
  }
  private requireStage(stageRef: string) { const s = this.loadStage(stageRef); if (!s) throw new AgentConflict("STAGE_UNKNOWN"); return s; }
  private saveStage(s: StoredStage) {
    try {
      this.db.prepare("INSERT INTO media_control_stages VALUES(?,?,?) ON CONFLICT(stage_ref) DO UPDATE SET ordinal=excluded.ordinal, body=excluded.body")
        .run(s.stageRef, s.terms.ordinal, JSON.stringify(s));
    } catch (error) {
      if (/UNIQUE/.test(String((error as Error)?.message))) throw new AgentConflict("STAGE_ORDINAL_TAKEN");
      throw error;
    }
  }
  private stages(): StoredStage[] { return this.db.prepare("SELECT body FROM media_control_stages ORDER BY ordinal").all().map((r) => JSON.parse(String(r.body)) as StoredStage); }
  private move(s: StoredStage, state: StageState, sourceRef: string | null) { s.state = state; s.history.push({ state, at: this.iso(), ref: sourceRef }); }
  private reservations(where: string, ...args: string[]): StoredReservation[] {
    return this.db.prepare(`SELECT body FROM media_control_reservations WHERE ${where} ORDER BY rowid`).all(...args).map((r) => JSON.parse(String(r.body)) as StoredReservation);
  }
  private saveReservation(r: StoredReservation) {
    this.db.prepare("INSERT INTO media_control_reservations VALUES(?,?,?,?,?) ON CONFLICT(reservation_id) DO UPDATE SET active=excluded.active, body=excluded.body")
      .run(r.reservationId, r.stageRef, r.campaignId, r.state === "released" ? 0 : 1, JSON.stringify(r));
  }
  private loadChange(changeId: string): StoredChange | null {
    const row = this.db.prepare("SELECT body FROM media_control_changes WHERE change_id=?").get(ref.parse(changeId));
    return row ? JSON.parse(String(row.body)) as StoredChange : null;
  }
  private saveChange(c: StoredChange) {
    this.db.prepare("INSERT INTO media_control_changes VALUES(?,?,?,?) ON CONFLICT(change_id) DO UPDATE SET body=excluded.body").run(c.changeId, c.stageRef, c.campaignId, JSON.stringify(c));
  }
  private moveChange(c: StoredChange, state: StoredChange["state"], sourceRef: string | null) { c.state = state; c.history.push({ state, at: this.iso(), ref: sourceRef }); }
  /** A resolver that throws or returns nothing is unknown, never authoritative absence. */
  private resolve(fn: (() => unknown) | undefined): unknown {
    if (!fn) return undefined;
    try { return fn(); } catch { return undefined; }
  }
  private readCampaign(campaignId: string): CampaignView | null {
    try { return this.media.read(campaignId); } catch { return null; }
  }

  // ---------- parameters ----------
  private parameters(): { set: ParameterSet | null; reasons: string[] } {
    const p = parse(parameterSetSchema, this.resolve(this.authority.parameters && (() => this.authority.parameters!(this.scope))));
    if (!p || !sameScope(p.scope, this.scope) || !(ms(p.observedAt) <= this.now().getTime())) return { set: null, reasons: ["PARAMETERS_UNAVAILABLE"] };
    return { set: p, reasons: [] };
  }
  /** The adopted value, or null with the reason. Proposed, missing or undated parameters stay unknown. */
  private adopted<T>(name: string, entry: { value: T; state: string; adoptionRef: string | null; adoptedAt: string | null } | null | undefined, reasons: string[]): T | null {
    if (!entry) { reasons.push(`PARAMETER_NOT_ADOPTED:${name}`); return null; }
    if (entry.state !== "adopted") { reasons.push(`PARAMETER_PROPOSED_NOT_ADOPTED:${name}`); return null; }
    if (!entry.adoptionRef || !(ms(entry.adoptedAt) <= this.now().getTime())) { reasons.push(`PARAMETER_ADOPTION_UNVERIFIED:${name}`); return null; }
    return entry.value;
  }
  private fresh(asOf: string | null | undefined, maxMinutes: number | null) {
    const t = ms(asOf), now = this.now().getTime();
    return maxMinutes !== null && Number.isFinite(t) && t <= now && now - t <= maxMinutes * 60_000;
  }
  /** Review-bound actions (stage release, launch, increase) run only inside the adopted review window. Safety actions are never limited by it. */
  private reviewWindow(set: ParameterSet | null): { open: boolean; nextReviewAt: string | null; nextSafetyCheckAt: string | null; reasons: string[] } {
    const reasons: string[] = [];
    const cadence = this.adopted("reviewCadence", set?.reviewCadence, reasons);
    if (!cadence) return { open: false, nextReviewAt: null, nextSafetyCheckAt: null, reasons };
    const now = this.now().getTime(), anchor = ms(cadence.anchorAt), interval = cadence.intervalHours * 3_600_000;
    const nextSafetyCheckAt = new Date(now + cadence.safetyIntervalMinutes * 60_000).toISOString();
    if (!Number.isFinite(anchor) || now < anchor) return { open: false, nextReviewAt: Number.isFinite(anchor) ? cadence.anchorAt : null, nextSafetyCheckAt, reasons: ["REVIEW_WINDOW_CLOSED"] };
    const slotStart = anchor + Math.floor((now - anchor) / interval) * interval;
    const open = now - slotStart <= cadence.windowMinutes * 60_000;
    return { open, nextReviewAt: new Date(open ? slotStart : slotStart + interval).toISOString(), nextSafetyCheckAt, reasons: open ? [] : ["REVIEW_WINDOW_CLOSED"] };
  }
  /** The stage terms checked against the adopted stage policy. */
  private policyReasons(terms: StageInput, set: ParameterSet | null): string[] {
    const reasons: string[] = [];
    if (!set) return ["PARAMETERS_UNAVAILABLE"];
    const policy = this.adopted("stagePolicy", set.stagePolicy, reasons);
    if (!policy) return reasons;
    const entry = policy.find((p) => p.ordinal === terms.ordinal);
    if (!entry) return ["STAGE_NOT_IN_ADOPTED_POLICY"];
    if (entry.capMinor !== terms.capMinor) reasons.push("STAGE_CAP_NOT_ADOPTED");
    if (terms.headroomBps > entry.maxHeadroomBps) reasons.push("HEADROOM_EXCEEDS_ADOPTED_POLICY");
    if (terms.allocations.some((a) => a.environment === "production")) reasons.push("PRODUCTION_HELD");
    return reasons;
  }
  private currentStageDecision(s: StoredStage, decisionRef: string, requireApproved = true): StageDecision {
    const d = parse(stageDecisionSchema, this.resolve(this.authority.stageDecision && (() => this.authority.stageDecision!(decisionRef, this.scope))));
    const now = this.now().getTime();
    if (!d || !sameScope(d.scope, this.scope) || d.sourceRef !== decisionRef || d.stageRef !== s.stageRef) throw new MediaSourceUnavailable("STAGE_DECISION_UNVERIFIED");
    if (d.system !== "linear") throw new AgentConflict("J04_LINEAR_DECISION_REQUIRED");
    if (d.revision !== s.revision || d.subjectHash !== s.subjectHash) throw new AgentConflict("J04_DECISION_FOR_ANOTHER_REQUEST");
    if (d.state !== "current" || !(ms(d.validUntil) > now)) throw new AgentConflict("J04_DECISION_NOT_CURRENT");
    if (!(ms(d.decidedAt) <= now) || ms(d.decidedAt) < ms(s.proposedAt)) throw new AgentConflict("J04_DECISION_PREDATES_REQUEST");
    if (requireApproved && d.decision !== "approved") throw new AgentConflict("J04_DECISION_REJECTED");
    return d;
  }

  // ---------- evaluation (observe) ----------
  private report(a: Allocation): { report: SpendReport | null; reason: string | null } {
    const binding = { provider: a.provider, providerAccountRef: a.providerAccountRef, environment: a.environment };
    const r = parse(spendReportSchema, this.resolve(this.authority.spendReport && (() => this.authority.spendReport!(binding, this.scope))));
    const tag = `${a.provider}:${a.providerAccountRef}`;
    if (!r) return { report: null, reason: `SPEND_REPORT_UNAVAILABLE:${tag}` };
    // A report for another provider, account or environment is unknown, not zero and not confirmation.
    if (!sameScope(r.scope, this.scope) || allocKey(r) !== allocKey(a)) return { report: null, reason: `SPEND_REPORT_MISMATCH:${tag}` };
    if (!(ms(r.observedAt) <= this.now().getTime()) || !(ms(r.sourceUpdatedAt) <= ms(r.observedAt))) return { report: null, reason: `SPEND_REPORT_TIME_INVALID:${tag}` };
    if (new Set(r.campaigns.map((c) => c.nativeCampaignId)).size !== r.campaigns.length) return { report: null, reason: `SPEND_REPORT_DUPLICATE_CAMPAIGN:${tag}` };
    return { report: r, reason: null };
  }
  private storedSpend(key: string): SpendRow | null {
    const row = this.db.prepare("SELECT body FROM media_control_spend WHERE key=?").get(key);
    return row ? JSON.parse(String(row.body)) as SpendRow : null;
  }

  private evaluate(s: StoredStage, opts: { extraExposureMinor?: number; canonicalDecisionCurrent?: boolean } = {}): Evaluation {
    const now = this.now().getTime(), at = this.iso();
    const { set, reasons: paramReasons } = this.parameters();
    const freshness = this.adopted("freshnessMaxAgeMinutes", set?.freshnessMaxAgeMinutes, paramReasons);
    const triggers: string[] = [], holds: string[] = [...paramReasons.filter((r) => r.includes("freshnessMaxAgeMinutes") || r === "PARAMETERS_UNAVAILABLE")];
    // Launches and releases fail closed until the owner adopts the diagnostic limits, evidence threshold and attribution window.
    if (set) {
      this.adopted("maxTestLossMinor", set.diagnostic.maxTestLossMinor, holds); this.adopted("maxCpaMinor", set.diagnostic.maxCpaMinor, holds);
      this.adopted("minimumEvidence", set.minimumEvidence, holds); this.adopted("attributionWindow", set.attributionWindow, holds);
    }
    const untracked: Evaluation["untracked"] = [], gateUpdates: Evaluation["gateUpdates"] = [];
    const corrections: ObservationView["corrections"] = [], freshnessView: ObservationView["freshness"] = [];
    const spendRows: SpendRow[] = [], reconcile: Evaluation["reconcile"] = [];
    const terms = s.terms, bps = terms.headroomBps;
    const allActive = new Set(this.reservations("active=1").filter((r) => r.nativeCampaignId).map((r) => campaignKey(r, r.nativeCampaignId!)));
    const mine = this.reservations("stage_ref=? AND active=1", s.stageRef);
    const exposureReasons: string[] = [];
    const campaigns: ExposureView["campaigns"] = [];
    const allocations: ExposureView["allocations"] = [];
    const reportRows = new Map<string, SpendReport["campaigns"][number] & { alloc: string; fresh: boolean }>();
    const reports = new Map<string, SpendReport | null>();

    for (const a of terms.allocations) {
      const { report, reason } = this.report(a);
      reports.set(allocKey(a), report);
      const reportFresh = !!report && this.fresh(report.sourceUpdatedAt, freshness);
      freshnessView.push({ source: `spend:${a.provider}:${a.providerAccountRef}`, sourceUpdatedAt: report?.sourceUpdatedAt ?? null, observedAt: report?.observedAt ?? null, fresh: reportFresh });
      if (reason) { exposureReasons.push(reason); holds.push(reason); }
      else if (!reportFresh) { exposureReasons.push(`SPEND_STALE:${a.provider}:${a.providerAccountRef}`); holds.push(`SPEND_STALE:${a.provider}:${a.providerAccountRef}`); }
      for (const row of report?.campaigns ?? []) {
        const key = campaignKey(a, row.nativeCampaignId);
        const reported: SpendRow = { key, provider: a.provider, providerAccountRef: a.providerAccountRef, environment: a.environment, nativeCampaignId: row.nativeCampaignId,
          status: row.status, spendMinor: row.spendMinor, lifetimeBudgetMinor: row.lifetimeBudgetMinor, dailyBudgetMinor: row.dailyBudgetMinor, endAt: row.endAt,
          extrasEnabled: row.maxDelivery || row.autoRecharge || row.extraDeliveryBudget, sourceRef: report!.sourceRef, sourceUpdatedAt: report!.sourceUpdatedAt, observedAt: report!.observedAt };
        const stored = this.storedSpend(key);
        // An older report never moves cumulative spend backwards; a newer lower figure is a recorded source correction.
        if (stored && ms(stored.sourceUpdatedAt) > ms(reported.sourceUpdatedAt)) {
          corrections.push({ kind: "out-of-order-report-ignored", key, detail: `${reported.sourceUpdatedAt} < ${stored.sourceUpdatedAt}`, at });
          continue;
        }
        if (stored && stored.spendMinor !== null && reported.spendMinor !== null && reported.spendMinor !== stored.spendMinor
          && (reported.spendMinor < stored.spendMinor || stored.sourceUpdatedAt === reported.sourceUpdatedAt)) {
          corrections.push({ kind: reported.spendMinor < stored.spendMinor ? "spend-revised-down" : "spend-restated", key,
            detail: `${stored.spendMinor} -> ${reported.spendMinor}`, at });
        }
        spendRows.push(reported);
        reportRows.set(key, { ...row, alloc: allocKey(a), fresh: reportFresh });
        if (LIVE.includes(row.status) && !allActive.has(key)) {
          // Spend outside any reservation is a safety trigger: it is paused when Farda can name the campaign.
          const code = `UNTRACKED_ACTIVE_CAMPAIGN:${a.provider}:${a.providerAccountRef}:${row.nativeCampaignId}`;
          triggers.push(code); exposureReasons.push(code);
          const known = this.reservations("1=1").find((r) => r.nativeCampaignId && campaignKey(r, r.nativeCampaignId) === key);
          untracked.push({ key, campaignId: known?.campaignId ?? null });
        }
      }
    }

    // Reconcile a pending launch from the media record and the report first: live on the provider commits it; a write that never went out frees it.
    const views = new Map<string, CampaignView | null>();
    for (const r of [...mine]) {
      const v = this.readCampaign(r.campaignId);
      views.set(r.campaignId, v);
      if (r.state !== "pending") continue;
      // A launch still inside its in-flight lease belongs to the worker holding it; it stays reserved in full.
      if (r.lease && ms(r.lease.until) > now) continue;
      const nativeId = r.nativeCampaignId ?? v?.native.nativeCampaignId ?? null;
      const row = nativeId ? reportRows.get(campaignKey(r, nativeId)) : undefined;
      const settled = this.settle(v, !!row && LIVE.includes(row.status), r);
      if (settled?.to === "committed") {
        const gates = v?.gates.map((g) => ({ gate: g.gate, state: g.state })) ?? [];
        reconcile.push({ reservationId: r.reservationId, to: "committed", nativeCampaignId: nativeId, gates, paused: settled.paused });
        Object.assign(r, { state: "committed", nativeCampaignId: nativeId, confirmedAt: at, gates, pausedAt: settled.paused ? at : r.pausedAt });
      } else if (settled?.to === "released") {
        reconcile.push({ reservationId: r.reservationId, to: "released", nativeCampaignId: nativeId, gates: [], paused: false });
        mine.splice(mine.indexOf(r), 1);
      }
    }
    // Per-campaign exposure: spend, native lifetime cap plus approved overdelivery headroom, end date and extras.
    for (const r of mine) {
      const v = views.get(r.campaignId) ?? null;
      const nativeId = r.nativeCampaignId ?? v?.native.nativeCampaignId ?? null;
      const key = nativeId ? campaignKey(r, nativeId) : null;
      const row = key ? reportRows.get(key) : undefined;
      const stored = key ? this.storedSpend(key) : null;
      const rowFresh = !!row && row.fresh;
      const rb = v?.native.readback ?? null;
      // A read-back counts only for the exact campaign, provider, account and environment, observed no later than now.
      const readback = rb && rb.nativeCampaignId === nativeId && rb.provider === r.provider && rb.providerAccountRef === r.providerAccountRef
        && rb.environment === r.environment && this.fresh(rb.observedAt, freshness) ? rb : null;
      if (r.safetyHold && !r.safetyHold.resolvedAt && !(r.lease && ms(r.lease.until) > now)) triggers.push(`SAFETY_HOLD_PENDING:${r.campaignId}`);
      // Without the campaign record its rights cannot be checked: fail closed.
      if (!v?.manifest) { holds.push(`CAMPAIGN_RECORD_UNAVAILABLE:${r.campaignId}`); exposureReasons.push(`CAMPAIGN_RECORD_UNAVAILABLE:${r.campaignId}`); }
      for (const c of v?.manifest?.creatives ?? []) if (!(ms(c.rightsExpiresAt) > now)) triggers.push(`RIGHTS_EXPIRED:${r.campaignId}`);
      if (r.state === "committed" && v && v.gates.length && v.gates.every((g) => g.state === "verified")) {
        if (r.gates.some((g) => g.state !== "verified")) gateUpdates.push({ reservationId: r.reservationId, gates: v.gates.map((g) => ({ gate: g.gate, state: g.state })) });
        for (const i of s.incidents) if (!i.resolvedAt && i.code === "GATES_NOT_VERIFIED_AT_PUBLISH" && i.campaignId === r.campaignId) i.resolvedAt = at;
      }
      if (r.state === "pending") {
        campaigns.push({ campaignId: r.campaignId, key: key ?? `pending|${r.reservationId}`, reservation: "pending", status: row?.status ?? v?.native.status ?? null,
          dailyBudgetMinor: null,
          spendMinor: rowFresh ? row!.spendMinor : null, lifetimeBudgetMinor: r.approvedLifetimeMinor, boundMinor: r.plannedMaxMinor, endAt: null,
          sourceUpdatedAt: row ? (stored?.sourceUpdatedAt ?? null) : null, fresh: rowFresh });
        continue;
      }
      const lifetime = rowFresh ? row!.lifetimeBudgetMinor : readback?.lifetimeBudgetMinor ?? null;
      const endAt = rowFresh ? row!.endAt : readback?.endAt ?? null;
      // Not yet reported only when no report row for it was ever stored; an ignored out-of-order report is not that.
      const justLaunched = !row && !stored && this.fresh(r.confirmedAt, freshness);
      const spend = rowFresh ? row!.spendMinor : null;
      if (spend === null) holds.push(`SPEND_UNKNOWN:${r.campaignId}`);
      if (r.pausedAt && row && rowFresh && LIVE.includes(row.status)) triggers.push(`PAUSED_CAMPAIGN_REACTIVATED:${r.campaignId}`);
      const bound = lifetime === null ? null : lifetime + headroom(lifetime, bps);
      if (lifetime === null) exposureReasons.push(`NATIVE_LIFETIME_CAP_UNAVAILABLE:${r.campaignId}`);
      if (spend === null && !justLaunched) exposureReasons.push(`SPEND_STALE:${r.campaignId}`);
      if (endAt === null) exposureReasons.push(`END_DATE_UNBOUNDED:${r.campaignId}`);
      else if (ms(endAt) > ms(terms.endAt)) exposureReasons.push(`END_DATE_BEYOND_STAGE:${r.campaignId}`);
      if (lifetime !== null && lifetime > r.approvedLifetimeMinor) triggers.push(`NATIVE_CAP_EXCEEDS_APPROVED:${r.campaignId}`);
      if (bound !== null && spend !== null && spend > bound) triggers.push(`OVERDELIVERY_BEYOND_HEADROOM:${r.campaignId}`);
      if ((rowFresh && (row!.maxDelivery || row!.autoRecharge || row!.extraDeliveryBudget)) || (readback && (readback.maxDelivery || readback.autoRecharge || readback.extraDeliveryBudget)))
        triggers.push(`ADDITIONAL_DELIVERY_ENABLED:${r.campaignId}`);
      campaigns.push({ campaignId: r.campaignId, key: key ?? `pending|${r.reservationId}`, reservation: "committed", status: row?.status ?? readback?.status ?? null,
        dailyBudgetMinor: rowFresh ? row!.dailyBudgetMinor : readback?.dailyBudgetMinor ?? null,
        spendMinor: spend, lifetimeBudgetMinor: lifetime, boundMinor: bound === null ? null : Math.max(bound, spend ?? 0), endAt,
        sourceUpdatedAt: rowFresh ? (spendRows.find((x) => x.key === key)?.sourceUpdatedAt ?? null) : null, fresh: rowFresh });
    }

    for (const a of terms.allocations) {
      const inAlloc = mine.filter((r) => allocKey(r) === allocKey(a));
      const rows = campaigns.filter((c) => inAlloc.some((r) => r.campaignId === c.campaignId));
      const committed = rows.filter((c) => c.reservation === "committed"), pending = rows.filter((c) => c.reservation === "pending");
      const pendingMinor = pending.reduce((n, c) => n + (c.boundMinor ?? 0), 0);
      const spendMinor = sum(committed.map((c) => c.spendMinor));
      const campaignBound = committed.some((c) => exposureReasons.some((x) => x.endsWith(`:${c.campaignId}`))) ? null : sum(committed.map((c) => c.boundMinor));
      const rep = reports.get(allocKey(a)) ?? null;
      const repFresh = !!rep && this.fresh(rep.sourceUpdatedAt, freshness);
      const limit = repFresh ? rep!.accountSpendLimitMinor : null, accountSpend = repFresh ? rep!.accountSpendMinor : null;
      // An account at its native spend limit cannot spend more, but the limit never stands in for missing campaign caps.
      if (limit !== null && accountSpend !== null && accountSpend >= limit) holds.push(`ACCOUNT_SPEND_LIMIT_REACHED:${a.provider}:${a.providerAccountRef}`);
      // The native lifetime caps plus headroom must themselves fit the allocation. An account limit is reported as an extra bound only.
      const committedExposure = committed.length === 0 ? 0 : campaignBound;
      const plannedMaxMinor = committedExposure === null ? null : committedExposure + pendingMinor;
      if (committed.length && committedExposure === null) exposureReasons.push(`ALLOCATION_EXPOSURE_UNDEMONSTRATED:${a.provider}:${a.providerAccountRef}`);
      if (spendMinor !== null && spendMinor >= a.capMinor) triggers.push(`ALLOCATION_CAP_EXHAUSTED:${a.provider}:${a.providerAccountRef}`);
      if (plannedMaxMinor !== null && plannedMaxMinor > a.capMinor) triggers.push(`ALLOCATION_EXPOSURE_EXCEEDS_CAP:${a.provider}:${a.providerAccountRef}`);
      allocations.push({ provider: a.provider, providerAccountRef: a.providerAccountRef, environment: a.environment, capMinor: a.capMinor, spendMinor, pendingMinor,
        plannedMaxMinor, accountLimitMinor: limit, accountSpendMinor: accountSpend });
    }
    const stageSpend = sum(allocations.map((a) => a.spendMinor));
    const stagePlanned = sum(allocations.map((a) => a.plannedMaxMinor));
    const pendingMinor = allocations.reduce((n, a) => n + a.pendingMinor, 0);
    if (stageSpend !== null && stageSpend >= terms.capMinor) triggers.push("STAGE_CAP_EXHAUSTED");
    if (stagePlanned !== null && stagePlanned > terms.capMinor) triggers.push("STAGE_EXPOSURE_EXCEEDS_CAP");
    if (exposureReasons.length) holds.push("EXPOSURE_UNDEMONSTRATED");
    const exposure: ExposureView = { demonstrated: exposureReasons.length === 0 && stagePlanned !== null, reasons: [...new Set(exposureReasons)], capMinor: terms.capMinor,
      spendMinor: stageSpend, pendingMinor, plannedMaxMinor: stagePlanned, remainingMinor: stagePlanned === null ? null : terms.capMinor - stagePlanned, allocations, campaigns };

    const stageNative = new Map(mine.filter((r) => r.nativeCampaignId || views.get(r.campaignId)?.native.nativeCampaignId)
      .map((r) => [campaignKey(r, (r.nativeCampaignId ?? views.get(r.campaignId)!.native.nativeCampaignId)!), r]));
    const spendByKey = new Map(campaigns.map((c) => [c.key, c.spendMinor]));
    const { economics, orders, conversions } = this.economics(s, set, freshness, stageNative, reportRows, stageSpend, spendByKey, corrections, freshnessView);
    if (economics.diagnostic.state === "breached") triggers.push("MAX_TEST_LOSS_REACHED");
    // Spend at the adopted maximum test loss while contribution is unknown or negative cannot be shown to be within it: pause.
    const contribution = economics.canonical.contributionMinor;
    if (economics.diagnostic.maxTestLossMinor !== null && stageSpend !== null && stageSpend >= economics.diagnostic.maxTestLossMinor
      && (contribution === null || contribution < 0)) triggers.push("MAX_TEST_LOSS_UNDEMONSTRATED");

    const health = this.health(s, freshnessView);
    for (const h of health) {
      if (h.state === "failed") triggers.push(HEALTH_TRIGGER[h.check]);
      if (h.state === "unknown") holds.push(`HEALTH_UNKNOWN:${h.check}`);
    }
    const treasury = this.treasury(s, set, freshness, stageSpend, opts.extraExposureMinor ?? 0, freshnessView);
    if (treasury.state !== "within") holds.push(treasury.state === "exceeds" ? "FOUNDER_CASH_CEILING_EXCEEDED" : "TREASURY_UNKNOWN");

    if (s.canonical && !opts.canonicalDecisionCurrent) holds.push("CANONICAL_STAGE_REVALIDATION_REQUIRED");
    if (s.state === "released" && s.decisionRef && !s.canonical) {
      try { this.currentStageDecision(s, s.decisionRef); } catch (error) {
        if (!passthrough(error)) throw error;
        const d = parse(stageDecisionSchema, this.resolve(this.authority.stageDecision && (() => this.authority.stageDecision!(s.decisionRef!, this.scope))));
        if (d?.state === "revoked" || d?.decision === "rejected") triggers.push("STAGE_DECISION_REVOKED");
        else holds.push(`STAGE_DECISION_${(error as Error).message === "J04_DECISION_NOT_CURRENT" ? "EXPIRED" : "UNVERIFIED"}`);
      }
    }
    for (const i of s.incidents) if (!i.resolvedAt) holds.push(`INCIDENT_OPEN:${i.code}`);
    const review = this.reviewWindow(set);
    const recommendations: ObservationView["recommendations"] = [];
    const uniqueTriggers = [...new Set(triggers)], uniqueHolds = [...new Set(holds)];
    for (const t of uniqueTriggers) recommendations.push({ action: "pause", reason: t });
    if (economics.canonicalCpaMinor !== null && economics.diagnostic.maxCpaMinor !== null && economics.canonicalCpaMinor > economics.diagnostic.maxCpaMinor
      && economics.scale.reasons.every((r) => !r.startsWith("MINIMUM_EVIDENCE"))) recommendations.push({ action: "reduce-budget", reason: "CPA_ABOVE_ADOPTED_MAXIMUM" });
    if (uniqueHolds.length) recommendations.push({ action: "hold", reason: uniqueHolds[0]! });
    if (economics.scale.state === "met" && !uniqueTriggers.length && !uniqueHolds.length) recommendations.push({ action: "review", reason: "SCALE_CRITERIA_MET" });
    return {
      view: { kind: "media-release-observation", stageRef: s.stageRef, observedAt: at, exposure, economics, health, treasury, freshness: freshnessView, corrections,
        safetyTriggers: uniqueTriggers, holds: uniqueHolds, recommendations, review: { open: review.open, nextReviewAt: review.nextReviewAt, nextSafetyCheckAt: review.nextSafetyCheckAt } },
      spendRows, orders, conversions, reconcile, untracked, gateUpdates,
    };
  }

  /**
   * Contribution from canonical retained orders matched to stage campaigns, with only adopted cost inputs, kept apart from platform-attributed
   * purchases. Duplicate native/mirror conversions are counted once, and late refunds and conversions are recorded as corrections.
   */
  private economics(s: StoredStage, set: ParameterSet | null, freshness: number | null, stageNative: Map<string, StoredReservation>,
    reportRows: Map<string, SpendReport["campaigns"][number] & { alloc: string; fresh: boolean }>, spendMinor: number | null,
    spendByKey: Map<string, number | null>, corrections: ObservationView["corrections"], freshnessView: ObservationView["freshness"]): { economics: EconomicsView; orders: OrderRow[]; conversions: ConversionRow[] } {
    const now = this.now().getTime(), at = this.iso(), unknown: string[] = [];
    const stageStart = ms(s.terms.startAt), stageEnd = ms(s.terms.endAt);
    // Canonical orders.
    const feed = parse(orderFeedSchema, this.resolve(this.authority.orders && (() => this.authority.orders!({ stageRef: s.stageRef, startAt: s.terms.startAt, endAt: s.terms.endAt }, this.scope))));
    const feedOk = !!feed && sameScope(feed.scope, this.scope) && ms(feed.observedAt) <= now;
    freshnessView.push({ source: "orders", sourceUpdatedAt: feedOk ? feed!.observedAt : null, observedAt: feedOk ? feed!.observedAt : null, fresh: feedOk && this.fresh(feed!.observedAt, freshness) });
    if (!feedOk) unknown.push("ORDERS_UNAVAILABLE");
    else if (!feed!.complete) unknown.push("ORDERS_INCOMPLETE");
    else if (!this.fresh(feed!.observedAt, freshness)) unknown.push("ORDERS_STALE");
    const effective = new Map<string, OrderRow>();
    const conflicts = new Set<string>();
    for (const row of this.db.prepare("SELECT body FROM media_control_orders").all()) { const o = JSON.parse(String(row.body)) as OrderRow; effective.set(o.key, o); }
    const changed: OrderRow[] = [];
    const seenInFeed = new Map<string, OrderRow>();
    for (const o of feedOk ? feed!.orders : []) {
      const key = `order|${o.source}|${o.orderRef}`;
      if (!(ms(o.updatedAt) <= now) || !(ms(o.placedAt) <= ms(o.updatedAt))) { unknown.push(`ORDER_TIME_INVALID:${key}`); continue; }
      const row: OrderRow = { ...o, key };
      const dup = seenInFeed.get(key);
      if (dup) {
        if (dup.updatedAt === row.updatedAt && digest(dup) !== digest(row)) conflicts.add(key);
        if (ms(dup.updatedAt) >= ms(row.updatedAt)) continue;
      }
      seenInFeed.set(key, row);
    }
    for (const row of seenInFeed.values()) {
      const prior = effective.get(row.key);
      if (prior && ms(prior.updatedAt) > ms(row.updatedAt)) continue;
      if (prior && (row.refundedMerchandiseMinor > prior.refundedMerchandiseMinor || row.refundedShippingMinor > prior.refundedShippingMinor))
        corrections.push({ kind: "late-refund", key: row.key, detail: `${prior.refundedMerchandiseMinor + prior.refundedShippingMinor} -> ${row.refundedMerchandiseMinor + row.refundedShippingMinor}`, at });
      if (!prior || digest(prior) !== digest(row)) changed.push(row);
      effective.set(row.key, row);
    }
    for (const key of conflicts) unknown.push(`ORDER_FEED_CONFLICT:${key}`);
    // GMV Max and other campaigns that count organic and affiliate outcomes are not incremental paid acquisition. Their orders and spend
    // stay out of paid CPA unless the owner adopted incremental evidence for that exact campaign.
    const evidenceReasons: string[] = [];
    const lift = set?.incrementalEvidence === undefined ? null : this.adopted<{ provider: string; providerAccountRef: string; environment: string; nativeCampaignId: string }[]>(
      "incrementalEvidence", set.incrementalEvidence, evidenceReasons);
    // Without a report row the classification is unknown, so it is not treated as paid either.
    const nonIncremental = new Set([...stageNative.keys()].filter((k) => (reportRows.get(k)?.includesOrganicAffiliate ?? true)
      && !(lift ?? []).some((e) => campaignKey(e, e.nativeCampaignId) === k)));
    const keyOf = (m: NonNullable<OrderRow["paidMediaMatch"]>) =>
      [...stageNative.keys()].find((k) => k.endsWith(`|${m.nativeCampaignId}`) && k.startsWith(`campaign|${m.provider}|${m.providerAccountRef}|`)) ?? null;
    const matched = [...effective.values()].filter((o) => {
      const m = o.paidMediaMatch;
      if (!m || !(ms(o.placedAt) >= stageStart && ms(o.placedAt) <= Math.min(now, stageEnd))) return false;
      return !!keyOf(m);
    });
    const incrementalOrders = matched.filter((o) => !nonIncremental.has(keyOf(o.paidMediaMatch!)!)).length;
    // Contribution inputs, each adopted or unknown.
    const c = set?.contribution;
    const inputs: string[] = [];
    const need = <T>(name: string, entry: unknown) => this.adopted<T>(name, entry as never, inputs);
    let cogsPerUnit: number | null = null;
    if (matched.length) {
      const comps = need<{ component: string; amountMinor: number }[]>("landedCogsPerUnit", c?.landedCogsPerUnit);
      if (comps) {
        const dupes = comps.map((x) => x.component).filter((x, i, all) => all.indexOf(x) !== i);
        if (dupes.length) inputs.push(...dupes.map((d) => `COST_COUNTED_TWICE:${d}`)); else cogsPerUnit = comps.reduce((n, x) => n + x.amountMinor, 0);
      }
    }
    const fulfillment = matched.length ? need<number>("fulfillmentPerOrderMinor", c?.fulfillmentPerOrderMinor) : 0;
    const other = matched.length ? need<number>("otherVariablePerOrderMinor", c?.otherVariablePerOrderMinor) : 0;
    const paymentFee = matched.some((o) => o.channel === "website") ? need<number>("paymentFeeBps", c?.paymentFeeBps) : 0;
    const marketplaceFee = matched.some((o) => o.channel === "tiktok-shop") ? need<number>("marketplaceFeeBps", c?.marketplaceFeeBps) : 0;
    const commissionBps = matched.some((o) => o.affiliateAttributed && o.commissionAccruedMinor === null) ? need<number>("affiliateCommissionBps", c?.affiliateCommissionBps) : 0;
    const returnBps = matched.some((o) => !o.returnWindowClosed) ? need<number>("returnAllowanceBps", c?.returnAllowanceBps) : 0;
    let retainedMerch = 0, retainedShip = 0, contribution: number | null = 0, commissions: number | null = 0;
    for (const o of matched) {
      const rm = o.merchandiseMinor - o.refundedMerchandiseMinor, rs = o.shippingCollectedMinor - o.refundedShippingMinor;
      retainedMerch += rm; retainedShip += rs;
      const feeBps = o.channel === "website" ? paymentFee : marketplaceFee;
      // An actual accrual is used when reported; the adopted rate only when it is not. A cost is never counted twice.
      const commission = !o.affiliateAttributed ? 0 : o.commissionAccruedMinor ?? (commissionBps === null ? null : Math.round((rm * commissionBps) / 10_000));
      commissions = commissions === null || commission === null ? null : commissions + commission;
      if (contribution === null || cogsPerUnit === null || fulfillment === null || other === null || feeBps === null || commission === null
        || (!o.returnWindowClosed && returnBps === null)) { contribution = null; continue; }
      const allowance = o.returnWindowClosed ? 0 : Math.round((rm * returnBps!) / 10_000);
      contribution += rm + rs - (o.units - o.returnedUnits) * cogsPerUnit - fulfillment - Math.round(((o.merchandiseMinor + o.shippingCollectedMinor) * feeBps) / 10_000)
        - commission - allowance - other;
    }
    const canonicalKnown = feedOk && feed!.complete && this.fresh(feed!.observedAt, freshness) && !conflicts.size && !unknown.some((u) => u.startsWith("ORDER_TIME"));
    if (!canonicalKnown || inputs.length) contribution = null;
    if (!canonicalKnown) commissions = null;
    unknown.push(...inputs);
    const orders = canonicalKnown ? matched.length : null;
    const perOrder = contribution !== null && orders ? Math.floor(contribution / orders) : null;

    // Platform-attributed purchases: deduplicated, never added to canonical orders. GMV Max value is never incremental paid ROAS.
    const pReasons: string[] = [];
    const window = this.adopted<string>("attributionWindow", set?.attributionWindow, pReasons);
    const stored = new Map<string, ConversionRow>();
    for (const row of this.db.prepare("SELECT body FROM media_control_conversions").all()) { const x = JSON.parse(String(row.body)) as ConversionRow; stored.set(x.key, x); }
    const counted = new Map<string, ConversionRow>(), newConversions: ConversionRow[] = [];
    let duplicates = 0, organic = false;
    for (const [key, row] of reportRows) {
      if (!stageNative.has(key)) continue;
      organic ||= row.includesOrganicAffiliate;
      if (window === null) continue;
      if (row.attributionWindow !== window) { pReasons.push(`ATTRIBUTION_WINDOW_MISMATCH:${row.nativeCampaignId}`); continue; }
      const [, provider, account, env] = key.split("|");
      for (const cv of row.conversions) {
        if (!(ms(cv.convertedAt) <= now)) { pReasons.push(`CONVERSION_TIME_INVALID:${cv.conversionId}`); continue; }
        if (ms(cv.convertedAt) < stageStart || ms(cv.convertedAt) > stageEnd) continue;
        const ckey = cv.orderRef && cv.orderSource ? `order|${cv.orderSource}|${cv.orderRef}` : `conversion|${provider}|${account}|${env}|${cv.conversionId}`;
        const prior = stored.get(ckey);
        const entry: ConversionRow = { key: ckey, provider: provider!, nativeKey: key, channel: cv.channel, convertedAt: cv.convertedAt, valueMinor: cv.valueMinor,
          firstSeenAt: prior?.firstSeenAt ?? at };
        if (counted.has(ckey)) { duplicates++; if (cv.channel === "native") counted.set(ckey, entry); continue; }
        counted.set(ckey, entry);
        if (!prior) {
          newConversions.push(entry);
          if (s.lastObservedAt && ms(cv.convertedAt) < ms(s.lastObservedAt)) corrections.push({ kind: "late-conversion", key: ckey, detail: cv.convertedAt, at });
        }
      }
    }
    for (const [k, v] of stored) if (!counted.has(k) && stageNative.has(v.nativeKey)) counted.set(k, v);
    const platform: EconomicsView["platform"] = { comparable: window !== null, purchases: window === null ? null : counted.size,
      valueMinor: window === null ? null : [...counted.values()].reduce((n, x) => n + x.valueMinor, 0),
      duplicatesRemoved: duplicates, includesOrganicAffiliate: organic, incrementalPaidRoas: null, excluded: [...new Set(pReasons)] };

    // Diagnostic loss and scale criteria, from adopted parameters only.
    const dReasons: string[] = [];
    const maxLoss = this.adopted<number>("maxTestLossMinor", set?.diagnostic.maxTestLossMinor, dReasons);
    const maxCpa = this.adopted<number>("maxCpaMinor", set?.diagnostic.maxCpaMinor, dReasons);
    // Loss uses all stage spend (conservative); CPA uses only incremental paid spend and orders.
    const loss = spendMinor !== null && contribution !== null ? spendMinor - contribution : null;
    const paidSpend = sum([...stageNative.keys()].filter((k) => !nonIncremental.has(k)).map((k) => spendByKey.get(k) ?? null));
    const paidOrders = orders === null ? null : incrementalOrders;
    const cpa = paidSpend !== null && paidOrders ? Math.ceil(paidSpend / paidOrders) : null;
    const allowable = perOrder === null ? null : Math.max(0, perOrder);
    const scaleUnknown: string[] = [], scaleNotMet: string[] = [];
    if (contribution === null) scaleUnknown.push("CONTRIBUTION_UNKNOWN");
    for (const k of nonIncremental) scaleUnknown.push(`${reportRows.has(k) ? "NOT_INCREMENTAL_PAID" : "INCREMENTALITY_UNKNOWN"}:${k.split("|").pop()}`);
    if (spendMinor === null) scaleUnknown.push("SPEND_UNKNOWN");
    const evidence = this.adopted<{ orders: number; spendMinor: number; days: number }>("minimumEvidence", set?.minimumEvidence, scaleUnknown);
    if (evidence) {
      const firstLaunch = Math.min(...[...stageNative.values()].map((r) => ms(r.confirmedAt)).filter(Number.isFinite));
      if (paidOrders !== null && paidOrders < evidence.orders) scaleNotMet.push("MINIMUM_EVIDENCE_ORDERS");
      if (spendMinor !== null && spendMinor < evidence.spendMinor) scaleNotMet.push("MINIMUM_EVIDENCE_SPEND");
      if (!Number.isFinite(firstLaunch) || now - firstLaunch < evidence.days * 86_400_000) scaleNotMet.push("MINIMUM_EVIDENCE_DAYS");
    }
    if (paidOrders === 0 && !nonIncremental.size) scaleNotMet.push("NO_RETAINED_ORDERS");
    else if (cpa !== null && allowable !== null && cpa > allowable) scaleNotMet.push("CPA_ABOVE_ALLOWABLE_ACQUISITION_COST");
    else if (paidOrders && allowable === null) scaleUnknown.push("ALLOWABLE_ACQUISITION_COST_UNKNOWN");
    const economics: EconomicsView = {
      parametersVersion: set?.version ?? null, unknownInputs: [...new Set(unknown)],
      canonical: { complete: canonicalKnown, orders, retainedMerchandiseMinor: canonicalKnown ? retainedMerch : null, retainedShippingMinor: canonicalKnown ? retainedShip : null,
        contributionMinor: contribution, contributionPerOrderMinor: perOrder, commissionsAccruedMinor: commissions },
      platform, spendMinor, incrementalPaidOrders: paidOrders, canonicalCpaMinor: cpa, allowableAcquisitionCostMinor: allowable,
      diagnostic: { maxTestLossMinor: maxLoss, lossMinor: loss, maxCpaMinor: maxCpa, state: maxLoss === null || loss === null ? "unknown" : loss > maxLoss ? "breached" : "within" },
      scale: { state: scaleUnknown.length ? "unknown" : scaleNotMet.length ? "not-met" : "met", reasons: [...scaleUnknown, ...scaleNotMet] },
    };
    return { economics, orders: changed, conversions: newConversions };
  }

  private health(s: StoredStage, freshnessView: ObservationView["freshness"]): ObservationView["health"] {
    const h = parse(healthSchema, this.resolve(this.authority.health && (() => this.authority.health!(s.stageRef, this.scope))));
    const ok = !!h && sameScope(h.scope, this.scope) && h.stageRef === s.stageRef;
    const now = this.now().getTime();
    return HEALTH_CHECKS.map((check) => {
      const e = ok ? h!.checks[check] : null;
      const current = !!e && ms(e.observedAt) <= now && ms(e.validUntil) > now;
      freshnessView.push({ source: `health:${check}`, sourceUpdatedAt: e?.observedAt ?? null, observedAt: e?.observedAt ?? null, fresh: current });
      return { check, state: current ? e!.state : "unknown", code: e?.code ?? null };
    });
  }

  /**
   * Founder cash invested stays within the adopted ceiling. The remaining authorization of every released stage (plus any being released)
   * is treated as committed. Payouts not yet received and revenue forecasts never count as cash; working float is not spendable.
   */
  private treasury(s: StoredStage, set: ParameterSet | null, freshness: number | null, stageSpend: number | null, extra: number,
    freshnessView: ObservationView["freshness"]): TreasuryView {
    const reasons: string[] = [];
    const ceiling = this.adopted<number>("founderCashCeilingMinor", set?.founderCashCeilingMinor, reasons);
    const t = parse(treasurySchema, this.resolve(this.authority.treasury && (() => this.authority.treasury!(this.scope))));
    const ok = !!t && sameScope(t.scope, this.scope) && ms(t.observedAt) <= this.now().getTime();
    const isFresh = ok && this.fresh(t!.observedAt, freshness);
    freshnessView.push({ source: "treasury", sourceUpdatedAt: ok ? t!.observedAt : null, observedAt: ok ? t!.observedAt : null, fresh: isFresh });
    if (!ok) reasons.push("TREASURY_UNAVAILABLE"); else if (!isFresh) reasons.push("TREASURY_STALE");
    // Media exposure is each released stage's cap (or its spend, if higher) less what has already been charged to cash. Spend accrued but
    // not yet billed is still owed, so it counts; charged spend is already out of cash, so it is not counted twice.
    let media = extra;
    for (const other of this.stages()) {
      if (other.state !== "released" && other.stageRef !== s.stageRef) continue;
      if (other.stageRef === s.stageRef && s.state !== "released") continue;
      const spent = other.stageRef === s.stageRef ? stageSpend : this.lastObservation(other)?.exposure.spendMinor ?? null;
      media += Math.max(other.terms.capMinor, spent ?? 0);
    }
    const charged = ok ? t!.mediaChargedMinor : null;
    if (ok && charged === null) reasons.push("TREASURY_MEDIA_CHARGED_UNKNOWN");
    media = Math.max(0, media - (charged ?? 0));
    const fields = ok ? { founder: t!.founderInvestedMinor, cash: t!.actualCashMinor, float: t!.workingFloatMinor, commitments: t!.commitmentsMinor } : null;
    if (fields) for (const [k, v] of Object.entries(fields)) if (v === null) reasons.push(`TREASURY_${k.toUpperCase()}_UNKNOWN`);
    const spendable = fields && fields.cash !== null && fields.float !== null ? Math.max(0, fields.cash - fields.float) : null;
    const projected = fields && fields.founder !== null && fields.commitments !== null && spendable !== null
      ? fields.founder + Math.max(0, fields.commitments + media - spendable) : null;
    const state = reasons.length || projected === null || ceiling === null ? "unknown" : projected > ceiling ? "exceeds" : "within";
    return { state, reasons, ceilingMinor: ceiling, founderInvestedMinor: fields?.founder ?? null, spendableCashMinor: spendable, commitmentsMinor: fields?.commitments ?? null,
      mediaExposureMinor: media, mediaChargedMinor: charged, projectedFounderInvestedMinor: projected, excludedPayoutsMinor: ok ? t!.scheduledPayouts.reduce((n, p) => n + p.amountMinor, 0) : 0,
      excludedForecastMinor: ok ? t!.revenueForecastMinor : null, observedAt: ok ? t!.observedAt : null };
  }

  private lastObservation(s: StoredStage): ObservationView | null {
    if (!s.lastObservationId) return null;
    const row = this.db.prepare("SELECT body FROM media_control_observations WHERE observation_id=?").get(s.lastObservationId);
    return row ? JSON.parse(String(row.body)) as ObservationView : null;
  }
  /** Persists the observation: cumulative spend, orders, conversions, corrections and reconciled reservations. Never moves state backwards. */
  private persist(s: StoredStage, e: Evaluation): ObservationView {
    for (const r of e.spendRows) this.db.prepare("INSERT INTO media_control_spend VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(r.key, JSON.stringify(r));
    for (const o of e.orders) this.db.prepare("INSERT INTO media_control_orders VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(o.key, JSON.stringify(o));
    for (const c of e.conversions) this.db.prepare("INSERT INTO media_control_conversions VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(c.key, JSON.stringify(c));
    for (const c of e.view.corrections) this.db.prepare("INSERT INTO media_control_corrections(stage_ref,body) VALUES(?,?)").run(s.stageRef, JSON.stringify(c));
    for (const rc of e.reconcile) {
      const r = this.reservations("reservation_id=?", rc.reservationId)[0];
      if (!r || r.state !== "pending") continue;
      if (r.lease && ms(r.lease.until) > this.now().getTime()) continue;
      Object.assign(r, { state: rc.to, nativeCampaignId: rc.nativeCampaignId ?? r.nativeCampaignId, gates: rc.gates, confirmedAt: rc.to === "committed" ? this.iso() : null,
        pausedAt: rc.paused ? this.iso() : r.pausedAt, lease: null });
      this.saveReservation(r);
    }
    for (const g of e.gateUpdates) {
      const r = this.reservations("reservation_id=?", g.reservationId)[0];
      if (r) { r.gates = g.gates; this.saveReservation(r); }
    }
    const view: ObservationView = { ...e.view, observationId: `observation-${digest({ stage: s.stageRef, at: e.view.observedAt, n: this.observationCount() }).slice(0, 32)}` };
    this.db.prepare("INSERT INTO media_control_observations VALUES(?,?,?,?)").run(view.observationId, s.stageRef, view.observedAt, JSON.stringify(view));
    Object.assign(s, { lastObservationId: view.observationId, lastObservedAt: view.observedAt });
    this.saveStage(s);
    return view;
  }
  private observationCount() { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM media_control_observations").get()?.n ?? 0); }

  canonicalStageRequest(stageRef:string) {
    const s=this.requireStage(stageRef);return structuredClone({stageRef:s.stageRef,revision:s.revision,terms:s.terms,subjectHash:s.subjectHash,
      canonical:s.canonical??null});
  }
  /** Current policy/economics/exposure checks reused by the canonical registry; no approval is invented here. */
  assertCanonicalStage(stageRef:string,assertCurrent:()=>void,forRelease=false) {
    const s=this.requireStage(stageRef),{set}=this.parameters();assertCurrent();
    const reasons=this.policyReasons(s.terms,set),window=this.reviewWindow(set);
    if(reasons.length)throw new AgentConflict(reasons[0]!);if(!window.open)throw new AgentConflict(window.reasons[0]??"REVIEW_WINDOW_CLOSED");
    const earlier=this.stages().filter(x=>x.terms.ordinal<s.terms.ordinal);
    if(earlier.length!==s.terms.ordinal-1||earlier.some(x=>x.state!=="released"||!x.canonical))throw new AgentConflict("EARLIER_STAGE_NOT_RELEASED");
    const e=this.evaluate(s,{canonicalDecisionCurrent:true,extraExposureMinor:forRelease&&!s.canonical?s.terms.capMinor:0});
    const blocking=[...e.view.safetyTriggers,...e.view.holds];if(blocking.length)throw new AgentConflict(blocking[0]!);assertCurrent();
  }
  assertCanonicalBudgetChange(campaignId:string,dailyBudgetMinor:number,assertCurrent:()=>void) {
    assertCurrent();const r=this.reservations("campaign_id=? AND active=1",campaignId)[0];if(!r)throw new AgentConflict("CAMPAIGN_NOT_IN_STAGE");
    const s=this.requireStage(r.stageRef),view=this.evaluate(s,{canonicalDecisionCurrent:true}).view,v=this.readCampaign(campaignId);
    const current=v?.native.readback?.dailyBudgetMinor;if(current===null||current===undefined)throw new AgentConflict("NATIVE_BUDGET_UNKNOWN");
    const kind=dailyBudgetMinor>current?"increase-budget":"reduce-budget",reasons=this.changeBlockers(s,r.confirmedAt?{...r,state:"committed"}:r,kind,dailyBudgetMinor,view,v);
    if(reasons.length)throw new AgentConflict(reasons[0]!);assertCurrent();
  }
  recordCanonicalStage(stageRef:string,revision:number,proof:VerifiedApprovalProof,receipt:DispatchReceipt,assertCurrent:()=>void) {
    return this.tx(()=>{const s=this.requireStage(stageRef);assertCurrent();
      if(s.revision!==revision||proof.binding.actionKind!=="media.stageRelease"||proof.binding.phase!=="mediaStageRelease"||
        proof.binding.itemRef!==stageRef||proof.binding.itemVersion!==String(revision)||proof.decisionReceipt.decision!=="approved"||
        receipt.dispatchKey.length===0||receipt.sourceEffect!=="localArtifact")throw new AgentConflict("MEDIA_STAGE_CANONICAL_PROOF_REQUIRED");
      if(s.canonical){if(digest(s.canonical.binding)!==digest(proof.binding)||digest(s.canonical.receipt)!==digest(receipt))throw new AgentConflict("MEDIA_STAGE_ALREADY_RECORDED");return structuredClone(s.canonical.receipt);}
      this.assertCanonicalStage(stageRef,assertCurrent,true);
      s.canonical={binding:structuredClone(proof.binding),receipt:structuredClone(receipt),decisionReceiptRef:proof.decisionReceipt.receiptRef};
      s.decisionRef=proof.decisionReceipt.receiptRef;s.decision="approved";s.decisionValidUntil=proof.validUntil;s.releasedAt=this.iso();s.heldReasons=[];
      this.move(s,"released",receipt.receiptRef);this.saveStage(s);return structuredClone(receipt);
    });
  }
  /** The existing stage reservation owner issues the single exclusive budget grant; no separate budget is debited. */
  reserveCanonicalExposure(input:{stageRef:string;campaignId:string;dispatchKey:string;resourceRef:string;quantity:number;validUntil:string},assertCurrent:()=>void):ResourceGrant {
    return this.tx(()=>{assertCurrent();const s=this.requireStage(input.stageRef);if(!s.canonical)throw new AgentConflict("CANONICAL_STAGE_REQUIRED");
      this.assertCanonicalStage(input.stageRef,assertCurrent);const v=this.readCampaign(input.campaignId);
      if(!v?.manifest)throw new AgentConflict("CAMPAIGN_UNKNOWN");
      const binding={provider:v.provider,providerAccountRef:v.manifest.account.providerAccountRef,environment:v.environment};
      const allocation=s.terms.allocations.find(a=>allocKey(a)===allocKey(binding));if(!allocation)throw new AgentConflict("CAMPAIGN_OUTSIDE_STAGE_ALLOCATIONS");
      const planned=v.manifest.caps.lifetimeBudgetMinor+headroom(v.manifest.caps.lifetimeBudgetMinor,s.terms.headroomBps);
      if(planned!==input.quantity||Date.parse(input.validUntil)<=this.now().getTime())throw new AgentConflict("MEDIA_EXPOSURE_GRANT_MISMATCH");
      const active=this.reservations("active=1"),existing=active.find(r=>r.campaignId===input.campaignId);
      if(existing&&(existing.stageRef!==s.stageRef||existing.safetyHold&&!existing.safetyHold.resolvedAt||existing.pausedAt))throw new AgentConflict("MEDIA_RESERVATION_HELD");
      if((existing?.state==="pending"||existing?.canonicalPendingKey)&&existing.canonicalGrant?.dispatchKey!==input.dispatchKey)throw new AgentConflict("MEDIA_RESERVATION_UNCERTAIN");
      const other=active.filter(r=>r.campaignId!==input.campaignId&&r.stageRef===s.stageRef);
      if(other.reduce((n,r)=>n+r.plannedMaxMinor,0)+planned>s.terms.capMinor||other.filter(r=>allocKey(r)===allocKey(binding)).reduce((n,r)=>n+r.plannedMaxMinor,0)+planned>allocation.capMinor)
        throw new AgentConflict("STAGE_AUTHORIZATION_EXHAUSTED");
      const grant:ResourceGrant={grantRef:`media-grant:${digest({stage:s.stageRef,dispatch:input.dispatchKey})}`,issuerRef:"media-control-reservations",allocationVersion:s.subjectHash,
        scope:s.canonical.binding.scope,dispatchKey:input.dispatchKey,dimension:"budget",resourceRef:input.resourceRef,quantity:planned,unit:"minor",currency:"USD",
        observedAt:this.iso(),validUntil:input.validUntil,exclusive:true};
      if(existing?.canonicalGrant?.dispatchKey===input.dispatchKey){
        const material=(value:ResourceGrant)=>({...value,observedAt:undefined,validUntil:undefined});
        if(digest(material(existing.canonicalGrant))!==digest(material(grant))||existing.plannedMaxMinor!==planned)throw new AgentConflict("MEDIA_GRANT_CHANGED");
        // Renew only the source lease after all current owner/J04/pool checks; keep the same exclusive reservation and effect identity.
        existing.canonicalGrant=grant;this.saveReservation(existing);assertCurrent();return structuredClone(grant);
      }
      const r:StoredReservation=existing??{reservationId:`reservation-${digest({stage:s.stageRef,campaign:input.campaignId}).slice(0,32)}`,stageRef:s.stageRef,campaignId:input.campaignId,...binding,
        nativeCampaignId:v.native.nativeCampaignId,plannedMaxMinor:planned,approvedLifetimeMinor:v.manifest.caps.lifetimeBudgetMinor,state:"pending",createdAt:this.iso(),confirmedAt:null,lastChangeAt:null,pausedAt:null,gates:[]};
      r.canonicalGrant=grant;r.canonicalPendingKey=input.dispatchKey;if(!r.confirmedAt)r.state="pending";this.saveReservation(r);assertCurrent();return structuredClone(grant);
    });
  }
  assertCanonicalExposure(grant:ResourceGrant,assertCurrent:()=>void){assertCurrent();const r=this.reservations("active=1").find(x=>x.canonicalGrant?.grantRef===grant.grantRef);
    if(!r||digest(r.canonicalGrant)!==digest(grant)||Date.parse(grant.validUntil)<=this.now().getTime()||r.pausedAt||r.safetyHold&&!r.safetyHold.resolvedAt)throw new AgentConflict("MEDIA_GRANT_NOT_CURRENT");}
  settleCanonicalExposure(identity:MediaOperationIdentity,state:"applied"|"notApplied"|"unknown"){this.tx(()=>{
    const r=this.reservations("campaign_id=? AND active=1",identity.campaignId)[0];
    if(!r||r.canonicalGrant?.dispatchKey!==identity.dispatchKey||!this.media.isCurrentCanonicalAttempt(identity)||state==="unknown"||r.canonicalSettledAttemptRef===identity.attemptRef)return;
    if(state==="applied"){r.gates=(this.media.read(identity.campaignId)?.gates??[]).map(g=>({gate:g.gate,state:g.state}));r.state="committed";if(r.confirmedAt)r.lastChangeAt=this.iso();else r.confirmedAt=this.iso();r.canonicalPendingKey=null;}else{r.state=r.confirmedAt?"committed":"released";r.canonicalPendingKey=null;}
    r.canonicalSettledAttemptRef=identity.attemptRef;
    this.saveReservation(r);});}

  // ---------- propose and approve a stage ----------
  /** Records one stage's exact terms. Every stage starts held; nothing is released by proposing it. A change makes a new revision. */
  proposeStage(body: unknown, key: string): StageView {
    const terms = stageInputSchema.parse(body);
    const prior = this.bindKey(key, { op: "propose-stage", terms });
    return this.tx(() => {
      if (prior) return this.view(this.requireStage(prior));
      const existing = this.loadStage(terms.stageRef);
      if (existing?.state === "released") throw new AgentConflict("STAGE_ALREADY_RELEASED");
      const other = this.stages().find((x) => x.terms.ordinal === terms.ordinal && x.stageRef !== terms.stageRef);
      if (other) throw new AgentConflict("STAGE_ORDINAL_TAKEN");
      const subjectHash = digest({ scope: this.scope, terms });
      if (existing && existing.subjectHash === subjectHash && existing.state !== "rejected") { this.recordResult(key, existing.stageRef); return this.view(existing); }
      const reasons = this.policyReasons(terms, this.parameters().set);
      const s: StoredStage = existing ? { ...existing, revision: existing.revision + 1 } : {
        stageRef: terms.stageRef, revision: 1, state: "held", terms, subjectHash, proposedAt: this.iso(), heldReasons: [], decisionRef: null, decision: "none",
        decisionValidUntil: null, releasedAt: null, incidents: [], lastObservationId: null, lastObservedAt: null, history: [],
      };
      Object.assign(s, { terms, subjectHash, proposedAt: this.iso(), heldReasons: reasons, decisionRef: null, decision: "none", decisionValidUntil: null });
      this.move(s, reasons.length ? "held" : "awaiting-approval", null);
      this.saveStage(s);
      this.recordResult(key, s.stageRef);
      return this.view(s);
    });
  }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  decideStage(_stageRef: string, _decisionRef: string, _key: string): StageView { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  releaseStage(_stageRef: string, _key: string): StageView { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  // ---------- observe ----------
  /** Observes and reconciles one stage: spend, exposure, economics, health, treasury, corrections and safety triggers. Never mutates the provider. */
  observe(stageRef: string, key: string): ObservationView {
    const prior = this.bindKey(key, { op: "observe", stageRef });
    return this.tx(() => {
      const s = this.requireStage(stageRef);
      if (prior) { const row = this.db.prepare("SELECT body FROM media_control_observations WHERE observation_id=?").get(prior); if (row) return JSON.parse(String(row.body)) as ObservationView; }
      const view = this.persist(s, this.evaluate(s));
      this.recordResult(key, view.observationId);
      return view;
    });
  }

  // ---------- bounded execute: launch ----------
  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  async launch(_stageRef: string, _body: unknown, _key: string): Promise<LaunchView> { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }
  /**
   * Where a pending launch stands, from a matched media record. Confirmed or live on the provider commits it. It is released when no
   * publish write was ever attempted, or when the media module closed the attempted write as not applied: no publish receipt, no confirmed
   * pause (a pause proves it was live) and a read-back matched to this campaign, provider, account and environment, observed after the
   * reservation, showing it not live. Anything else stays pending, so possible spend is never freed.
   */
  private settle(v: CampaignView | null, reportLive: boolean, r: StoredReservation): { to: ReservationState; paused: boolean } | null {
    if (v?.state === "confirmed" || reportLive) return { to: "committed", paused: v?.native.status === "PAUSED" };
    if (!v || !NOT_WRITTEN.includes(v.state) || v.execution.pending) return null;
    if (v.sourceEffects !== "publish-attempted") return { to: "released", paused: false };
    if (v.mutations.some((m) => m.action === "pause" && m.state === "confirmed") || v.receipts.some((x) => x.kind === "publish")
      || v.providerReview.state !== "not-submitted") return { to: "committed", paused: !LIVE.includes(v.native.status ?? "") };
    const rb = v.native.readback, nativeId = r.nativeCampaignId ?? v.native.nativeCampaignId;
    const provenNotSent = !!rb && rb.nativeCampaignId === nativeId && rb.provider === r.provider && rb.providerAccountRef === r.providerAccountRef
      && rb.environment === r.environment && !LIVE.includes(rb.status) && ms(rb.observedAt) >= ms(r.createdAt) && ms(rb.observedAt) <= this.now().getTime();
    return provenNotSent ? { to: "released", paused: false } : null;
  }

  // ---------- propose and apply a change ----------
  /** The current blockers for one change. Increases are review-bound, need met scale criteria and respect the learning window. */
  private changeBlockers(s: StoredStage, r: StoredReservation, kind: ChangeKind, dailyBudgetMinor: number | null, view: Omit<ObservationView,"observationId">, v: CampaignView | null,
    retry = false): string[] {
    const reasons: string[] = [];
    if (r.state !== "committed") reasons.push("CAMPAIGN_NOT_LAUNCHED_IN_STAGE");
    if (kind === "pause") return reasons;
    // The current budget comes from this observation's fresh, matched report row or read-back, never from an older stored snapshot.
    const current = view.exposure.campaigns.find((x) => x.campaignId === r.campaignId)?.dailyBudgetMinor ?? null;
    if (current === null) reasons.push("CURRENT_BUDGET_UNKNOWN");
    // After an uncertain write the budget may already be the requested one, so direction is not re-checked on a retry.
    if (kind === "reduce-budget") { if (!retry && current !== null && dailyBudgetMinor !== null && dailyBudgetMinor >= current) reasons.push("NOT_A_REDUCTION"); return reasons; }
    if (r.pausedAt || v?.mutations.some((m) => m.action === "pause" && m.state === "confirmed")) reasons.push("SUPERSEDED_BY_PAUSE");
    if (!retry && current !== null && dailyBudgetMinor !== null && dailyBudgetMinor <= current) reasons.push("NOT_AN_INCREASE");
    if (s.state !== "released") reasons.push("STAGE_NOT_RELEASED");
    const { set } = this.parameters();
    const window = this.reviewWindow(set);
    if (!window.open) reasons.push(...window.reasons);
    const cadenceReasons: string[] = [];
    const cadence = this.adopted("reviewCadence", set?.reviewCadence, cadenceReasons);
    const since = Math.max(ms(r.confirmedAt), Number.isFinite(ms(r.lastChangeAt)) ? ms(r.lastChangeAt) : 0);
    if (cadence && this.now().getTime() - since < cadence.learningWindowHours * 3_600_000) reasons.push("LEARNING_WINDOW_ACTIVE");
    reasons.push(...cadenceReasons, ...view.safetyTriggers, ...view.holds);
    if (view.economics.scale.state !== "met") reasons.push(`SCALE_CRITERIA_${view.economics.scale.state === "unknown" ? "UNKNOWN" : "NOT_MET"}`, ...view.economics.scale.reasons);
    return [...new Set(reasons)];
  }

  /** Proposes one bounded change with its rationale and evidence. A ready change opens a THO-346 mutation for its own exact J04 decision. */
  proposeChange(stageRef: string, body: unknown, key: string): ChangeView {
    const input = changeInputSchema.parse(body);
    const prior = this.bindKey(key, { op: "propose-change", stageRef, input });
    if (prior) { const c = this.loadChange(prior); if (c) return this.changeView(c); }
    const step = this.tx(() => {
      const s = this.requireStage(stageRef);
      const r = this.reservations("campaign_id=? AND active=1", input.campaignId)[0];
      if (!r || r.stageRef !== stageRef) throw new AgentConflict("CAMPAIGN_NOT_IN_STAGE");
      const view = this.persist(s, this.evaluate(s));
      const reasons = this.changeBlockers(s, r, input.kind, input.dailyBudgetMinor, view, this.readCampaign(input.campaignId));
      const n = Number(this.db.prepare("SELECT COUNT(*) AS n FROM media_control_changes").get()?.n ?? 0);
      const c: StoredChange = {
        changeId: `change-${digest({ stageRef, input, n }).slice(0, 32)}`, stageRef, campaignId: input.campaignId, kind: input.kind, dailyBudgetMinor: input.dailyBudgetMinor,
        rationale: input.rationale, observationId: view.observationId, state: "held", heldReasons: reasons, mutationId: null, requestHash: null, authorizedBy: null,
        effect: { before: null, after: null }, history: [], createdAt: this.iso(),
      };
      this.moveChange(c, "held", null);
      this.saveChange(c);
      this.recordResult(key, c.changeId);
      return c;
    });
    if (step.heldReasons.length) return this.changeView(step);
    let mutation: MutationView | null = null, code: string | null = null;
    try {
      mutation = this.media.proposeMutation(step.campaignId, { kind: step.kind === "pause" ? "pause" : "edit-budget", dailyBudgetMinor: step.dailyBudgetMinor },
        `media-control:change:${step.changeId}`);
    } catch (error) { if (!passthrough(error)) throw error; code = (error as Error).message; }
    return this.tx(() => {
      const c = this.loadChange(step.changeId)!;
      if (!mutation || mutation.state !== "draft") { c.heldReasons = code ? [code] : mutation?.heldReasons.length ? mutation.heldReasons : ["MUTATION_NOT_READY"]; }
      else { Object.assign(c, { mutationId: mutation.mutationId, requestHash: mutation.requestHash, heldReasons: [] }); this.moveChange(c, "awaiting-approval", mutation.mutationId); }
      if (mutation) c.mutationId = mutation.mutationId;
      this.saveChange(c);
      return this.changeView(c);
    });
  }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  async applyChange(_changeId: string, _authorization: unknown, _key: string): Promise<ChangeView> { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  // ---------- safety ----------
  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  async runSafety(_stageRef: string, _body: unknown, _key: string): Promise<SafetyRunView> { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  // ---------- reads ----------
  read(stageRef: string): StageView | null { const s = this.loadStage(stageRef); return s ? this.view(s) : null; }
  readChange(changeId: string): ChangeView | null { const c = this.loadChange(changeId); return c ? this.changeView(c) : null; }
  readObservation(observationId: string): ObservationView | null {
    const row = this.db.prepare("SELECT body FROM media_control_observations WHERE observation_id=?").get(ref.parse(observationId));
    return row ? JSON.parse(String(row.body)) as ObservationView : null;
  }
  private changeView(c: StoredChange): ChangeView {
    return { kind: "media-release-change", changeId: c.changeId, stageRef: c.stageRef, campaignId: c.campaignId, changeKind: c.kind, dailyBudgetMinor: c.dailyBudgetMinor,
      rationale: c.rationale, observationId: c.observationId, state: c.state, heldReasons: c.heldReasons, mutationId: c.mutationId, requestHash: c.requestHash,
      authorizedBy: c.authorizedBy, effect: c.effect, history: c.history };
  }
  private view(s: StoredStage): StageView {
    const last = this.lastObservation(s);
    const reservations = this.reservations("stage_ref=?", s.stageRef).map((r) => ({ reservationId: r.reservationId, campaignId: r.campaignId, provider: r.provider,
      providerAccountRef: r.providerAccountRef, environment: r.environment, plannedMaxMinor: r.plannedMaxMinor, state: r.state, confirmedAt: r.confirmedAt, gates: r.gates }));
    const open = s.state === "released" && !!last && !last.safetyTriggers.length && !last.holds.length && !s.incidents.some((i) => !i.resolvedAt);
    return { kind: "media-release-stage", stageRef: s.stageRef, revision: s.revision, ordinal: s.terms.ordinal, state: s.state, terms: s.terms, subjectHash: s.subjectHash,
      heldReasons: s.heldReasons, approval: { decision: s.decision, decisionRef: s.decisionRef, validUntil: s.decisionValidUntil }, dispatch: open ? "open" : "held",
      incidents: s.incidents, reservations, lastObservation: last, history: s.history };
  }
}
