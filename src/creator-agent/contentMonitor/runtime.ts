import { createHmac } from "node:crypto";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest } from "../config.ts";
import { capabilityIdForBinding } from "../connections/ledger.ts";
import type { FunnelRepository } from "../funnelStore.ts";
import type { JobRepository } from "../jobs/repository.ts";
import type { JobItemView } from "../jobs/schema.ts";
import type { JobRuntime } from "../jobs/runtime.ts";
import { RuntimeError, runtimeWindowPlanSchema, type RuntimeAuthority, type RuntimeExecutor, type RuntimeMembership, type RuntimeRegistration, type RuntimeRegistry,
  type RuntimeStep, type RuntimeWindow } from "../jobs/runtimeSchema.ts";
import { effectiveEvents } from "../monitor/posts.ts";
import type { FunnelEvent } from "../funnelContract.ts";
import type { MonitorSourceReader } from "../monitor/contract.ts";
import type { OperationsScope } from "../operations.ts";
import type { createProviderHealth } from "../providerHealth.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { j08Owners, j08PageSchema, j08PolicySchema, type J08Category, type J08Coverage, type J08Policy, type J08ReadRequest, type J08SourceReader,
  type J08Stage, type J08Subject } from "./contract.ts";
import { createContentMonitorView } from "./projection.ts";
import type { Committed, ContentMonitorRepository, Creative, J08ItemOutcome } from "./repository.ts";
import { orderAttribution } from "./rules.ts";

export type ContentMonitorBinding = {
  /** The J08 hourly registration. */
  registrationRef: string;
  /** Optional bounded manual recheck: an event-cadence registration on the same source binding, so each recheck re-reads. */
  manualRecheck?: { registrationRef: string };
  /** Server-owned reader of the current versioned J08 policy. It has no default; its digest is pinned and a change holds work. */
  policy: () => unknown;
  /** Read-only J08 source. It has no send, like, follow, accept, rate or approval method. */
  source: J08SourceReader;
  /** "synthetic" binds a sandbox fixture only; a "source" binding requires an approved policy and rejects synthetic pages. */
  evidenceStage: "synthetic" | "source";
};
type MembershipRecord = {
  creatorId: string; revision: number; identityState: string; watchlistEligibility: string; suppressed: boolean; sourceStatus: string;
  profiles: { network: string; accountId: string; sourceId: string | null }[];
  relationships: { campaignKey: string | null; state: string; recruitmentSource: string }[];
  handoffs: { target: string; state: string; receiptRef: string | null; revision: number; canonicalReceiptRef: string | null }[];
};
export type ContentMonitorMembership = { monitorMembership(limit?: number): { records: MembershipRecord[]; total: number; complete: boolean } };
type Health = Pick<ReturnType<typeof createProviderHealth>, "check" | "get" | "exceptions">;
export type ContentMonitorDeps = { intake: ContentMonitorMembership; funnel: Pick<FunnelRepository, "snapshot">; jobs: Pick<JobRepository, "getRun">;
  runtime: () => Pick<JobRuntime, "windowPages" | "takeovers"> | undefined; health?: () => Health | undefined; secret: string; now?: () => number };
type Eligible = J08Subject & { creatorId: string; revision: number; campaigns: string[]; notionReceipt: string; sheetsReceipt: string };
export type WindowRow = { subjectRef: string; runRef: string | null; item: JobItemView | null; outcome: J08ItemOutcome | null; category: J08Category; lastSuccessAt: string | null;
  notAdmitted?: "J08_PRIOR_PAGE_INCOMPLETE" | "J08_PAGE_NOT_YET_ADMITTED" };

// The runtime's own source lease ceiling. A page older than that is not a current observation.
const SOURCE_LEASE_MS = 15 * 60_000;
// Per-drain bounds for J14 routing. J14's own probe is itself bounded to 8 seconds.
const DRAIN_MAX_ROWS = 20, DRAIN_BUDGET_MS = 10_000;
// A cached ledger snapshot older than this is re-read, so a run resumed later never joins stale orders.
const LEDGER_MAX_AGE_MS = 60_000;
const takeoverKinds = { loginRequired: "login", mfaRequired: "mfa", captcha: "captcha", termsChanged: "termsChanged", uiDrift: "uiDrift" } as const;
const transientAccess = (access: string | null) => access === "throttled" || access === "unavailable";
/** The runtime checkpoint holds the stage and the bounded source cursor itself; there is no second cursor store. */
const encodeCursor = (stage: J08Stage, cursor: string | null) => `j08:${stage}:${cursor === null ? "-" : Buffer.from(cursor, "utf8").toString("base64url").replace(/_/g, ".")}`;
function decodeCursor(value: string): { stage: J08Stage; cursor: string | null } {
  const match = /^j08:(posts|inbox):([A-Za-z0-9.-]+)$/.exec(value);
  if (!match) throw new RuntimeError("J08_CHECKPOINT_UNKNOWN", 409);
  return { stage: match[1] as J08Stage, cursor: match[2] === "-" ? null : Buffer.from(match[2]!.replace(/\./g, "_"), "base64url").toString("utf8") };
}

function assertRegistration(r: RuntimeRegistration | undefined, registry: RuntimeRegistry, kind: "hourly" | "manual"): asserts r is RuntimeRegistration {
  const cadence = kind === "hourly" ? r?.family === "J08" && r.cadence.kind === "hourly" :
    r?.family === "registered-business" && r.cadence.kind === "event" && r.cadence.eventType === "j08-manual-recheck.v1";
  if (!r || !cadence || r.membership !== "enrolled-only" || r.definition.mode !== "observe" || !r.apiBinding || r.browserBinding ||
      r.apiChannel === "model" || r.definition.budgets.maxConcurrency !== 1 || registry.executors.has(r.executorRef) ||
      [...registry.registrations.values()].some(other => other.registrationRef !== r.registrationRef && other.executorRef === r.executorRef))
    throw new RuntimeError("J08_REGISTRATION_INVALID", 422);
}

/**
 * Binds J08 to the existing registered job runtime: cadence, window identity, account lease, checkpoint, stable idempotency and
 * run/item correlation stay with `JobRuntime`. J08 owns only its read-only executor, outputs and projection. The server composes
 * `composeAuthority` around the injected runtime authority so every J08 window plan is J08's frozen watchlist.
 */
export function bindContentMonitor(repo: ContentMonitorRepository, scope: OperationsScope, registry: RuntimeRegistry,
  binding: ContentMonitorBinding, deps: ContentMonitorDeps) {
  const hourly = registry.registrations.get(binding.registrationRef);
  assertRegistration(hourly, registry, "hourly");
  const manual = binding.manualRecheck ? registry.registrations.get(binding.manualRecheck.registrationRef) : undefined;
  if (binding.manualRecheck) {
    assertRegistration(manual, registry, "manual");
    if (digest(manual.apiBinding) !== digest(hourly.apiBinding) || manual.definition.policyVersion !== hourly.definition.policyVersion || manual.executorRef === hourly.executorRef)
      throw new RuntimeError("J08_REGISTRATION_INVALID", 422);
  }
  const registrations = [hourly, ...(manual ? [manual] : [])], refs = new Set(registrations.map(r => r.registrationRef));
  if (!["synthetic", "source"].includes(binding.evidenceStage) || typeof binding.source?.read !== "function" || typeof binding.source.assertCurrent !== "function")
    throw new RuntimeError("J08_SOURCE_INVALID", 422);
  const now = deps.now ?? Date.now, apiBinding = hourly.apiBinding!, apiBindingHash = digest(apiBinding), capabilityId = capabilityIdForBinding(apiBinding);
  const policyOf = (): J08Policy | null => { const parsed = j08PolicySchema.safeParse(binding.policy()); return parsed.success ? parsed.data : null; };
  const pinned = policyOf();
  if (!pinned || pinned.version !== hourly.definition.policyVersion) throw new RuntimeError("J08_POLICY_VERSION_MISMATCH", 422);
  if (binding.evidenceStage === "source" && pinned.approval.state !== "approved") throw new RuntimeError("J08_POLICY_UNAPPROVED", 422);
  const pinnedDigest = digest(pinned);
  const currentPolicy = () => { const policy = policyOf(); return policy && digest(policy) === pinnedDigest ? policy : null; };
  const key = createHmac("sha256", deps.secret).update(JSON.stringify(["j08-subject.v2", scope])).digest();
  // A row is keyed by its native profile, so a changed J01 creator ID never strands its content.
  const subjectRefOf = (network: string, accountId: string, profileId: string) =>
    `j08-subject:${createHmac("sha256", key).update(JSON.stringify([network, accountId, profileId])).digest("hex").slice(0, 48)}`;

  /** J01 owns membership. A row is eligible only while canonical, active, unsuppressed and enrolled through confirmed Notion/Sheets receipts. */
  function eligibleRows(): { rows: Eligible[]; complete: boolean } {
    const membership = deps.intake.monitorMembership(2000), rows: Eligible[] = [];
    for (const record of membership.records) {
      const campaigns = record.relationships.filter(r => r.state === "active" && r.campaignKey).map(r => r.campaignKey!);
      const confirmed = record.handoffs.filter(h => h.revision === record.revision && h.state === "confirmed" && h.receiptRef);
      const notion = confirmed.find(h => h.target === "notion-creator-crm"), sheets = confirmed.find(h => h.target === "sheets-watchlist" && h.canonicalReceiptRef === notion?.receiptRef);
      if (record.identityState !== "resolved" || record.watchlistEligibility !== "active" || record.suppressed || record.sourceStatus !== "verified" ||
          !campaigns.length || !notion || !sheets) continue;
      for (const p of record.profiles) if (p.sourceId && (p.network === "instagram" || p.network === "tiktok"))
        rows.push({ subjectRef: subjectRefOf(p.network, p.accountId, p.sourceId), creatorId: record.creatorId, network: p.network, accountId: p.accountId,
          profileId: p.sourceId, revision: record.revision, campaigns: [...campaigns].sort(), notionReceipt: notion.receiptRef!, sheetsReceipt: sheets.receiptRef! });
    }
    return { rows: rows.sort((a, b) => a.subjectRef.localeCompare(b.subjectRef)), complete: membership.complete };
  }
  const eligibleSubject = (subjectRef: string) => eligibleRows().rows.find(r => r.subjectRef === subjectRef) ?? null;

  /**
   * The whole eligible watchlist of a window: the frozen snapshot once admitted, otherwise a candidate. Candidates are ordered by a
   * per-window digest, so a persistently held row cannot sit on the same page and starve the same later rows every hour.
   */
  function watchlistFor(window: RuntimeWindow) {
    if (!refs.has(window.registrationRef)) throw new RuntimeError("J08_WINDOW_MISMATCH", 409);
    const frozen = repo.watchlist(window.windowRef);
    if (frozen) return { frozen, entries: frozen.entries, eligibilityPolicyVersion: frozen.eligibilityPolicyVersion, rows: null };
    // A new window needs the pinned policy; a refresh of a frozen window does not (the next item then holds instead).
    const policy = currentPolicy();
    if (!policy) throw new RuntimeError("J08_POLICY_VERSION_CHANGED", 409);
    const { rows, complete } = eligibleRows();
    if (!complete) throw new RuntimeError("J08_MEMBERSHIP_INCOMPLETE", 503);
    const ordered = rows.map(r => ({ subject: { subjectRef: r.subjectRef, network: r.network, accountId: r.accountId, profileId: r.profileId },
      enrollmentRef: `j01-enrollment:${digest([r.creatorId, r.revision, r.notionReceipt, r.sheetsReceipt])}`, order: digest([window.windowRef, r.subjectRef]) }))
      .sort((a, b) => a.order.localeCompare(b.order)).map(({ subject, enrollmentRef }) => ({ subject, enrollmentRef }));
    return { frozen: null, entries: ordered.map(r => ({ subjectRef: r.subject.subjectRef, enrollmentRef: r.enrollmentRef })),
      eligibilityPolicyVersion: policy.eligibilityPolicyVersion, rows: ordered };
  }
  /** The watchlist page for a window. Continuation pages exist only after the first page's snapshot was admitted and frozen. */
  function plan(window: RuntimeWindow, continuation: string | null): RuntimeMembership {
    const watch = watchlistFor(window);
    if (continuation !== null && !watch.frozen) throw new RuntimeError("J08_WATCHLIST_NOT_ADMITTED", 409);
    const offset = continuation === null ? 0 : Number(/^j08-page:(\d{1,6})$/.exec(continuation)?.[1] ?? NaN);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > watch.entries.length) throw new RuntimeError("J08_CONTINUATION_INVALID", 422);
    const max = registrations.find(r => r.registrationRef === window.registrationRef)!.definition.budgets.maxItems;
    const page = watch.entries.slice(offset, offset + max), more = offset + max < watch.entries.length;
    return { items: page.map(e => ({ itemKey: e.subjectRef, subjectRef: e.subjectRef, evidenceRef: null, enrollmentRef: e.enrollmentRef })),
      coverage: more ? "partial" : "complete", continuation: more ? `j08-page:${offset + max}` : null, total: watch.entries.length - offset };
  }
  /** Server composition: the injected source authority signs each J08 window lease over J08's own frozen membership, never its own list. */
  function composeAuthority(base: RuntimeAuthority): RuntimeAuthority {
    return {
      // Activation also backs runtime reads, so it never drains the outbox: reads stay free of provider calls and writes.
      resolveActivation: r => base.resolveActivation(r),
      assertActivation: (p, r, at) => base.assertActivation(p, r, at),
      async prepareWindow(input) {
        if (!refs.has(input.registration.registrationRef)) return base.prepareWindow(input);
        await drainRoutes();
        const watch = watchlistFor(input.window), membership = plan(input.window, input.continuation);
        const proof = await base.prepareWindow({ ...input, membership: structuredClone(membership) });
        const parsed = runtimeWindowPlanSchema.safeParse(proof);
        if (!parsed.success || parsed.data.kind !== "source" || digest({ items: parsed.data.items, coverage: parsed.data.coverage, continuation: parsed.data.continuation,
          total: parsed.data.total }) !== digest(membership)) throw new RuntimeError("J08_WINDOW_PLAN_MISMATCH", 502);
        // The watchlist freezes only once the source authority has signed this exact membership; a refused attempt freezes nothing.
        if (!watch.frozen && watch.rows) repo.freezeWatchlist(input.window.windowRef, watch.eligibilityPolicyVersion, watch.rows);
        return proof;
      },
      assertWindow: (p, r, at) => base.assertWindow(p, r, at), resolvePreflight: request => base.resolvePreflight(request),
      assertCurrent: (p, request, at) => base.assertCurrent(p, request, at), resolveTakeover: request => base.resolveTakeover(request),
      assertTakeover: (p, at) => base.assertTakeover(p, at),
    };
  }
  /** J14 owns source health: one routed check per window and condition for this source account, deduplicated by J14 itself. */
  async function routeToJ14(windowRef: string, condition: string): Promise<string> {
    const health = deps.health?.();
    if (!health) return "J14_NOT_COMPOSED";
    const eventId = `j08-${digest([windowRef, condition]).slice(0, 40)}`;
    try { return `J14_${(await health.check({ capabilityId, eventId }, eventId)).state.toUpperCase()}`; } catch { return "J14_ROUTE_UNAVAILABLE"; }
  }
  /**
   * Durable J14 routing. A failure row is persisted with its failure and acts as an outbox entry until J14 has answered. Every J08 window
   * admission or refresh drains it, so a crash or a failed call is retried; J14 deduplicates by event ID, so its probe runs once per
   * window and condition. Routing runs before the runtime's next items, never inside an item that is still being committed.
   */
  async function drainRoutes() {
    const started = Date.now();
    try {
      // Bounded per drain: a row cap and a time budget. The rest waits for the next mutating pass.
      for (const row of repo.unroutedFailures(DRAIN_MAX_ROWS)) {
        if (Date.now() - started > DRAIN_BUDGET_MS) break;
        const route = await routeToJ14(row.windowRef, row.reason);
        // Every J14 answer is recorded for visibility; only an observation leaves the outbox (`unroutedFailures`), so a held or
        // unconfigured answer is retried on the next drain.
        if (route !== "J14_ROUTE_UNAVAILABLE" && route !== "J14_NOT_COMPOSED") repo.noteHealthRoute(row.runRef, row.itemRef, row.subjectRef, row.windowRef, route);
      }
    } catch { /* Routing never blocks admission; unrouted rows stay in the outbox for the next pass. */ }
  }
  /**
   * The funnel ledger is read once per runtime run and reused by its pages. Orders or publication records that arrive mid-run are picked up
   * by the next run; the monitor reader's reconciled totals re-verify against the current ledger in the meantime.
   */
  let ledgerCache: { runRef: string; asOf: string; events: FunnelEvent[] } | null = null;
  function ledgerFor(runRef: string): { asOf: string; events: FunnelEvent[] } {
    if (ledgerCache?.runRef !== runRef || now() - Date.parse(ledgerCache.asOf) > LEDGER_MAX_AGE_MS) {
      const asOf = new Date(now()).toISOString();
      ledgerCache = { runRef, asOf, events: effectiveEvents(deps.funnel.snapshot({ asOf }).events) };
    }
    return { asOf: ledgerCache.asOf, events: ledgerCache.events };
  }
  /** Whether the runtime committed a run item as completed, cached per call. */
  function committedCheck(): Committed {
    const runs = new Map<string, Map<string, string>>();
    return (runRef, itemRef) => {
      let items = runs.get(runRef);
      if (!items) { try { items = new Map(deps.jobs.getRun(runRef).items.map(i => [i.itemId, i.state])); } catch { items = new Map(); } runs.set(runRef, items); }
      return items.get(itemRef) === "completed";
    };
  }
  /** The ledger's verified publication record maps a native post to its creative and deliverable; a social page never does. */
  function creativeResolver(events: FunnelEvent[]) {
    return (network: string, accountId: string, postId: string): Creative => {
      const records = events.filter(e => e.eventType === "published" && e.evidenceRef.access === "verified" && e.network === network && e.details.postId === postId &&
        (e.sourceAccount.sourceId ?? e.sourceAccount.canonicalId) === accountId);
      const facts = new Set(records.map(e => JSON.stringify([e.details.creativeId ?? null, e.details.deliverableId ?? null])));
      if (!records.length) return { creativeRef: null, deliverableRef: null, receiptRef: null, unmappedReason: "NO_LEDGER_PUBLICATION_RECORD" };
      if (facts.size !== 1) return { creativeRef: null, deliverableRef: null, receiptRef: null, unmappedReason: "LEDGER_MAPPING_CONFLICT" };
      const [creativeRef, deliverableRef] = JSON.parse([...facts][0]!) as [string | null, string | null];
      return { creativeRef, deliverableRef, receiptRef: records.map(e => e.evidenceRef.provenanceRef).sort()[0]!,
        unmappedReason: creativeRef ? null : "LEDGER_PUBLICATION_WITHOUT_CREATIVE" };
    };
  }
  const openTakeover = () => windowRuns().some(w => deps.runtime()?.takeovers(w.runRef).some(t => !t.resolved && t.bindingHash === apiBindingHash));

  const executor: RuntimeExecutor = {
    mode: "observe",
    async execute(context): Promise<RuntimeStep> {
      const registration = registrations.find(r => digest(r) === digest(context.registration));
      if (!registration || digest(context.binding) !== apiBindingHash) throw new RuntimeError("J08_WINDOW_MISMATCH", 409);
      const watch = repo.watchlist(context.window.windowRef), subject = repo.subject(context.subjectRef);
      if (!watch || !subject || !watch.entries.some(e => e.subjectRef === context.subjectRef)) throw new RuntimeError("J08_SUBJECT_NOT_IN_WATCHLIST", 409);
      // Policy, suppression and eligibility changes take effect before the next item, and again inside the final fence.
      const policy = currentPolicy();
      if (!policy) return { state: "held", reasonCode: "J08_POLICY_VERSION_CHANGED" };
      const current = eligibleSubject(subject.subjectRef);
      if (!current) return { state: "held", reasonCode: "J08_ENROLLMENT_CHANGED" };
      // A denied row is not re-read within the same run, and one open source takeover holds the account's other rows.
      const prior = repo.outcome(context.runRef, context.itemRef);
      const resumed = deps.runtime()?.takeovers(context.runRef).some(t => t.itemRef === context.itemRef && t.resolved) ?? false;
      if (prior?.access && prior.access !== "authorized" && !transientAccess(prior.access) && !resumed) return { state: "held", reasonCode: prior.reason ?? "J08_ACCESS_HELD" };
      if (openTakeover()) return { state: "held", reasonCode: "J08_SOURCE_TAKEOVER_OPEN" };
      const { stage, cursor } = context.cursor === null ? { stage: "posts" as J08Stage, cursor: null } : decodeCursor(context.cursor);
      const request: J08ReadRequest = { scope: { ...scope }, registrationRef: registration.registrationRef, registrationVersion: registration.version,
        policyVersion: policy.version, eligibilityPolicyVersion: watch.eligibilityPolicyVersion, watchlistVersion: watch.watchlistVersion,
        window: { windowRef: context.window.windowRef, start: context.window.windowStart, end: context.window.windowEnd },
        subject: { creatorId: current.creatorId, profile: { provider: subject.network, accountId: subject.accountId, sourceId: subject.profileId, url: null }, campaigns: current.campaigns },
        stage, cursor, maxRecords: context.maxRecords,
        priorObservationRefs: repo.subjectContent(subject.subjectRef).slice(-100).map(c => ({ provider: c.network, accountId: c.accountId, sourceId: c.postId, url: null })) };
      context.assertCurrent();
      const response = await context.invoke(registration.apiChannel, () => boundedSourceRead(() => binding.source.read(structuredClone(request))))
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      context.assertCurrent();
      if (!response.ok) {
        if (response.error instanceof RuntimeError && ![429, 503, 504].includes(response.error.status)) throw response.error;
        // A denied source read is a protected-state denial, never a transient retry.
        const status = response.error instanceof Error && "status" in response.error ? response.error.status : null;
        if (status === 401 || status === 403) throw new RuntimeError("SOURCE_SCOPE_DENIED", 403);
        return { state: "retry", reasonCode: "J08_SOURCE_READ_UNAVAILABLE", retryAfterMs: 1000 };
      }
      const parsed = j08PageSchema.safeParse(response.value);
      if (!parsed.success || parsed.data.requestDigest !== digest(request)) throw new RuntimeError("J08_SOURCE_PAYLOAD_INVALID", 502);
      const page = { ...parsed.data, observedAt: new Date(parsed.data.observedAt).toISOString() };
      if (page.evidenceStage !== binding.evidenceStage) throw new RuntimeError("J08_EVIDENCE_STAGE_MISMATCH", 502);
      if (stage === "posts" && page.inbox.length || stage === "inbox" && page.posts.length) throw new RuntimeError("J08_SOURCE_PAYLOAD_INVALID", 502);
      // A page cannot carry another account's records or widen the allowed account.
      if ([...page.posts.map(p => p.ref), ...page.inbox.map(m => m.ref)].some(ref => ref.provider !== subject.network || ref.accountId !== subject.accountId))
        throw new RuntimeError("J08_CROSS_ACCOUNT_PAYLOAD", 502);
      const recordCount = page.posts.length + page.inbox.length;
      if (recordCount > context.maxRecords) throw new RuntimeError("RUNTIME_SOURCE_BOUND_EXCEEDED", 502);
      const fence = () => {
        context.assertCurrent();
        const at = now(), observed = Date.parse(page.observedAt);
        if (observed > at || observed <= at - SOURCE_LEASE_MS) throw new RuntimeError("J08_SOURCE_PAGE_NOT_CURRENT", 409);
        if (!currentPolicy()) throw new RuntimeError("J08_POLICY_VERSION_CHANGED", 409);
        if (!eligibleSubject(subject.subjectRef)) throw new RuntimeError("J08_ENROLLMENT_CHANGED", 409);
        assertSynchronousVoid(() => binding.source.assertCurrent(structuredClone(page), structuredClone(request), at));
        context.assertCurrent();
      };
      const item = { runRef: context.runRef, itemRef: context.itemRef, windowRef: context.window.windowRef, subject };
      if (page.access !== "authorized") {
        const failure = repo.recordAccessFailure({ ...item, page }, fence);
        if (transientAccess(page.access)) return { state: "retry", reasonCode: failure.reason, retryAfterMs: page.retryAfterMs ?? 1000 };
        // A row-level denial completes its runtime item with an explicit inaccessible outcome, so it cannot block later pages of the window.
        // The condition stays visible and owned: the J08 outcome, the J14 outbox and all clear all carry it.
        // The runtime step evidence carries the inaccessible reason, so runtime views never read a denial as a plain success. The runtime
        // requires evidence refs not to exceed the record count; the one record is the source's access observation itself, not a post.
        if (page.access === "denied") return { state: "completed", evidenceRefs: [`j08-inaccessible:${failure.reason}`], recordCount: 1, sourceReceiptRef: page.receiptRef };
        return { state: "takeover", kind: takeoverKinds[page.access], reasonCode: failure.reason, ownerRef: j08Owners.J14,
          handoffRef: `j08-handoff:${digest([apiBindingHash, page.access])}` };
      }
      const ledger = ledgerFor(context.runRef);
      repo.recordPage({ ...item, stage, page, campaigns: current.campaigns, policy, creativeOf: creativeResolver(ledger.events) }, fence);
      if (page.nextCursor !== null || stage === "posts")
        return { state: "checkpoint", evidenceRefs: [], recordCount, sourceReceiptRef: page.receiptRef,
          nextCursor: page.nextCursor !== null ? encodeCursor(stage, page.nextCursor) : encodeCursor("inbox", null) };
      // Both stages are complete: join the canonical order ledger for this row's Farda content.
      // Attribution is labeled with the ledger snapshot's own time, never a later clock reading.
      const { asOf, events } = ledger;
      const attributions = new Map(repo.subjectContent(subject.subjectRef).filter(c => c.assignment.state === "attributed" && c.assignment.campaignId && !c.conflict)
        .map(c => [c.contentKey, orderAttribution({ network: c.network, postId: c.postId, creatorId: current.creatorId, campaignId: c.assignment.campaignId!,
          publishedAt: c.publishedAt }, events, asOf, policy.attributionWindows)] as const));
      repo.finishItem({ ...item, attributions, committed: committedCheck() }, fence);
      return { state: "completed", evidenceRefs: [], recordCount, sourceReceiptRef: page.receiptRef };
    },
  };

  /** Every admitted page of every J08 window, newest first, from the runtime's own store. */
  function windowRuns(): { runRef: string; window: RuntimeWindow; registrationRef: string }[] {
    const runtime = deps.runtime();
    if (!runtime) return [];
    return registrations.flatMap(r => runtime.windowPages(r.registrationRef, 500).map(p => ({ runRef: p.runRef, window: p.plan.window, registrationRef: r.registrationRef })))
      .sort((a, b) => Date.parse(b.window.intendedAt) - Date.parse(a.window.intendedAt) || a.runRef.localeCompare(b.runRef));
  }
  function windows(limit = 24): RuntimeWindow[] {
    const seen = new Map<string, RuntimeWindow>();
    for (const run of windowRuns()) if (!seen.has(run.window.windowRef) && repo.watchlist(run.window.windowRef)) seen.set(run.window.windowRef, run.window);
    return [...seen.values()].slice(0, limit);
  }
  function categorize(item: JobItemView, outcome: J08ItemOutcome | null): J08Category {
    if (item.state === "completed") return outcome?.category === "newContent" || outcome?.category === "unchanged" || outcome?.category === "inaccessible" ? outcome.category : "failed";
    if (item.state === "failed" || item.state === "reconcile") return "failed";
    if (item.state === "held" && (outcome?.category === "inaccessible" || outcome?.category === "failed")) return outcome.category;
    return "deferred";
  }
  /** freshnessCoverage for one whole window across all of its pages. Frozen rows on unadmitted pages are deferred. */
  function coverage(windowRef: string): J08Coverage & { rows: WindowRow[]; window: RuntimeWindow | null; watchlistVersion: string } {
    const watch = repo.watchlist(windowRef);
    if (!watch) throw new RuntimeError("J08_WINDOW_UNKNOWN", 404);
    const runs = windowRuns(), intended = new Map(runs.map(r => [r.window.windowRef, Date.parse(r.window.intendedAt)]));
    const pages = runs.filter(r => r.window.windowRef === windowRef), at = intended.get(windowRef) ?? Infinity;
    const items = new Map<string, { runRef: string; item: JobItemView }>();
    for (const p of pages) for (const item of deps.jobs.getRun(p.runRef).items) items.set(item.input.subjectRef, { runRef: p.runRef, item });
    // Rows on an unadmitted page are deferred; say whether an unfinished earlier page is what keeps them out.
    const priorPageBlocked = [...items.values()].some(({ item }) => item.state !== "completed");
    // Last success as of this window: never a success from a later window.
    const committed = committedCheck();
    const successAsOf = (subjectRef: string) => repo.successes(subjectRef, committed).filter(s => (intended.get(s.windowRef) ?? Infinity) <= at)
      .reduce<string | null>((best, s) => !best || Date.parse(s.at) > Date.parse(best) ? s.at : best, null);
    const rows: WindowRow[] = watch.entries.map(({ subjectRef }) => {
      const hit = items.get(subjectRef);
      if (!hit) return { subjectRef, runRef: null, item: null, outcome: null, category: "deferred" as const, lastSuccessAt: successAsOf(subjectRef), notAdmitted: priorPageBlocked
        ? "J08_PRIOR_PAGE_INCOMPLETE" : "J08_PAGE_NOT_YET_ADMITTED" };
      const outcome = repo.outcome(hit.runRef, hit.item.itemId);
      return { subjectRef, runRef: hit.runRef, item: hit.item, outcome, category: categorize(hit.item, outcome), lastSuccessAt: successAsOf(subjectRef) };
    });
    const total = (c: J08Category) => rows.filter(r => r.category === c).length;
    const counts = { unchanged: total("unchanged"), newContent: total("newContent"), inaccessible: total("inaccessible"), deferred: total("deferred"), failed: total("failed") };
    const complete = rows.length > 0 && counts.deferred + counts.failed + counts.inaccessible === 0;
    const successes = rows.map(r => r.lastSuccessAt);
    const lastSourceSuccess = successes.some(s => s === null) ? null : successes.reduce<string | null>((oldest, s) => !oldest || Date.parse(s!) < Date.parse(oldest) ? s : oldest, null);
    // All clear counts every open condition, including rows that have since left the watchlist.
    const allSubjects = new Set([...watch.entries.map(e => e.subjectRef), ...repo.allContent().map(c => c.subjectRef), ...repo.failedSubjects()]);
    const health = deps.health?.();
    // Row conditions are evaluated as of this window's own last source observation; a later failure is never back-dated into it.
    const asOf = rows.map(r => r.outcome?.observedAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
    // Content-level inaccessibility counts too, including content of rows that have since left the watchlist.
    const contentOpen = repo.allContent().filter(c => c.assignment.state !== "unrelated" && allSubjects.has(c.subjectRef))
      .some(c => repo.latestStatus(c.contentKey, asOf)?.state === "inaccessible");
    const open = [...allSubjects].some(s => repo.subjectAccess(s, committed, asOf) !== null) || contentOpen || openTakeover() ||
      (health?.exceptions(capabilityId, 100).records.some(e => e.state === "open") ?? false);
    return { snapshotCount: rows.length, scanned: counts.unchanged + counts.newContent, ...counts, lastSourceSuccess, complete,
      noNewContent: complete ? counts.newContent === 0 : null, allClear: complete ? !open : null, rows,
      window: pages[0]?.window ?? null, watchlistVersion: watch.watchlistVersion };
  }
  const view = createContentMonitorView({ repo, scope, registration: hourly, evidenceStage: binding.evidenceStage, intake: deps.intake, coverage, windows, now, committedCheck,
    checkpointsVersion: () => currentPolicy()?.checkpoints.version ?? null, subjectRefOf });
  const source: MonitorSourceReader = view.reader;
  const executors = new Map(registry.executors);
  for (const r of registrations) executors.set(r.executorRef, executor);
  return { registry: { registrations: registry.registrations, executors } as RuntimeRegistry, source, plan, composeAuthority, coverage, windows,
    trace: view.trace, output: view.output, report: view.report, proposals: () => repo.proposals(),
    /** Drains the durable J14 routing outbox now; window admission and refresh also drain it. */
    drainRoutes, subject: (subjectRef: string) => repo.subject(subjectRef), registrationRef: hourly.registrationRef,
    manualRecheckRef: manual?.registrationRef ?? null, evidenceStage: binding.evidenceStage, capabilityId };
}
