import { createHmac } from "node:crypto";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest } from "../config.ts";
import type { FunnelRepository } from "../funnelStore.ts";
import type { JobRepository } from "../jobs/repository.ts";
import type { JobItemView } from "../jobs/schema.ts";
import { RuntimeError, type RuntimeExecutor, type RuntimeRegistration, type RuntimeRegistry, type RuntimeStep, type RuntimeWindow } from "../jobs/runtimeSchema.ts";
import { effectiveEvents } from "../monitor/posts.ts";
import type { MonitorSourceReader } from "../monitor/contract.ts";
import type { OperationsScope } from "../operations.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { j08Owners, j08PageSchema, j08PolicySchema, type J08Category, type J08Coverage, type J08Policy, type J08ReadRequest, type J08SourceReader,
  type J08Stage, type J08Subject } from "./contract.ts";
import { createContentMonitorView } from "./projection.ts";
import type { ContentMonitorRepository, J08ItemOutcome } from "./repository.ts";
import { orderAttribution } from "./rules.ts";

export type ContentMonitorBinding = {
  registrationRef: string;
  /** Server-owned reader of the current versioned J08 policy. It has no default; a version different from the registration holds work. */
  policy: () => unknown;
  /** Read-only J08 source. It has no send, like, follow, accept, rate or approval method. */
  source: J08SourceReader;
  /** "synthetic" binds a sandbox fixture only; a "source" binding rejects synthetic pages and vice versa. */
  evidenceStage: "synthetic" | "source";
};
type MembershipRecord = {
  creatorId: string; revision: number; identityState: string; watchlistEligibility: string; suppressed: boolean; sourceStatus: string;
  profiles: { network: string; accountId: string; sourceId: string | null }[];
  relationships: { campaignKey: string | null; state: string; recruitmentSource: string }[];
  handoffs: { target: string; state: string; receiptRef: string | null; revision: number; canonicalReceiptRef: string | null }[];
};
export type ContentMonitorMembership = { monitorMembership(limit?: number): { records: MembershipRecord[]; total: number; complete: boolean } };
export type ContentMonitorDeps = { intake: ContentMonitorMembership; funnel: Pick<FunnelRepository, "snapshot">; jobs: Pick<JobRepository, "getRun">;
  secret: string; now?: () => number };
type Eligible = J08Subject & { revision: number; campaigns: string[]; recruitment: Map<string, string>; notionReceipt: string; sheetsReceipt: string };

// The runtime's own source lease ceiling. A page older than that is not a current observation.
const SOURCE_LEASE_MS = 15 * 60_000;
const takeoverKinds = { loginRequired: "login", mfaRequired: "mfa", captcha: "captcha", termsChanged: "termsChanged", uiDrift: "uiDrift" } as const;

function assertRegistration(registration: RuntimeRegistration | undefined, registry: RuntimeRegistry): asserts registration is RuntimeRegistration {
  if (!registration || registration.family !== "J08" || registration.cadence.kind !== "hourly" || registration.membership !== "enrolled-only" ||
      registration.definition.mode !== "observe" || !registration.apiBinding || registration.browserBinding || registration.apiChannel === "model" ||
      registration.definition.budgets.maxConcurrency !== 1 || registry.executors.has(registration.executorRef) ||
      [...registry.registrations.values()].some(other => other.registrationRef !== registration.registrationRef && other.executorRef === registration.executorRef))
    throw new RuntimeError("J08_REGISTRATION_INVALID", 422);
}

/**
 * Binds J08 to the existing registered job runtime: hourly cadence, enrolled-only membership, account lease, checkpoint, stable
 * idempotency and run/item correlation all stay with `JobRuntime`. J08 owns only its read-only executor, outputs and projection.
 */
export function bindContentMonitor(repo: ContentMonitorRepository, scope: OperationsScope, registry: RuntimeRegistry,
  binding: ContentMonitorBinding, deps: ContentMonitorDeps) {
  const registration = registry.registrations.get(binding.registrationRef);
  assertRegistration(registration, registry);
  if (!["synthetic", "source"].includes(binding.evidenceStage) || typeof binding.source?.read !== "function" || typeof binding.source.assertCurrent !== "function")
    throw new RuntimeError("J08_SOURCE_INVALID", 422);
  const now = deps.now ?? Date.now, registrationHash = digest(registration), apiBindingHash = digest(registration.apiBinding);
  const policyOf = (): J08Policy | null => { const parsed = j08PolicySchema.safeParse(binding.policy()); return parsed.success ? parsed.data : null; };
  if (policyOf()?.version !== registration.definition.policyVersion) throw new RuntimeError("J08_POLICY_VERSION_MISMATCH", 422);
  const key = createHmac("sha256", deps.secret).update(JSON.stringify(["j08-subject.v1", scope])).digest();
  const subjectRefOf = (creatorId: string, network: string, accountId: string, profileId: string) =>
    `j08-subject:${createHmac("sha256", key).update(JSON.stringify([creatorId, network, accountId, profileId])).digest("hex").slice(0, 48)}`;

  /** J01 owns membership. A row is eligible only while canonical, active, unsuppressed and enrolled through confirmed Notion/Sheets receipts. */
  function eligibleRows(): { rows: Eligible[]; complete: boolean } {
    const membership = deps.intake.monitorMembership(2000), rows: Eligible[] = [];
    for (const record of membership.records) {
      const campaigns = record.relationships.filter(r => r.state === "active" && r.campaignKey).map(r => r.campaignKey!);
      const confirmed = record.handoffs.filter(h => h.revision === record.revision && h.state === "confirmed" && h.receiptRef);
      const notion = confirmed.find(h => h.target === "notion-creator-crm"), sheets = confirmed.find(h => h.target === "sheets-watchlist" && h.canonicalReceiptRef === notion?.receiptRef);
      if (record.identityState !== "resolved" || record.watchlistEligibility !== "active" || record.suppressed || record.sourceStatus !== "verified" ||
          !campaigns.length || !notion || !sheets) continue;
      const recruitment = new Map(record.relationships.filter(r => r.campaignKey).map(r => [r.campaignKey!, r.recruitmentSource] as const));
      for (const p of record.profiles) if (p.sourceId && (p.network === "instagram" || p.network === "tiktok"))
        rows.push({ subjectRef: subjectRefOf(record.creatorId, p.network, p.accountId, p.sourceId), creatorId: record.creatorId, network: p.network,
          accountId: p.accountId, profileId: p.sourceId, revision: record.revision, campaigns: [...campaigns].sort(), recruitment,
          notionReceipt: notion.receiptRef!, sheetsReceipt: sheets.receiptRef! });
    }
    return { rows: rows.sort((a, b) => a.subjectRef.localeCompare(b.subjectRef)), complete: membership.complete };
  }
  const eligibleSubject = (subject: J08Subject) => eligibleRows().rows.find(r => r.subjectRef === subject.subjectRef) ?? null;

  /** Freezes one finite page of the eligible watchlist for a runtime window. The runtime authority supplies it as the window plan. */
  function plan(input: { window: RuntimeWindow; continuation: string | null }) {
    if (input.window.registrationRef !== registration!.registrationRef || input.window.registrationVersion !== registration!.version)
      throw new RuntimeError("J08_WINDOW_MISMATCH", 409);
    return repo.freezePlan(input.window, input.continuation, () => {
      const { rows, complete } = eligibleRows();
      if (!complete) throw new RuntimeError("J08_MEMBERSHIP_INCOMPLETE", 503);
      const offset = input.continuation === null ? 0 : Number(/^j08-page:(\d{1,6})$/.exec(input.continuation)?.[1] ?? NaN);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) throw new RuntimeError("J08_CONTINUATION_INVALID", 422);
      const max = registration!.definition.budgets.maxItems, page = rows.slice(offset, offset + max), more = offset + max < rows.length;
      repo.saveSubjects(page.map(({ subjectRef, creatorId, network, accountId, profileId }) => ({ subjectRef, creatorId, network, accountId, profileId })));
      return { items: page.map(r => ({ itemKey: r.subjectRef, subjectRef: r.subjectRef, evidenceRef: null as string | null,
        enrollmentRef: `j01-enrollment:${digest([r.creatorId, r.revision, r.notionReceipt, r.sheetsReceipt])}` })),
        coverage: more ? "partial" as const : "complete" as const, continuation: more ? `j08-page:${offset + max}` : null, total: more ? null : page.length };
    });
  }

  const executor: RuntimeExecutor = {
    mode: "observe",
    async execute(context): Promise<RuntimeStep> {
      if (digest(context.registration) !== registrationHash || digest(context.binding) !== apiBindingHash) throw new RuntimeError("J08_WINDOW_MISMATCH", 409);
      const subject = repo.subject(context.subjectRef);
      if (!subject) throw new RuntimeError("J08_SUBJECT_UNKNOWN", 409);
      repo.noteRun(context.runRef, context.window);
      // Policy, suppression and eligibility changes take effect before the next item, and again inside the final fence.
      const policy = policyOf();
      if (!policy || policy.version !== registration!.definition.policyVersion) return { state: "held", reasonCode: "J08_POLICY_VERSION_CHANGED" };
      const current = eligibleSubject(subject);
      if (!current) return { state: "held", reasonCode: "J08_ENROLLMENT_CHANGED" };
      let stage: J08Stage = "posts", sourceCursor: string | null = null;
      if (context.cursor !== null) {
        const saved = repo.cursor(context.cursor);
        if (!saved || saved.runRef !== context.runRef || saved.itemRef !== context.itemRef) throw new RuntimeError("J08_CHECKPOINT_UNKNOWN", 409);
        stage = saved.stage; sourceCursor = saved.sourceCursor;
      }
      const request: J08ReadRequest = { scope: { ...scope }, registrationRef: registration!.registrationRef, registrationVersion: registration!.version,
        policyVersion: policy.version, watchlistVersion: context.window.windowRef,
        window: { windowRef: context.window.windowRef, start: context.window.windowStart, end: context.window.windowEnd },
        subject: { creatorId: subject.creatorId, profile: { provider: subject.network, accountId: subject.accountId, sourceId: subject.profileId, url: null }, campaigns: current.campaigns },
        stage, cursor: sourceCursor, maxRecords: context.maxRecords,
        priorObservationRefs: repo.subjectContent(subject.subjectRef).slice(-100).map(c => ({ provider: c.network, accountId: c.accountId, sourceId: c.postId, url: null })) };
      context.assertCurrent();
      const response = await context.invoke(registration!.apiChannel, () => boundedSourceRead(() => binding.source.read(structuredClone(request))))
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      context.assertCurrent();
      if (!response.ok) {
        if (response.error instanceof RuntimeError && ![429, 503, 504].includes(response.error.status)) throw response.error;
        return { state: "retry", reasonCode: "J08_SOURCE_READ_UNAVAILABLE", retryAfterMs: 1000 };
      }
      const parsed = j08PageSchema.safeParse(response.value);
      if (!parsed.success || parsed.data.requestDigest !== digest(request)) throw new RuntimeError("J08_SOURCE_PAYLOAD_INVALID", 502);
      const page = parsed.data;
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
        if (policyOf()?.version !== policy.version) throw new RuntimeError("J08_POLICY_VERSION_CHANGED", 409);
        if (!eligibleSubject(subject)) throw new RuntimeError("J08_ENROLLMENT_CHANGED", 409);
        assertSynchronousVoid(() => binding.source.assertCurrent(structuredClone(page), structuredClone(request), at));
        context.assertCurrent();
      };
      if (page.access !== "authorized") {
        const failure = repo.recordAccessFailure({ runRef: context.runRef, itemRef: context.itemRef, subject, page }, fence);
        if (page.access === "throttled" || page.access === "unavailable") return { state: "retry", reasonCode: failure.reason, retryAfterMs: page.retryAfterMs ?? 1000 };
        if (page.access === "denied") return { state: "held", reasonCode: failure.reason };
        return { state: "takeover", kind: takeoverKinds[page.access], reasonCode: failure.reason, ownerRef: j08Owners.J14,
          handoffRef: `j08-handoff:${digest([subject.subjectRef, page.access])}` };
      }
      repo.recordPage({ runRef: context.runRef, itemRef: context.itemRef, subject, stage, page, campaigns: current.campaigns, policy }, fence);
      if (page.nextCursor !== null || stage === "posts") {
        const nextCursor = page.nextCursor !== null ? repo.saveCursor(context.runRef, context.itemRef, stage, page.nextCursor) : repo.saveCursor(context.runRef, context.itemRef, "inbox", null);
        return { state: "checkpoint", evidenceRefs: [], recordCount, nextCursor, sourceReceiptRef: page.receiptRef };
      }
      // Both stages are complete: join the canonical order ledger for this row's Farda content.
      const asOf = new Date(now()).toISOString(), events = effectiveEvents(deps.funnel.snapshot({}).events);
      const attributions = new Map(repo.subjectContent(subject.subjectRef).filter(c => c.assignment.state === "attributed" && c.assignment.campaignId && !c.conflict)
        .map(c => [c.contentKey, orderAttribution({ network: c.network, postId: c.postId, creatorId: c.creatorId, campaignId: c.assignment.campaignId! }, events, asOf)] as const));
      repo.finishItem({ runRef: context.runRef, itemRef: context.itemRef, subject, attributions }, fence);
      return { state: "completed", evidenceRefs: [], recordCount, sourceReceiptRef: page.receiptRef };
    },
  };

  function categorize(item: JobItemView, outcome: J08ItemOutcome | null): J08Category {
    if (item.state === "completed") return outcome?.category === "newContent" || outcome?.category === "unchanged" ? outcome.category : "failed";
    if (item.state === "failed" || item.state === "reconcile") return "failed";
    if (item.state === "held" && (outcome?.category === "inaccessible" || outcome?.category === "failed")) return outcome.category;
    return "deferred";
  }
  /** freshnessCoverage for one runtime run. The runtime item state decides terminality; due but unvisited rows are deferred. */
  function coverage(runRef: string): J08Coverage & { rows: { item: JobItemView; outcome: J08ItemOutcome | null; category: J08Category }[] } {
    const run = deps.jobs.getRun(runRef), saved = repo.run(runRef);
    const rows = run.items.map(item => { const outcome = repo.outcome(runRef, item.itemId); return { item, outcome, category: categorize(item, outcome) }; });
    const total = (c: J08Category) => rows.filter(r => r.category === c).length;
    const counts = { unchanged: total("unchanged"), newContent: total("newContent"), inaccessible: total("inaccessible"), deferred: total("deferred"), failed: total("failed") };
    const successes = rows.flatMap(r => r.outcome?.lastSuccessAt ? [r.outcome.lastSuccessAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b));
    const complete = rows.length > 0 && counts.deferred + counts.failed + counts.inaccessible === 0 && saved !== null && repo.planComplete(saved.windowRef);
    // All clear is evaluated as of this run: an incident counts when it was open at the end of this run's window.
    const subjects = new Set(rows.map(r => r.item.input.subjectRef)), at = saved ? Date.parse(saved.intendedAt) : NaN;
    const intended = (ref: string | null) => { const run = ref ? repo.run(ref) : null; return run ? Date.parse(run.intendedAt) : null; };
    const openIncidents = repo.incidents().filter(i => subjects.has(i.subjectRef) && (intended(i.openedRun) ?? Infinity) <= at &&
      (i.state === "open" || (intended(i.closedRun) ?? -Infinity) > at)).length;
    return { snapshotCount: rows.length, scanned: counts.unchanged + counts.newContent, ...counts, lastSourceSuccess: successes.at(-1) ?? null, complete,
      noNewContent: complete ? counts.newContent === 0 : null, allClear: complete ? openIncidents === 0 : null, rows };
  }
  const view = createContentMonitorView({ repo, scope, registration, evidenceStage: binding.evidenceStage, intake: deps.intake, coverage, now,
    checkpointsVersion: () => policyOf()?.checkpoints.version ?? null });
  const source: MonitorSourceReader = view.reader;
  return { registry: { registrations: registry.registrations, executors: new Map(registry.executors).set(registration.executorRef, executor) } as RuntimeRegistry,
    source, plan, coverage, trace: view.trace, output: view.output, runs: () => repo.runs().map(r => r.runRef), incidents: () => repo.incidents(),
    actions: () => repo.actions(), registrationRef: registration.registrationRef, evidenceStage: binding.evidenceStage };
}
