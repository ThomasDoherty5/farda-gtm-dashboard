import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import type { RuntimeRegistration, RuntimeWindow } from "../jobs/runtimeSchema.ts";
import { monitorSnapshotSchema, originalPostUrl, type MonitorReadBinding, type MonitorSnapshot, type MonitorSourceReader } from "../monitor/contract.ts";
import { MonitorError } from "../monitor/reader.ts";
import type { OperationsScope } from "../operations.ts";
import { reportEventSchema, type ReportEvent } from "../slackReporting/contract.ts";
import { j08Owners, j08MetricKeys, type J08Category, type J08Coverage, type J08Ref } from "./contract.ts";
import type { Committed, ContentMonitorRepository, StoredContent, StoredMetric } from "./repository.ts";
import type { ContentMonitorMembership, WindowRow } from "./runtime.ts";

type Snapshot = MonitorSnapshot;
type Post = Snapshot["posts"][number];
type Check = Snapshot["runs"][number]["checks"][number];
type WindowCoverage = J08Coverage & { rows: WindowRow[]; window: RuntimeWindow | null; watchlistVersion: string };
type Options = { repo: ContentMonitorRepository; scope: OperationsScope; registration: RuntimeRegistration; evidenceStage: "synthetic" | "source";
  intake: ContentMonitorMembership; coverage(windowRef: string): WindowCoverage; windows(limit?: number): RuntimeWindow[];
  checkpointsVersion(): string | null; subjectRefOf(network: string, accountId: string, profileId: string): string; now: () => number; committedCheck(): Committed };
export type ContentMonitorReportBinding = Pick<ReportEvent, "producerRef" | "link">;

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

  /** The current J01 owner of each enrolled native profile. A changed creator ID follows the profile instead of stranding its content. */
  function owners() {
    const membership = intake.monitorMembership(2000), bySubject = new Map<string, (typeof membership.records)[number]>();
    for (const record of membership.records) for (const p of record.profiles) if (p.sourceId) bySubject.set(options.subjectRefOf(p.network, p.accountId, p.sourceId), record);
    return { membership, bySubject };
  }
  function measurementRows(content: StoredContent, checkpointsVersion: string | null) {
    const metrics = repo.metrics(content.contentKey), checkpoints = repo.checkpoints(content.contentKey).filter(c => c.checkpointsVersion === checkpointsVersion);
    const instants = new Map<string, string>();
    for (const m of metrics) instants.set(m.receiptRef, m.observedAt);
    for (const c of checkpoints) instants.set(c.receiptRef, c.observedAt);
    return [...instants].sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]) || a[0].localeCompare(b[0])).map(([receipt, at]) => {
      const latest = (key: StoredMetric["metricKey"]) => metrics.filter(m => m.metricKey === key && Date.parse(m.observedAt) <= Date.parse(at)).at(-1) ?? null;
      const values = Object.fromEntries(j08MetricKeys.map(k => [k, latest(k)])) as Record<StoredMetric["metricKey"], StoredMetric | null>;
      const views = values.views, checkpoint = checkpoints.find(c => c.receiptRef === receipt);
      // The views value's latest re-confirmation, never later than the next change.
      const next = views ? metrics.find(m => m.seriesKey === views.seriesKey && m.seq === views.seq + 1) : undefined;
      const confirmedThrough = views ? next && Date.parse(next.observedAt) <= Date.parse(views.confirmedThrough) ? views.observedAt : views.confirmedThrough : null;
      return { at, receipt, definition: views?.definition ?? "Native views not reported", window: views ? views.semantics === "cumulative" ? "lifetime to source observation" :
        `${iso(views.windowStart)}/${iso(views.windowEnd)}` : "unknown", semantics: views?.semantics ?? "unknown" as const,
        context: (views?.context ?? "unknown") as Post["measurements"][number]["context"],
        views: views?.value ?? null, likes: values.likes?.value ?? null, comments: values.comments?.value ?? null, shares: values.shares?.value ?? null,
        saves: values.saves?.value ?? null, reach: values.reach?.value ?? null,
        ...(checkpoint ? { checkpoint: { hours: checkpoint.hours, actualAgeHours: checkpoint.actualAgeHours, version: checkpoint.checkpointsVersion, state: checkpoint.state } } : {}),
        ...(confirmedThrough ? { confirmedThrough } : {}) };
    });
  }

  function project(): Snapshot | null {
    const committed = options.committedCheck();
    const { membership, bySubject } = owners(), creatorOf = (subjectRef: string) => bySubject.get(subjectRef)?.creatorId ?? subjectRef;
    const checkpointsVersion = options.checkpointsVersion();
    const windows = options.windows(24).map(window => ({ window, coverage: options.coverage(window.windowRef) }));
    const projectedRuns: Snapshot["runs"] = [];
    for (const { window, coverage } of windows) {
      const checks: Check[] = [];
      for (const row of coverage.rows) {
        const subject = repo.subject(row.subjectRef);
        if (!subject) continue;
        const outcome = row.outcome, held = row.category === "deferred" ? row.item?.reasonCode ?? null : null;
        // Source failures go to J14; an eligibility hold to J01; a policy hold to the registration owner.
        const owner = row.category === "inaccessible" || row.category === "failed" ? j08Owners.J14 : held === "J08_ENROLLMENT_CHANGED" ? j08Owners.J01 :
          held === "J08_POLICY_VERSION_CHANGED" ? registration.ownerRef : null;
        checks.push({ creatorId: creatorOf(subject.subjectRef), network: subject.network, account: subject.accountId, profileId: subject.profileId,
          state: checkState[row.category], access: accessOf(outcome?.access ?? null), at: outcome?.observedAt ?? null, lastSuccessAt: row.lastSuccessAt,
          receipt: outcome?.receipts.at(-1) ?? null, checkpoint: row.item?.checkpoint.cursor ?? null, owner,
          reason: row.category === "unchanged" || row.category === "newContent" ? null :
            outcome?.reason ? `${outcome.reason}; recovery owner ${owner === j08Owners.J14 ? `J14 source health (${outcome.healthRoute ?? "routing pending"})` : "runtime retry"}` :
            held ? `Held: ${held}` : row.item ? "Due but not yet visited in this run." :
            row.notAdmitted === "J08_PRIOR_PAGE_INCOMPLETE" ? "Due; its watchlist page waits for an unfinished earlier page." : "Due; its watchlist page was not yet admitted." });
      }
      const runRefs = coverage.rows.flatMap(r => r.runRef ? [r.runRef] : []);
      const checked = new Set(coverage.rows.filter(r => r.category === "newContent" || r.category === "unchanged").map(r => r.subjectRef));
      const inbox = repo.messages(runRefs).filter(m => checked.has(m.subjectRef)).map(m => {
        const subject = repo.subject(m.subjectRef)!;
        return { id: m.messageId, creatorId: creatorOf(m.subjectRef), network: m.network, account: m.accountId, profileId: subject.profileId, at: m.at, receipt: m.receiptRef,
          kind: m.kind, interpretation: "observed" as const, context: { access: "authorized" as const, observedAt: m.pageObservedAt, conversationId: m.conversationId,
            messageId: m.messageId, sourceVersion: m.receiptRef, currentStatus: null, proposedStatus: null, expectedVersion: null } };
      });
      const observedAt = maxOf([...checks.flatMap(c => [c.at, c.lastSuccessAt]), ...inbox.map(e => e.context.observedAt)]);
      // A window with no source-dated evidence cannot be placed in source time; it remains in the J08 trace only.
      if (!observedAt) continue;
      projectedRuns.push({ id: window.windowRef, observedAt, receipt: coverage.watchlistVersion, snapshotSize: coverage.snapshotCount, complete: coverage.complete,
        timezone, schedule: options.evidenceStage === "synthetic" ? "disabled" : "unknown", nextRun: null,
        retryPolicy: "Safe reads retry within the registration's attempt budget and resume from the runtime checkpoint; access failures wait for J14 and the takeover owner.",
        jobId: registration.definition.jobId, checks, inbox });
    }
    const latest = windows[0];
    const members: Snapshot["members"] = [];
    for (const row of latest?.coverage.rows ?? []) {
      const subject = repo.subject(row.subjectRef), record = bySubject.get(row.subjectRef);
      if (!subject || !record) continue;
      const confirmed = record.handoffs.filter(h => h.revision === record.revision && h.state === "confirmed" && h.receiptRef);
      const notion = confirmed.find(h => h.target === "notion-creator-crm"), sheets = confirmed.find(h => h.target === "sheets-watchlist" && h.canonicalReceiptRef === notion?.receiptRef);
      if (notion && sheets) members.push({ creatorId: record.creatorId, revision: record.revision, network: subject.network, account: subject.accountId,
        profileId: subject.profileId, notionReceipt: notion.receiptRef!, sheetsReceipt: sheets.receiptRef!, cohort: null });
    }
    const posts: Post[] = repo.allContent().filter(c => c.assignment.state === "attributed" && c.assignment.campaignId && !c.conflict).map(c => {
      const status = repo.status(c.contentKey), last = status.at(-1) ?? null, rowFailure = repo.subjectAccess(c.subjectRef, committed);
      const captured = repo.checkpoints(c.contentKey).filter(x => x.checkpointsVersion === checkpointsVersion && x.state === "captured");
      const record = bySubject.get(c.subjectRef);
      return { network: c.network, account: c.accountId, postId: c.postId, creatorId: creatorOf(c.subjectRef), campaign: c.assignment.campaignId!,
        campaignReceipt: c.assignment.receipts[0]!, collaborationId: null, creativeId: c.creative?.creativeRef ?? null, deliverableId: c.creative?.deliverableRef ?? null,
        enrollmentSource: recruitmentOf(record?.relationships.find(r => r.campaignKey === c.assignment.campaignId)?.recruitmentSource),
        publishedAt: c.publishedAt, publicationReceipt: c.firstReceipt, originalUrl: c.url ? originalPostUrl(c.network, c.postId, c.url) : null,
        // A row-level failure stands until a later complete healthy read of the same row; its last confirmed receipts stay in the history.
        visibility: rowFailure ? "inaccessible" : last?.state ?? "unverified", visibilityReceipt: rowFailure ? null : last?.receiptRef ?? null,
        visibilityAt: rowFailure ? null : last?.observedAt ?? null, access: rowFailure ? accessOf(rowFailure.access) : last ? accessOf(last.access) : "unknown",
        checkpointHours: captured.length ? Math.max(...captured.map(x => x.hours)) : null,
        publicationHistory: status.filter(s => !c.publishedAt || Date.parse(s.observedAt) >= Date.parse(c.publishedAt)).map(s => ({ state: s.state, at: s.observedAt, receipt: s.receiptRef })),
        measurements: measurementRows(c, checkpointsVersion), attribution: c.attribution };
    });
    const observedAt = maxOf([...projectedRuns.map(r => r.observedAt), ...posts.flatMap(p => [p.publishedAt, p.visibilityAt, ...p.measurements.flatMap(m => [m.at, m.confirmedThrough]),
      ...(p.publicationHistory ?? []).map(h => h.at)])]);
    if (!observedAt || !projectedRuns.length) return null;
    const current = Boolean(latest?.coverage.complete) && membership.complete;
    const facts = { scope: { ...scope }, observedAt, validUntil: new Date(Date.parse(observedAt) + MONITOR_MAX_AGE_MS).toISOString(), evidenceStage: options.evidenceStage,
      lifecycleOwnership: "source" as const,
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

  /** The ticket's typed J08 outputs for one window (server-only; raw source references). */
  function output(windowRef: string) {
    const coverage = options.coverage(windowRef), subjects = new Set(coverage.rows.map(r => r.subjectRef)), runRefs = new Set(coverage.rows.flatMap(r => r.runRef ? [r.runRef] : []));
    const content = repo.allContent().filter(c => subjects.has(c.subjectRef));
    const ref = (c: StoredContent): J08Ref => ({ provider: c.network, accountId: c.accountId, sourceId: c.postId, url: c.url });
    const { rows, window: _window, watchlistVersion, ...freshnessCoverage } = coverage;
    void _window;
    const attributed = content.filter(c => c.assignment.state === "attributed" && !c.conflict);
    return {
      watchlistVersion,
      contentRefs: content.map(ref),
      metricSnapshots: content.flatMap(c => repo.metrics(c.contentKey).filter(m => runRefs.has(m.runRef)).map(m => ({ contentRef: ref(c), metricKey: m.metricKey, value: m.value,
        unit: m.unit, window: { start: m.windowStart, end: m.windowEnd }, observedAt: m.observedAt, missingReason: m.missingReason }))),
      statusObservations: content.flatMap(c => repo.status(c.contentKey).filter(s => runRefs.has(s.runRef)).map(s => ({ ref: ref(c), observedAt: s.observedAt,
        sourceUpdatedAt: s.sourceUpdatedAt, method: s.method, value: { visibility: s.state, access: s.access },
        unknownReason: s.state === "inaccessible" ? `CONTENT_${s.access.toUpperCase()}` : null }))),
      freshnessCoverage,
      nextActionQueue: [
        ...repo.proposals(windowRef).map(p => ({ itemRef: p.ref, reason: p.reason, owner: "J09" as const })),
        // Every source-access failure is owned by J14 from the moment it is recorded; `route` is null until J14 has answered.
        ...rows.flatMap(r => { const s = repo.subject(r.subjectRef), o = r.outcome;
          return s && o?.access && o.access !== "authorized" && o.access !== "throttled" && o.access !== "unavailable" ? [{ itemRef: { provider: s.network,
            accountId: s.accountId, sourceId: s.profileId, url: null } as J08Ref, reason: o.reason ?? "SOURCE_ACCESS", owner: "J14" as const, route: o.healthRoute }] : []; }),
      ],
      checkpoint: rows.map(r => r.item?.checkpoint.cursor ?? null).find(cursor => cursor !== null) ?? null,
      // Crossposts keep their own identity. Contracted creatives are counted once, from the ledger's verified publication mapping only.
      creatives: { distinct: new Set(attributed.flatMap(c => c.creative?.creativeRef ? [c.creative.creativeRef] : [])).size,
        mapped: attributed.filter(c => c.creative?.creativeRef).length, unmapped: attributed.filter(c => !c.creative?.creativeRef).length },
      provenance: attributed.map(c => ({ contentRef: ref(c), creative: c.creative?.creativeRef ?? null, deliverable: c.creative?.deliverableRef ?? null,
        mappingReceipt: c.creative?.receiptRef ?? null, unmappedReason: c.creative?.unmappedReason ?? "NO_LEDGER_PUBLICATION_RECORD",
        collaboration: null, collaborationUnknownReason: "J01_COLLABORATION_NOT_LINKED" })),
      rows: rows.map(r => ({ subjectRef: r.subjectRef, state: r.item?.state ?? "notAdmitted", category: r.category, reason: r.outcome?.reason ?? r.item?.reasonCode ?? r.notAdmitted ?? null,
        lastSuccessAt: r.lastSuccessAt })),
    };
  }
  /** Redacted window trace: keyed aliases only, safe to retain as evidence. */
  function trace(windowRef: string, secret: string) {
    const key = createHmac("sha256", secret).update(JSON.stringify(["j08-trace.v1", scope])).digest();
    const alias = (kind: string, value: string) => `${kind}-${createHmac("sha256", key).update(JSON.stringify([kind, value])).digest("hex").slice(0, 16)}`;
    const refAlias = (r: J08Ref) => alias("ref", JSON.stringify([r.provider, r.accountId, r.sourceId]));
    const out = output(windowRef);
    return { schemaVersion: "j08-run-trace.v2", evidenceStage: options.evidenceStage, window: alias("window", windowRef), watchlistVersion: alias("watchlist", out.watchlistVersion),
      freshnessCoverage: out.freshnessCoverage, rows: out.rows.map(r => ({ ...r, subjectRef: alias("row", r.subjectRef) })),
      contentRefs: out.contentRefs.map(r => ({ provider: r.provider, content: refAlias(r) })),
      metricSnapshots: out.metricSnapshots.map(m => ({ ...m, contentRef: refAlias(m.contentRef) })),
      statusObservations: out.statusObservations.map(s => ({ ...s, ref: refAlias(s.ref) })),
      nextActionQueue: out.nextActionQueue.map(a => ({ ...a, itemRef: refAlias(a.itemRef) })),
      checkpoint: out.checkpoint ? alias("checkpoint", out.checkpoint) : null, creatives: out.creatives,
      provenance: out.provenance.map(p => ({ ...p, contentRef: refAlias(p.contentRef), creative: p.creative ? alias("creative", p.creative) : null,
        deliverable: p.deliverable ? alias("deliverable", p.deliverable) : null, mappingReceipt: p.mappingReceipt ? alias("receipt", p.mappingReceipt) : null })) };
  }
  /** A typed aggregate for the existing shared reporter when an hourly window needs review. Delivery keeps the reporter's own policy. */
  function report(windowRef: string, binding: ContentMonitorReportBinding): ReportEvent | null {
    const coverage = options.coverage(windowRef), window = coverage.window;
    if (!window || timezone !== "America/Los_Angeles" || Date.parse(window.windowStart) >= Date.parse(window.windowEnd)) return null;
    const needsSource = coverage.inaccessible + coverage.failed, proposals = repo.proposals(windowRef).length;
    if (!needsSource && !proposals && coverage.deferred === 0) return null;
    return reportEventSchema.parse({ ...binding, eventRef: `j08-window:${digest(windowRef).slice(0, 40)}`, eventVersion: coverage.watchlistVersion.slice(0, 180),
      occurredAt: maxOf(coverage.rows.map(r => r.outcome?.observedAt)) ?? window.windowEnd, severity: "orange",
      identity: { kind: "window", cadence: "orangeDigest", windowRef: `j08:${digest(windowRef).slice(0, 40)}`, start: window.windowStart, end: window.windowEnd,
        timezone: "America/Los_Angeles", launchWindowRef: null },
      subject: { kind: "aggregate", category: "content" },
      facts: [{ label: "coverage", value: coverage.complete ? "complete" : "partial" },
        { label: "pendingItems", value: needsSource + coverage.deferred, unit: "count", missingReason: null },
        { label: "records", value: proposals, unit: "count", missingReason: null }],
      nextAction: needsSource ? "reviewSource" : "reviewContent" });
  }
  return { reader, project, output, trace, report };
}
