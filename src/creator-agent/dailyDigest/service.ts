import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import type { ThresholdDigest } from "../operationalAlerts/presentation.ts";
import {
  ReportError, reportEventSchema, reportInstant, reportReference, reportSnapshotSchema, reportSourceLinkSchema,
  type ReportEvent, type ReportLocator, type ReportSnapshot, type ReportSourceRead, type ReportingSource,
} from "../slackReporting/contract.ts";
import { unavailableDigestResult } from "./aggregate.ts";
import {
  digestAllClear, digestCohortSchema, digestDatasets, digestLinksSchema, digestScopeSchema, digestSourceBindingSchema,
  type DigestCohort, type DigestDataset, type DigestResult, type DigestScope, type DigestWindow,
} from "./contract.ts";
import { collectDigestDataset, type DigestQuery, type DigestSource } from "./query.ts";
import { dailyDigestWindow } from "./schedule.ts";

const eventPrefix = "daily-exceptions:";
const maxAttempts = 3;
const leaseMs = 5 * 60_000;
const configSchema = z.object({
  producerRef: reportReference,
  policy: z.object({ version: reportReference, adoptionRef: reportReference, effectiveAt: reportInstant }).strict(),
  destination: reportSnapshotSchema.shape.destination.pick({ targetRef: true, workspaceId: true, channelId: true }),
  link: reportSourceLinkSchema,
  sectionLinks: digestLinksSchema,
  sources: z.record(z.enum(digestDatasets), digestSourceBindingSchema),
}).strict();
type DigestBinding = z.infer<typeof configSchema>;

export type DailyDigestConfig = DigestBinding & {
  source: DigestSource;
  thresholds?: (window: DigestWindow) => ThresholdDigest;
  cohort?: {
    read(scope: DigestScope, reportDate: string, context: Pick<ReportSourceRead, "assertCurrent">): Promise<unknown>;
    assertCurrent(value: DigestCohort, now: number): void;
  };
  /** Resolve the existing adopted reporting programme and destination for this immutable report event. */
  readDelivery(event: ReportEvent, context: ReportSourceRead): Promise<Omit<ReportSnapshot, "event">>;
};

type QueryState = Partial<Record<DigestDataset, { result: DigestResult; retryAfterMs: number }>>;
type DigestRun = { window: DigestWindow; destination: DigestBinding["destination"]; queries: QueryState; event: ReportEvent | null };
type StoredRun = { config_hash: string; body: string; attempts: number; retry_at: number; lease_until: number };
const needsRetry = (result: DigestResult) => result.reason === "readFailed" || result.reason === "partialCoverage";

/** This journal stores read checkpoints and one immutable report. Delivery stays in the shared report/job repository. */
export function createDailyDigestReporting(
  db: DatabaseSync, scopeInput: DigestScope, config: DailyDigestConfig,
  delegate: ReportingSource, now: () => number = Date.now,
): ReportingSource {
  const scope = digestScopeSchema.parse(scopeInput);
  const { source, cohort, readDelivery, thresholds, ...bindingInput } = config;
  const binding = configSchema.parse(bindingInput);
  const configHash = digest([scope, binding]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_digest_reads (
      event_ref TEXT PRIMARY KEY, config_hash TEXT NOT NULL, body TEXT NOT NULL,
      attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER NOT NULL
    )
  `);
  const get = (eventRef: string) => db.prepare("SELECT config_hash,body,attempts,retry_at,lease_until FROM daily_digest_reads WHERE event_ref=?").get(eventRef) as StoredRun | undefined;
  const isDigest = (locator: ReportLocator) => locator.eventRef.startsWith(eventPrefix);
  const queryFor = (dataset: DigestDataset, window: DigestWindow): DigestQuery | null => {
    const sourceBinding = binding.sources[dataset];
    return sourceBinding ? { scope, dataset, binding: sourceBinding, window } : null;
  };

  function assertDigestScope(snapshot: ReportSnapshot, target: DigestBinding["destination"]) {
    const destination = snapshot.destination;
    if (digest(snapshot.scope) !== digest(scope) ||
        destination.targetRef !== target.targetRef || destination.workspaceId !== target.workspaceId ||
        destination.channelId !== target.channelId) throw new ReportError("DIGEST_DESTINATION_MISMATCH", 403);
  }

  async function resolveWindow(reportDate: string, context: ReportSourceRead) {
    const weekday = dailyDigestWindow(reportDate, null);
    if (weekday) return weekday;
    if (!cohort) throw new ReportError("DIGEST_WEEKEND_UNSCHEDULED", 409);
    context.assertCurrent();
    const raw = await cohort.read(structuredClone(scope), reportDate, { assertCurrent: context.assertCurrent });
    context.assertCurrent();
    const parsed = digestCohortSchema.safeParse(raw);
    if (!parsed.success) throw new ReportError("DIGEST_WEEKEND_UNSCHEDULED", 409);
    if (digest(parsed.data.scope) !== digest(scope)) throw new ReportError("DIGEST_COHORT_SCOPE_MISMATCH", 403);
    assertSynchronousVoid(() => cohort.assertCurrent(parsed.data, now()));
    const window = dailyDigestWindow(reportDate, parsed.data);
    if (!window) throw new ReportError("DIGEST_WEEKEND_UNSCHEDULED", 409);
    return window;
  }

  async function prepare(locator: ReportLocator, context: ReportSourceRead): Promise<ReportEvent> {
    const eventRef = locator.eventRef;
    const date = z.string().date().safeParse(eventRef.slice(eventPrefix.length));
    if (!date.success) throw new ReportError("DIGEST_LOCATOR_INVALID", 422);
    context.assertCurrent();
    let prior = get(eventRef);
    if (context.purpose === "read") {
      const stored = prior ? JSON.parse(prior.body) as DigestRun : null;
      if (!stored?.event || stored.event.eventVersion !== locator.eventVersion) throw new ReportError("DIGEST_REPORT_NOT_PREPARED", 404);
      return reportEventSchema.parse(stored.event);
    }
    if (locator.eventVersion !== binding.policy.version) throw new ReportError("DIGEST_LOCATOR_INVALID", 422);
    if (!prior) {
      if (context.purpose !== "admit") throw new ReportError("DIGEST_REPORT_NOT_PREPARED", 404);
      const window = await resolveWindow(date.data, context);
      const timestamp = now();
      if (Date.parse(window.scheduledAt) < Date.parse(binding.policy.effectiveAt)) throw new ReportError("DIGEST_POLICY_NOT_EFFECTIVE");
      if (timestamp < Date.parse(window.scheduledAt)) throw new ReportError("DIGEST_NOT_DUE");
      if (timestamp >= Date.parse(window.nextDayStart)) throw new ReportError("DIGEST_SLOT_CLOSED");
      context.assertCurrent();
      const run: DigestRun = { window, destination: binding.destination, queries: {}, event: null };
      db.prepare("INSERT OR IGNORE INTO daily_digest_reads VALUES (?,?,?,0,0,NULL,0)").run(eventRef, configHash, JSON.stringify(run));
      prior = get(eventRef)!;
    }
    if (prior.config_hash !== configHash) throw new ReportError("DIGEST_BINDING_CHANGED");
    const existing = JSON.parse(prior.body) as DigestRun;
    if (existing.event) return reportEventSchema.parse(existing.event);
    if (context.purpose !== "admit") throw new ReportError("DIGEST_REPORT_NOT_PREPARED", 404);
    const claimTime = now();
    if (prior.retry_at > claimTime) throw new ReportError("DIGEST_SOURCE_RETRY_DUE", 503, "notApplied", prior.retry_at - claimTime);
    const leaseToken = randomUUID();
    const acquired = db.prepare(`
      UPDATE daily_digest_reads
      SET lease_token=?, lease_until=?, attempts=min(attempts+1, ?)
      WHERE event_ref=? AND config_hash=? AND attempts=? AND lease_until<=? AND retry_at<=? AND json_extract(body,'$.event') IS NULL
      RETURNING body, attempts
    `).get(leaseToken, claimTime + leaseMs, maxAttempts, eventRef, configHash, prior.attempts, claimTime, claimTime);
    if (!acquired) throw new ReportError("DIGEST_READ_IN_PROGRESS", 409);
    const run = JSON.parse(String(acquired.body)) as DigestRun;
    const attempts = Number(acquired.attempts);
    const assertCurrent = () => {
      context.assertCurrent();
      const current = db.prepare("SELECT lease_token,lease_until FROM daily_digest_reads WHERE event_ref=?").get(eventRef);
      if (current?.lease_token !== leaseToken || Number(current.lease_until) <= now()) throw new ReportError("DIGEST_READ_LEASE_LOST");
      if (run.window.cohort) {
        if (!cohort) throw new ReportError("DIGEST_COHORT_UNCONFIGURED");
        const proof = structuredClone(run.window.cohort);
        assertSynchronousVoid(() => cohort.assertCurrent(proof, now()));
      }
      context.assertCurrent();
    };
    const checkpoint = () => {
      assertCurrent();
      const write = db.prepare("UPDATE daily_digest_reads SET body=? WHERE event_ref=? AND lease_token=? AND lease_until>?")
        .run(JSON.stringify(run), eventRef, leaseToken, now());
      if (write.changes !== 1) throw new ReportError("DIGEST_READ_LEASE_LOST");
    };
    let retryAt = 0;
    try {
      for (const dataset of digestDatasets) {
        assertCurrent();
        const query = queryFor(dataset, run.window);
        const saved = run.queries[dataset];
        if (saved && !needsRetry(saved.result)) {
          if (!saved.result.coverage || !query) continue;
          try {
            const coverage = structuredClone(saved.result.coverage);
            assertSynchronousVoid(() => source.assertCurrent(structuredClone(query), coverage, now()));
            continue;
          } catch {
            assertCurrent();
            delete run.queries[dataset];
          }
        }
        // A crash after consuming the last attempt may leave some queries unread.
        // Keep their unavailable state rather than issuing further calls.
        if (prior.attempts >= maxAttempts) continue;
        run.queries[dataset] = query
          ? await collectDigestDataset(source, query, { assertCurrent }, now)
          : { result: unavailableDigestResult(dataset, "unconfigured"), retryAfterMs: 0 };
        checkpoint();
      }
      const results = digestDatasets.map(dataset =>
        run.queries[dataset]?.result ?? unavailableDigestResult(dataset, "readFailed"));
      if (attempts < maxAttempts && results.some(needsRetry)) {
        const backoff = Math.max(1000 * 2 ** (attempts - 1), ...Object.values(run.queries).map(value => value?.retryAfterMs ?? 0));
        retryAt = now() + backoff;
        throw new ReportError("DIGEST_SOURCE_RETRY_DUE", 503, "notApplied", backoff);
      }
      const dailyDigest = { window: run.window, links: binding.sectionLinks, results,
        ...(thresholds ? { thresholdAlerts: thresholds(run.window) } : {}) };
      const clear = digestAllClear(dailyDigest);
      run.event = reportEventSchema.parse({
        ...locator, producerRef: binding.producerRef, occurredAt: new Date(now()).toISOString(),
        severity: clear ? "info" : "orange",
        identity: {
          kind: "window", windowRef: eventRef, start: run.window.start, end: run.window.end,
          cadence: "dailyExceptions", timezone: run.window.timezone, launchWindowRef: null,
        },
        subject: { kind: "aggregate", category: "launch" },
        facts: [{ label: "coverage", value: results.every(result => result.state === "complete") ? "complete" : "partial" }],
        nextAction: clear ? "continueMonitoring" : "reviewSource",
        link: binding.link, dailyDigest,
      });
      checkpoint();
      return run.event;
    } finally {
      db.prepare("UPDATE daily_digest_reads SET retry_at=?, lease_token=NULL, lease_until=0 WHERE event_ref=? AND lease_token=?")
        .run(retryAt, eventRef, leaseToken);
    }
  }

  return {
    async readEvent(locator, context) {
      if (!isDigest(locator)) return delegate.readEvent(locator, context);
      if (!context) throw new ReportError("DIGEST_MACHINE_REQUIRED", 403);
      const event = await prepare(locator, context);
      context.assertCurrent();
      const delivery = await readDelivery(structuredClone(event), context);
      context.assertCurrent();
      const snapshot = reportSnapshotSchema.parse({ ...delivery, event });
      return snapshot;
    },
    assertCurrent(snapshot, purpose, timestamp) {
      if (!isDigest(snapshot.event)) return delegate.assertCurrent(snapshot, purpose, timestamp);
      const prior = get(snapshot.event.eventRef);
      const stored = prior ? JSON.parse(prior.body) as DigestRun : null;
      if (!stored?.event || digest(stored.event) !== digest(snapshot.event)) {
        throw new ReportError("DIGEST_REPORT_CHANGED");
      }
      assertDigestScope(snapshot, stored.destination);
      assertSynchronousVoid(() => delegate.assertCurrent(snapshot, purpose, timestamp));
      // Original-attempt lookup uses the saved destination and current read authority.
      // A new programme version may hold sends without erasing the old receipt.
      if (purpose === "read") return;
      if (prior?.config_hash !== configHash || snapshot.programme.version !== binding.policy.version ||
          snapshot.programme.adoptionRef !== binding.policy.adoptionRef) throw new ReportError("DIGEST_POLICY_CHANGED");
      const report = snapshot.event.dailyDigest!;
      if (digest(report.thresholdAlerts ?? null) !== digest(thresholds?.(report.window) ?? null)) {
        throw new ReportError("DIGEST_ALERT_COVERAGE_CHANGED");
      }
      if (report.window.cohort) {
        if (!cohort) throw new ReportError("DIGEST_COHORT_UNCONFIGURED");
        const proof = structuredClone(report.window.cohort);
        assertSynchronousVoid(() => cohort.assertCurrent(proof, timestamp));
      }
      for (const result of report.results) {
        if (!result.coverage) continue;
        const query = queryFor(result.dataset, report.window);
        if (!query) throw new ReportError("DIGEST_BINDING_CHANGED");
        assertSynchronousVoid(() => source.assertCurrent(structuredClone(query), structuredClone(result.coverage), timestamp));
      }
    },
    authorizeAttempt: (snapshot, command) => delegate.authorizeAttempt(snapshot, command),
    assertGrant: (grant, command, timestamp) => delegate.assertGrant(grant, command, timestamp),
    deliver: (command, context) => delegate.deliver(command, context),
    lookup: (command, context) => delegate.lookup(command, context),
  };
}
