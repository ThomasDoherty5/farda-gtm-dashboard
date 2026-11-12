import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import type { NativeAttribution } from "../analytics/views.ts";
import { digest } from "../config.ts";
import type { DigestScope } from "../dailyDigest/contract.ts";
import {
  ReportError, reportEventSchema, reportInstant, reportReference, reportSnapshotSchema, reportSourceLinkSchema,
  type ReportEvent, type ReportLocator, type ReportSnapshot, type ReportSourceRead, type ReportingSource,
} from "../slackReporting/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { weeklyComparisons } from "./comparison.ts";
import { weeklyFactsSchema, weeklyLinksSchema, type WeeklyFacts } from "./contract.ts";
import { WeeklySnapshotError, WeeklySnapshotRepository } from "./repository.ts";
import { previousWeeklyDate, weeklySnapshotAfterLaunch, weeklySnapshotWindow, type WeeklyWindow } from "./schedule.ts";

const eventPrefix = "weekly-kpi:";
const configSchema = z.object({
  producerRef: reportReference,
  policy: z.object({ version: reportReference, adoptionRef: reportReference, approvedLaunchAt: reportInstant.nullable() }).strict(),
  controlledSandbox: z.boolean(),
  destination: reportSnapshotSchema.shape.destination.pick({ targetRef: true, workspaceId: true, channelId: true }),
  link: reportSourceLinkSchema,
  sectionLinks: weeklyLinksSchema,
}).strict();
type Binding = z.infer<typeof configSchema>;
type WeeklySourceRequest = { scope: DigestScope; window: WeeklyWindow; correctionRef: string | null };
export type WeeklySnapshotConfig = Binding & {
  source: {
    read(request: WeeklySourceRequest, context: Pick<ReportSourceRead, "assertCurrent">): Promise<unknown>;
    assertCurrent(facts: WeeklyFacts, policy: Binding["policy"], now: number): void;
  };
  readDelivery(event: ReportEvent, context: ReportSourceRead): Promise<Omit<ReportSnapshot, "event">>;
};

/** Reuse the existing reporting admission, delivery receipts and original-attempt recovery. */
export function createWeeklySnapshotReporting(db: DatabaseSync, scope: DigestScope,
  config: WeeklySnapshotConfig, delegate: ReportingSource, now = Date.now) {
  const { source, readDelivery, ...input } = config;
  const binding = configSchema.parse(input);
  const scopeKey = digest(scope), configHash = digest([scope, binding]);
  const snapshots = new WeeklySnapshotRepository(db, scope, now);
  db.exec(`CREATE TABLE IF NOT EXISTS weekly_kpi_prereads (
    scope_key TEXT NOT NULL, event_ref TEXT NOT NULL, config_hash TEXT NOT NULL, event TEXT NOT NULL,
    destination TEXT NOT NULL, controlled INTEGER NOT NULL, PRIMARY KEY(scope_key,event_ref)
  )`);
  const stored = (eventRef: string) => db.prepare(
    "SELECT config_hash,event,destination,controlled FROM weekly_kpi_prereads WHERE scope_key=? AND event_ref=?",
  ).get(scopeKey, eventRef);
  const owns = (locator: ReportLocator) => locator.eventRef.startsWith(eventPrefix);
  function assertQualified(facts: WeeklyFacts) {
    if (!binding.controlledSandbox && !weeklySnapshotAfterLaunch(facts.window, binding.policy.approvedLaunchAt)) {
      throw new ReportError("WEEKLY_LAUNCH_GATE_CLOSED");
    }
    assertSynchronousVoid(() => source.assertCurrent(structuredClone(facts), structuredClone(binding.policy), now()));
  }

  async function record(window: WeeklyWindow, correctionRef: string | null, assertCurrent: () => void) {
    assertSynchronousVoid(assertCurrent);
    const request = { scope: structuredClone(scope), window: structuredClone(window), correctionRef };
    const raw = await boundedSourceRead(() => source.read(structuredClone(request), { assertCurrent }));
    assertSynchronousVoid(assertCurrent);
    const result = weeklyFactsSchema.safeParse(raw);
    if (!result.success || digest(result.data.window) !== digest(window) || digest(result.data.scope) !== scopeKey ||
        (result.data.correction?.receiptRef ?? null) !== correctionRef || (correctionRef === null && result.data.version !== "v1")) {
      throw new ReportError("WEEKLY_SOURCE_UNVERIFIED", 503);
    }
    try {
      return snapshots.record(result.data, () => {
        assertSynchronousVoid(assertCurrent);
        assertQualified(result.data);
        assertSynchronousVoid(assertCurrent);
      });
    } catch (error) {
      if (error instanceof WeeklySnapshotError) throw new ReportError(error.code, error.status);
      throw error;
    }
  }

  async function prepare(locator: ReportLocator, context: ReportSourceRead): Promise<ReportEvent> {
    const reportDate = locator.eventRef.slice(eventPrefix.length);
    const window = weeklySnapshotWindow(reportDate);
    if (!window) throw new ReportError("WEEKLY_LOCATOR_INVALID", 422);
    assertSynchronousVoid(context.assertCurrent);
    const existing = stored(locator.eventRef);
    if (existing) {
      const event = reportEventSchema.parse(JSON.parse(String(existing.event)));
      if (event.eventVersion !== locator.eventVersion) throw new ReportError("REPORT_EVENT_MISMATCH");
      return event;
    }
    if (context.purpose !== "admit" || locator.eventVersion !== binding.policy.version) throw new ReportError("WEEKLY_REPORT_UNPREPARED", 404);
    if (now() < Date.parse(window.scheduledAt)) throw new ReportError("WEEKLY_REPORT_NOT_DUE");
    if (!binding.controlledSandbox && !weeklySnapshotAfterLaunch(window, binding.policy.approvedLaunchAt)) {
      throw new ReportError("WEEKLY_LAUNCH_GATE_CLOSED");
    }
    const original = snapshots.original(reportDate) ?? await record(window, null, context.assertCurrent);
    assertSynchronousVoid(context.assertCurrent);
    assertQualified(original.facts);
    const prior = snapshots.latest(previousWeeklyDate(reportDate));
    const weeklySnapshot = { snapshot: original.facts, links: binding.sectionLinks, ...weeklyComparisons(original.facts, prior?.facts ?? null) };
    const event = reportEventSchema.parse({
      ...locator, producerRef: binding.producerRef, occurredAt: original.frozenAt, severity: "info",
      identity: { kind: "window", windowRef: locator.eventRef, start: window.start, end: window.end,
        cadence: "mondayWeekly", timezone: window.timezone, launchWindowRef: null },
      subject: { kind: "aggregate", category: "finance" },
      facts: [{ label: "coverage", value: original.facts.coverage }],
      nextAction: original.facts.coverage === "complete" ? "continueMonitoring" : "reviewSource", link: binding.link, weeklySnapshot,
    });
    db.prepare("INSERT OR IGNORE INTO weekly_kpi_prereads VALUES (?,?,?,?,?,?)").run(
      scopeKey, event.eventRef, configHash, JSON.stringify(event), JSON.stringify(binding.destination), Number(binding.controlledSandbox),
    );
    return reportEventSchema.parse(JSON.parse(String(stored(event.eventRef)!.event)));
  }

  const reportingSource: ReportingSource = {
    async readEvent(locator, context) {
      if (!owns(locator)) return delegate.readEvent(locator, context);
      if (!context) throw new ReportError("WEEKLY_MACHINE_REQUIRED", 403);
      const event = await prepare(locator, context);
      assertSynchronousVoid(context.assertCurrent);
      const delivery = await boundedSourceRead(() => readDelivery(structuredClone(event), context));
      assertSynchronousVoid(context.assertCurrent);
      return reportSnapshotSchema.parse({ ...delivery, event });
    },
    assertCurrent(snapshot, purpose, at) {
      if (!owns(snapshot.event)) return delegate.assertCurrent(snapshot, purpose, at);
      const existing = stored(snapshot.event.eventRef);
      const destination = binding.destination;
      const { targetRef, workspaceId, channelId } = snapshot.destination;
      if (!existing || digest(JSON.parse(String(existing.event))) !== digest(snapshot.event) ||
          digest({ targetRef, workspaceId, channelId }) !== digest(JSON.parse(String(existing.destination))) ||
          digest(snapshot.scope) !== scopeKey || (existing.controlled === 1) !== (snapshot.testProvenance?.kind === "controlledSandbox")) {
        throw new ReportError("WEEKLY_REPORT_BINDING_MISMATCH", 403);
      }
      assertSynchronousVoid(() => delegate.assertCurrent(snapshot, purpose, at));
      if (purpose === "read") return;
      if (existing.config_hash !== configHash || digest({ targetRef, workspaceId, channelId }) !== digest(destination) ||
          snapshot.programme.version !== binding.policy.version || snapshot.programme.adoptionRef !== binding.policy.adoptionRef ||
          snapshot.delivery.notBefore !== snapshot.event.weeklySnapshot?.snapshot.window.scheduledAt) {
        throw new ReportError("WEEKLY_REPORT_POLICY_CHANGED");
      }
      assertQualified(snapshot.event.weeklySnapshot!.snapshot);
    },
    authorizeAttempt: (snapshot, command) => delegate.authorizeAttempt(snapshot, command),
    assertGrant: (grant, command, at) => delegate.assertGrant(grant, command, at),
    deliver: (command, context) => delegate.deliver(command, context),
    lookup: (command, context) => delegate.lookup(command, context),
  };

  function attachTrendEvidence(view: NativeAttribution, definition: string, alias: (kind: string, raw: string) => string) {
    if (view.period?.timezone !== "America/Los_Angeles" || view.cohortRef !== null ||
        view.provenance.synthetic !== binding.controlledSandbox) return undefined;
    const verified: { date: string; sourceDigest: string; facts: WeeklyFacts }[] = [];
    view.weeks = view.weeks.map(week => {
      const snapshot = snapshots.latest(week.endDayExclusive);
      if (!snapshot || snapshot.facts.window.start.slice(0, 10) !== week.startDay || week.channels.length !== 2) return week;
      const measures = snapshot.facts.measures.filter(measure => measure.metric === "channelReceipts");
      if (week.channels.some(({ channel, netReceipts }) => {
        const measure = measures.find(value => value.dimension === channel);
        return netReceipts.state !== "known" || netReceipts.provisional || !netReceipts.value ||
          measure?.definition !== definition || measure.actual.currency !== netReceipts.value.currency ||
          measure.actual.decimals !== 2 || measure.actual.amount !== netReceipts.value.minorUnits;
      })) return week;
      try { assertQualified(snapshot.facts); }
      catch { return week; }
      verified.push({ date: week.endDayExclusive, sourceDigest: snapshot.sourceDigest, facts: snapshot.facts });
      const reference = alias("week", snapshot.sourceDigest);
      return { ...week, snapshotVersion: snapshot.facts.version, channels: week.channels.map(channel => ({
        ...channel, netReceipts: { ...channel.netReceipts, evidenceRefs: [reference, ...channel.netReceipts.evidenceRefs].slice(0, 100) },
      })) };
    });
    return verified.length ? () => {
      for (const item of verified) {
        if (snapshots.latest(item.date)?.sourceDigest !== item.sourceDigest) throw new ReportError("WEEKLY_SOURCE_CHANGED");
        assertQualified(item.facts);
      }
    } : undefined;
  }

  return {
    reportingSource, attachTrendEvidence,
    /** Only a trusted source job calls this. It cannot create another delivery or edit an old snapshot. */
    observeCorrection(reportDate: string, receiptRef: string, assertCurrent: () => void) {
      const window = weeklySnapshotWindow(reportDate);
      if (!window || !snapshots.original(reportDate)) throw new ReportError("WEEKLY_ORIGINAL_REQUIRED");
      return record(window, reportReference.parse(receiptRef), assertCurrent);
    },
  };
}
