import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import type { JobItemView } from "../jobs/schema.ts";
import type { RuntimeRegistration } from "../jobs/runtimeSchema.ts";
import { monitorSnapshotSchema, originalPostUrl, type MonitorReadBinding, type MonitorSnapshot, type MonitorSourceReader } from "../monitor/contract.ts";
import type { OperationsScope } from "../operations.ts";
import { j08Owners, j08MetricKeys, type J08Category, type J08Coverage } from "./contract.ts";
import { MonitorError } from "../monitor/reader.ts";
import { type ContentMonitorRepository, type J08ItemOutcome, type StoredContent, type StoredMetric } from "./repository.ts";
import type { ContentMonitorMembership } from "./runtime.ts";

type Snapshot = MonitorSnapshot;
type Post = Snapshot["posts"][number];
type Check = Snapshot["runs"][number]["checks"][number];
type CoverageRows = J08Coverage & { rows: { item: JobItemView; outcome: J08ItemOutcome | null; category: J08Category }[] };
type Options = { repo: ContentMonitorRepository; scope: OperationsScope; registration: RuntimeRegistration; evidenceStage: "synthetic" | "source";
  intake: ContentMonitorMembership; coverage(runRef: string): CoverageRows; checkpointsVersion(): string | null; now: () => number };

// The server's existing D-13 monitoring age ceiling. The J08 store does not extend it.
const MONITOR_MAX_AGE_MS = 90 * 60_000;
const checkState: Record<J08Category, Check["state"]> = { newContent: "changed", unchanged: "unchanged", inaccessible: "inaccessible", failed: "failed", deferred: "deferred" };
const accessOf = (access: string | null): Check["access"] => access === null ? "unknown" : access === "authorized" || access === "denied" || access === "throttled" ? access :
  ["loginRequired", "mfaRequired", "captcha", "termsChanged"].includes(access) ? "loginRequired" : "unavailable";
const maxOf = (values: (string | null | undefined)[]) => values.filter((v): v is string => !!v).reduce<string | null>((best, v) => best === null || Date.parse(v) > Date.parse(best) ? v : best, null);
const recruitmentOf = (source: string | undefined): Post["enrollmentSource"] => source === "social-cat" ? "social-cat" : source === "tiktok-shop" ? "tiktok-affiliate" : source ? "other" : "unknown";
const iso = (value: string) => new Date(value).toISOString();

/** Projects J08's own store into the existing trusted `MonitorSourceReader` packet. The monitor reader aliases every reference. */
export function createContentMonitorView(options: Options) {
  const { repo, scope, registration, intake } = options;
  const timezone = registration.cadence.kind === "hourly" ? registration.cadence.timezone : null;

  function measurementRows(content: StoredContent, checkpointsVersion: string | null) {
    const metrics = repo.metrics(content.contentKey), checkpoints = repo.checkpoints(content.contentKey).filter(c => c.checkpointsVersion === checkpointsVersion);
    const instants = new Map<string, string>();
    for (const m of metrics) instants.set(m.receiptRef, m.observedAt);
    for (const c of checkpoints) instants.set(c.receiptRef, c.observedAt);
    return [...instants].sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]) || a[0].localeCompare(b[0])).map(([receipt, at]) => {
      const latest = (key: StoredMetric["metricKey"]) => metrics.filter(m => m.metricKey === key && Date.parse(m.observedAt) <= Date.parse(at)).at(-1) ?? null;
      const values = Object.fromEntries(j08MetricKeys.map(k => [k, latest(k)])) as Record<StoredMetric["metricKey"], StoredMetric | null>;
      const views = values.views, checkpoint = checkpoints.find(c => c.receiptRef === receipt);
      return { at, receipt, definition: views?.definition ?? "Native views not reported", window: views ? views.semantics === "cumulative" ? "lifetime to source observation" :
        `${iso(views.windowStart)}/${iso(views.windowEnd)}` : "unknown", semantics: views?.semantics ?? "unknown" as const,
        context: (views?.context ?? "unknown") as Post["measurements"][number]["context"],
        views: views?.value ?? null, likes: values.likes?.value ?? null, comments: values.comments?.value ?? null, shares: values.shares?.value ?? null,
        saves: values.saves?.value ?? null, reach: values.reach?.value ?? null,
        ...(checkpoint ? { checkpoint: { hours: checkpoint.hours, actualAgeHours: checkpoint.actualAgeHours, version: checkpoint.checkpointsVersion } } : {}) };
    });
  }

  function project(): Snapshot | null {
    const membership = intake.monitorMembership(2000), records = new Map(membership.records.map(r => [r.creatorId, r]));
    const checkpointsVersion = options.checkpointsVersion();
    const runs = repo.runs(24).map(run => ({ run, coverage: options.coverage(run.runRef) }));
    const openSubjects = new Map(repo.incidents().filter(i => i.state === "open" && i.contentKey === null).map(i => [i.subjectRef, i]));
    const projectedRuns: Snapshot["runs"] = [];
    const successBefore = (subjectRef: string, index: number) => maxOf(runs.slice(index).map(r => r.coverage.rows.find(x => x.item.input.subjectRef === subjectRef)?.outcome?.lastSuccessAt));
    runs.forEach(({ run, coverage }, index) => {
      const checks: Check[] = [];
      for (const row of coverage.rows) {
        const subject = repo.subject(row.item.input.subjectRef);
        if (!subject) continue;
        // Source failures go to J14; an eligibility hold to the J01 owner; a policy hold to the registration owner.
        const outcome = row.outcome, held = row.category === "deferred" ? row.item.reasonCode : null;
        const owner = row.category === "inaccessible" || row.category === "failed" ? j08Owners.J14 : held === "J08_ENROLLMENT_CHANGED" ? "owner:j01-intake" :
          held === "J08_POLICY_VERSION_CHANGED" ? registration.ownerRef : null;
        checks.push({ creatorId: subject.creatorId, network: subject.network, account: subject.accountId, profileId: subject.profileId,
          state: checkState[row.category], access: accessOf(outcome?.access ?? null), at: outcome?.observedAt ?? null,
          lastSuccessAt: successBefore(subject.subjectRef, index), receipt: outcome?.receipts.at(-1) ?? null, checkpoint: row.item.checkpoint.cursor,
          owner, reason: row.category === "unchanged" || row.category === "newContent" ? null :
            outcome?.reason ? `${outcome.reason}; recovery owner ${owner === j08Owners.J14 ? "J14 source health" : "runtime retry"}` :
            row.item.reasonCode ? `Held: ${row.item.reasonCode}` : "Due but not yet visited in this run." });
      }
      const checked = new Set(coverage.rows.filter(r => r.category === "newContent" || r.category === "unchanged").map(r => r.item.input.subjectRef));
      const inbox = repo.messages(run.runRef).filter(m => checked.has(m.subjectRef)).map(m => {
        const subject = repo.subject(m.subjectRef)!;
        return { id: m.messageId, creatorId: subject.creatorId, network: m.network, account: m.accountId, profileId: subject.profileId, at: m.at, receipt: m.receiptRef,
          kind: m.kind, interpretation: "observed" as const, context: { access: "authorized" as const, observedAt: m.pageObservedAt, conversationId: m.conversationId,
            messageId: m.messageId, sourceVersion: m.receiptRef, currentStatus: null, proposedStatus: null, expectedVersion: null } };
      });
      const observedAt = maxOf([...checks.flatMap(c => [c.at, c.lastSuccessAt]), ...inbox.map(e => e.context.observedAt)]);
      // A run with no source-dated evidence cannot be placed in source time; it remains in the J08 trace only.
      if (!observedAt) return;
      projectedRuns.push({ id: run.runRef, observedAt, receipt: `j08-run:${digest([run.runRef, run.windowRef])}`, snapshotSize: coverage.snapshotCount,
        complete: coverage.complete, timezone, schedule: options.evidenceStage === "synthetic" ? "disabled" : "unknown", nextRun: null,
        retryPolicy: "Safe reads retry within the registration's attempt budget and resume from the saved checkpoint; access failures wait for the J14 owner.",
        jobId: registration.definition.jobId, checks, inbox });
    });
    const latest = runs[0];
    const members: Snapshot["members"] = [];
    for (const row of latest?.coverage.rows ?? []) {
      const subject = repo.subject(row.item.input.subjectRef), record = subject ? records.get(subject.creatorId) : undefined;
      if (!subject || !record || !record.profiles.some(p => p.network === subject.network && p.accountId === subject.accountId && p.sourceId === subject.profileId)) continue;
      const confirmed = record.handoffs.filter(h => h.revision === record.revision && h.state === "confirmed" && h.receiptRef);
      const notion = confirmed.find(h => h.target === "notion-creator-crm"), sheets = confirmed.find(h => h.target === "sheets-watchlist" && h.canonicalReceiptRef === notion?.receiptRef);
      if (notion && sheets) members.push({ creatorId: subject.creatorId, revision: record.revision, network: subject.network, account: subject.accountId,
        profileId: subject.profileId, notionReceipt: notion.receiptRef!, sheetsReceipt: sheets.receiptRef!, cohort: null });
    }
    const posts: Post[] = repo.allContent().filter(c => c.assignment.state === "attributed" && c.assignment.campaignId && !c.conflict).map(c => {
      const status = repo.status(c.contentKey), last = status.at(-1) ?? null, incident = openSubjects.get(c.subjectRef);
      const visibility: Post["visibility"] = incident ? "inaccessible" : last?.state ?? "unverified";
      const captured = repo.checkpoints(c.contentKey).filter(x => x.checkpointsVersion === checkpointsVersion);
      const record = records.get(c.creatorId);
      return { network: c.network, account: c.accountId, postId: c.postId, creatorId: c.creatorId, campaign: c.assignment.campaignId!, campaignReceipt: c.assignment.receipts[0]!,
        collaborationId: null, creativeId: c.creativeRef, deliverableId: null, enrollmentSource: recruitmentOf(record?.relationships.find(r => r.campaignKey === c.assignment.campaignId)?.recruitmentSource),
        publishedAt: c.publishedAt, publicationReceipt: c.firstReceipt, originalUrl: c.url ? originalPostUrl(c.network, c.postId, c.url) : null,
        visibility, visibilityReceipt: incident ? null : last?.receiptRef ?? null, visibilityAt: incident ? null : last?.sourceAt ?? null,
        access: incident ? accessOf(incident.reason === "SOURCE_DENIED" ? "denied" : incident.reason === "SOURCE_UI_DRIFT" ? "unavailable" : "loginRequired") :
          last ? accessOf(last.access) : "unknown",
        checkpointHours: captured.length ? Math.max(...captured.map(x => x.hours)) : null,
        // Every confirmed receipt stays in the history, including the last one before the row became inaccessible.
        publicationHistory: status.filter(s => !c.publishedAt || Date.parse(s.sourceAt) >= Date.parse(c.publishedAt))
          .map(s => ({ state: s.state, at: s.sourceAt, receipt: s.receiptRef })),
        measurements: measurementRows(c, checkpointsVersion), attribution: c.attribution };
    });
    const latestRun = projectedRuns[0];
    const observedAt = maxOf([...projectedRuns.map(r => r.observedAt), ...posts.flatMap(p => [p.publishedAt, p.visibilityAt, ...p.measurements.map(m => m.at),
      ...(p.publicationHistory ?? []).map(h => h.at)])]);
    if (!observedAt || !latestRun) return null;
    const plannedAt = repo.latestPlannedAt(), latestIntended = latest?.run.intendedAt ?? null;
    const current = Boolean(latest?.coverage.complete) && membership.complete && !(plannedAt && latestIntended && Date.parse(plannedAt) > Date.parse(latestIntended));
    const facts = { scope: { ...scope }, observedAt, validUntil: new Date(Date.parse(observedAt) + MONITOR_MAX_AGE_MS).toISOString(), evidenceStage: options.evidenceStage,
      coverage: current ? "complete" as const : "partial" as const, members, posts, runs: projectedRuns };
    return monitorSnapshotSchema.parse({ ...facts, version: `j08-store-${digest(facts)}` });
  }

  const permission = `j08-store:${registration.registrationRef}:${registration.version}`;
  function assertReadable(binding: MonitorReadBinding) {
    if (digest(binding.scope) !== digest(scope)) throw new MonitorError("SOURCE_SCOPE_DENIED", 403);
  }
  const reader: MonitorSourceReader = {
    async read(binding) {
      assertReadable(binding);
      const snapshot = project(), at = options.now();
      return { snapshot, authority: { binding: structuredClone(binding), sourceVersion: snapshot?.version ?? null, permissionVersion: permission,
        observedAt: new Date(at).toISOString(), validUntil: new Date(at + 60_000).toISOString() } };
    },
    assertCurrent(result, binding) {
      assertReadable(binding);
      if (result.authority.permissionVersion !== permission || digest(result.snapshot) !== digest(project())) throw new MonitorError("MONITOR_SOURCE_CHANGED", 409);
    },
  };

  /** The ticket's typed J08 outputs for one run (server-only; raw source references). */
  function output(runRef: string) {
    const coverage = options.coverage(runRef), subjects = new Set(coverage.rows.map(r => r.item.input.subjectRef));
    const content = repo.allContent().filter(c => subjects.has(c.subjectRef));
    const ref = (c: StoredContent) => ({ provider: c.network, accountId: c.accountId, sourceId: c.postId, url: c.url });
    const { rows, ...freshnessCoverage } = coverage;
    return {
      contentRefs: content.map(ref),
      metricSnapshots: content.flatMap(c => repo.metrics(c.contentKey).filter(m => m.runRef === runRef).map(m => ({ contentRef: ref(c), metricKey: m.metricKey, value: m.value,
        unit: m.unit, window: { start: m.windowStart, end: m.windowEnd }, observedAt: m.observedAt, missingReason: m.missingReason }))),
      statusObservations: content.flatMap(c => repo.status(c.contentKey).filter(s => s.runRef === runRef).map(s => ({ ref: ref(c), observedAt: s.sourceAt, sourceUpdatedAt: s.sourceAt,
        method: "source-page", value: { visibility: s.state, access: s.access }, unknownReason: s.state === "inaccessible" ? `CONTENT_${s.access.toUpperCase()}` : null }))),
      freshnessCoverage,
      nextActionQueue: repo.actions().filter(a => a.lastRun === runRef && a.state === "proposed").map(a => ({ itemKind: a.itemKind, itemKey: a.itemKey, reason: a.reason, owner: a.owner })),
      checkpoint: rows.map(r => r.item.checkpoint.cursor).find(cursor => cursor !== null) ?? null,
      originals: new Set(content.filter(c => c.assignment.state === "attributed").map(c => c.creativeRef ?? c.contentKey)).size,
      rows: rows.map(r => ({ subjectRef: r.item.input.subjectRef, state: r.item.state, category: r.category, reason: r.outcome?.reason ?? r.item.reasonCode ?? null })),
    };
  }
  /** Redacted run trace: keyed aliases only, safe to retain as evidence. */
  function trace(runRef: string, secret: string) {
    const key = createHmac("sha256", secret).update(JSON.stringify(["j08-trace.v1", scope])).digest();
    const alias = (kind: string, value: string) => `${kind}-${createHmac("sha256", key).update(JSON.stringify([kind, value])).digest("hex").slice(0, 16)}`;
    const out = output(runRef);
    return { schemaVersion: "j08-run-trace.v1", evidenceStage: options.evidenceStage, run: alias("run", runRef), freshnessCoverage: out.freshnessCoverage,
      rows: out.rows.map(r => ({ ...r, subjectRef: alias("row", r.subjectRef) })),
      contentRefs: out.contentRefs.map(r => ({ provider: r.provider, content: alias("content", JSON.stringify([r.provider, r.accountId, r.sourceId])) })),
      metricSnapshots: out.metricSnapshots.map(m => ({ ...m, contentRef: alias("content", JSON.stringify([m.contentRef.provider, m.contentRef.accountId, m.contentRef.sourceId])) })),
      statusObservations: out.statusObservations.map(s => ({ ...s, ref: alias("content", JSON.stringify([s.ref.provider, s.ref.accountId, s.ref.sourceId])) })),
      nextActionQueue: out.nextActionQueue.map(a => ({ ...a, itemKey: alias(a.itemKind, a.itemKey) })),
      checkpoint: out.checkpoint ? alias("checkpoint", out.checkpoint) : null, originals: out.originals };
  }
  return { reader, project, output, trace };
}
