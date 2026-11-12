import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest } from "../config.ts";
import type { DigestScope } from "../dailyDigest/contract.ts";
import { ReportError, reportEventSchema, reportInstant, reportReference, reportSnapshotSchema, reportSourceLinkSchema,
  type ReportEvent, type ReportLocator, type ReportSnapshot, type ReportSourceRead, type ReportingSource } from "../slackReporting/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { projectLaunchPulse } from "./aggregate.ts";
import { launchDashboardLinkSchema, launchPulseSourceSchema, type LaunchPulseSourceSnapshot } from "./contract.ts";
import { approvedLaunchWindowSchema, duringLaunchReportingHours, launchPulseLocator, launchPulsePrefix, launchPulseSlot, pulseTimeFromRef,
  type ApprovedLaunchWindow, type PulseSlot } from "./schedule.ts";

const destination = reportSnapshotSchema.shape.destination.pick({ targetRef: true, workspaceId: true, channelId: true });
const configSchema = z.object({
  producerRef: reportReference,
  policy: z.object({ version: reportReference, adoptionRef: reportReference }).strict(),
  window: approvedLaunchWindowSchema.nullable(),
  controlledSandbox: z.boolean(), destination, link: reportSourceLinkSchema, dashboardLink: launchDashboardLinkSchema,
  publication: z.object({ decisionRef: reportReference, sandboxReviewRef: reportReference, approvedAt: reportInstant,
    windowVersion: reportReference, policyVersion: reportReference, destination }).strict().nullable(),
}).strict();
type Binding = z.infer<typeof configSchema>;
type SourceRequest = { scope: DigestScope; windowVersion: string; policy: Binding["policy"]; slot: PulseSlot };
type PulseReceipt = Pick<LaunchPulseSourceSnapshot, "receiptRef" | "requestDigest" | "observedAt" | "validUntil">;
type StoredPulse = {
  event: ReportEvent; request: SourceRequest; receipt: PulseReceipt;
  destination: Binding["destination"]; controlled: boolean; bindingHash: string;
};
export type LaunchPulseConfig = Binding & {
  source: {
    assertWindowCurrent(window: ApprovedLaunchWindow, policy: Binding["policy"], publication: Binding["publication"], now: number): void;
    read(request: SourceRequest, context: Pick<ReportSourceRead, "assertCurrent">): Promise<unknown>;
    assertReceiptCurrent(receipt: PulseReceipt, request: SourceRequest, now: number): void;
  };
  readDelivery(event: ReportEvent, destination: Binding["destination"], context: ReportSourceRead): Promise<Omit<ReportSnapshot, "event">>;
};

/** Existing reporting owns work leases and Slack receipts. Only one scoped, frozen payload is prepared for each launch slot. */
export function createLaunchPulseReporting(db: DatabaseSync, scope: DigestScope, config: LaunchPulseConfig,
  delegate: ReportingSource, now = Date.now): ReportingSource {
  const { source, readDelivery, ...input } = config;
  const binding = configSchema.parse(input);
  const scopeKey = digest(scope);
  const windowBasis = binding.window ? digest({ ...binding.window, enabled: undefined }) : null;
  const bindingHash = digest({ scope, ...binding, window: windowBasis });
  db.exec(`
    CREATE TABLE IF NOT EXISTS launch_pulse_windows (
      scope_key TEXT NOT NULL, window_version TEXT NOT NULL, basis_hash TEXT NOT NULL,
      PRIMARY KEY(scope_key,window_version)
    );
    CREATE TABLE IF NOT EXISTS launch_pulses (
      scope_key TEXT NOT NULL, event_ref TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope_key,event_ref)
    );
  `);
  const owns = (locator: ReportLocator) => locator.eventRef.startsWith(launchPulsePrefix);
  function stored(eventRef: string) {
    const row = db.prepare("SELECT body FROM launch_pulses WHERE scope_key=? AND event_ref=?").get(scopeKey, eventRef);
    return row ? JSON.parse(String(row.body)) as StoredPulse : null;
  }
  function approvedSlot(locator: ReportLocator, at: number) {
    const window = binding.window;
    if (!window?.enabled) throw new ReportError("LAUNCH_PULSE_NOT_ENABLED");
    const time = pulseTimeFromRef(locator.eventRef);
    const slot = launchPulseSlot(window, time);
    if (!slot || digest(launchPulseLocator(window, slot)) !== digest({
      eventRef: locator.eventRef, eventVersion: locator.eventVersion,
    })) throw new ReportError("LAUNCH_PULSE_WINDOW_CHANGED");
    if (at < time) throw new ReportError("LAUNCH_PULSE_NOT_DUE");
    if (at >= Date.parse(window.endsAt)) throw new ReportError("LAUNCH_PULSE_WINDOW_ENDED");
    if (!duringLaunchReportingHours(at)) throw new ReportError("LAUNCH_PULSE_OUTSIDE_REPORTING_HOURS");
    const publication = binding.publication;
    if (!binding.controlledSandbox && (!publication || publication.windowVersion !== window.version ||
        publication.policyVersion !== binding.policy.version || digest(publication.destination) !== digest(binding.destination) ||
        Date.parse(publication.approvedAt) > time)) throw new ReportError("LAUNCH_PULSE_PUBLICATION_UNAPPROVED");
    const prior = db.prepare("SELECT basis_hash FROM launch_pulse_windows WHERE scope_key=? AND window_version=?")
      .get(scopeKey, window.version);
    if (prior && prior.basis_hash !== windowBasis) throw new ReportError("LAUNCH_PULSE_WINDOW_VERSION_REUSED");
    assertSynchronousVoid(() => source.assertWindowCurrent(structuredClone(window), structuredClone(binding.policy),
      structuredClone(publication), at));
    return { window, slot };
  }
  function assertReceipt(value: StoredPulse, at: number) {
    if (value.bindingHash !== bindingHash) throw new ReportError("LAUNCH_PULSE_BINDING_CHANGED");
    approvedSlot(value.event, at);
    assertSynchronousVoid(() => source.assertReceiptCurrent(structuredClone(value.receipt), structuredClone(value.request), at));
  }
  async function prepare(locator: ReportLocator, context: ReportSourceRead): Promise<StoredPulse> {
    const prior = stored(locator.eventRef);
    if (prior) {
      if (prior.event.eventVersion !== locator.eventVersion) throw new ReportError("REPORT_EVENT_MISMATCH");
      if (context.purpose !== "read") assertReceipt(prior, now());
      return prior;
    }
    if (context.purpose !== "admit") throw new ReportError("LAUNCH_PULSE_UNPREPARED", 404);
    const { window, slot } = approvedSlot(locator, now());
    const request = { scope: structuredClone(scope), windowVersion: window.version, policy: binding.policy, slot };
    const raw = await boundedSourceRead(() => source.read(structuredClone(request), context));
    context.assertCurrent();
    const parsed = launchPulseSourceSchema.safeParse(raw);
    if (!parsed.success || digest(parsed.data.scope) !== scopeKey || parsed.data.requestDigest !== digest(request)) {
      throw new ReportError("LAUNCH_PULSE_SOURCE_UNVERIFIED", 503);
    }
    const { receiptRef, observedAt, validUntil, requestDigest } = parsed.data;
    const cutoff = Date.parse(slot.scheduledAt), checkedAt = Date.parse(observedAt), expiry = Date.parse(validUntil);
    if (checkedAt < cutoff || checkedAt > now() || expiry <= now() || expiry - checkedAt > 900_000) {
      throw new ReportError("LAUNCH_PULSE_SOURCE_EXPIRED");
    }
    const launchPulse = projectLaunchPulse(parsed.data, slot, binding.dashboardLink);
    const event = reportEventSchema.parse({
      ...locator, producerRef: binding.producerRef, occurredAt: observedAt, severity: "info",
      identity: { kind: "window", windowRef: locator.eventRef, start: new Date(cutoff - 3_600_000).toISOString(),
        end: slot.scheduledAt, cadence: "launchHourly", timezone: slot.timezone, launchWindowRef: window.version },
      subject: { kind: "aggregate", category: "launch" }, facts: [{ label: "coverage", value: launchPulse.coverage }],
      nextAction: launchPulse.coverage === "complete" ? "continueMonitoring" : "reviewSource", link: binding.link, launchPulse,
    });
    const value = { event, request, receipt: { receiptRef, observedAt, validUntil, requestDigest },
      destination: binding.destination, controlled: binding.controlledSandbox, bindingHash };
    db.exec("BEGIN IMMEDIATE");
    try {
      context.assertCurrent();
      if (expiry <= now()) throw new ReportError("LAUNCH_PULSE_SOURCE_EXPIRED");
      assertReceipt(value, now());
      db.prepare("INSERT OR IGNORE INTO launch_pulse_windows VALUES(?,?,?)").run(scopeKey, window.version, windowBasis);
      db.prepare("INSERT OR IGNORE INTO launch_pulses VALUES(?,?,?)").run(scopeKey, event.eventRef, JSON.stringify(value));
      const frozen = stored(event.eventRef)!;
      assertReceipt(frozen, now());
      context.assertCurrent();
      db.exec("COMMIT");
      return frozen;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    async readEvent(locator, context) {
      if (!owns(locator)) return delegate.readEvent(locator, context);
      if (!context) throw new ReportError("LAUNCH_PULSE_MACHINE_REQUIRED", 403);
      context.assertCurrent();
      const { event, destination } = await prepare(locator, context);
      const delivery = await boundedSourceRead(() => readDelivery(structuredClone(event), structuredClone(destination), context));
      context.assertCurrent();
      return reportSnapshotSchema.parse({ ...delivery, event });
    },
    assertCurrent(snapshot, purpose, at) {
      if (!owns(snapshot.event)) return delegate.assertCurrent(snapshot, purpose, at);
      const frozen = stored(snapshot.event.eventRef);
      const actual = destination.parse({ targetRef: snapshot.destination.targetRef,
        workspaceId: snapshot.destination.workspaceId, channelId: snapshot.destination.channelId });
      if (!frozen || digest(snapshot.event) !== digest(frozen.event) || digest(snapshot.scope) !== scopeKey ||
          digest(actual) !== digest(frozen.destination) || frozen.controlled !== (snapshot.testProvenance?.kind === "controlledSandbox")) {
        throw new ReportError("LAUNCH_PULSE_DELIVERY_MISMATCH", 403);
      }
      assertSynchronousVoid(() => delegate.assertCurrent(snapshot, purpose, at));
      if (purpose === "read") return;
      if (snapshot.programme.version !== binding.policy.version || snapshot.programme.adoptionRef !== binding.policy.adoptionRef ||
          snapshot.delivery.notBefore !== frozen.request.slot.scheduledAt) throw new ReportError("LAUNCH_PULSE_POLICY_CHANGED");
      assertReceipt(frozen, at);
    },
    authorizeAttempt: (snapshot, command) => delegate.authorizeAttempt(snapshot, command),
    assertGrant: (grant, command, timestamp) => delegate.assertGrant(grant, command, timestamp),
    deliver: (command, context) => delegate.deliver(command, context),
    lookup: (command, context) => delegate.lookup(command, context),
  };
}
