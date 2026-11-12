import { z } from "zod";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest } from "../config.ts";
import { ReportError, reportReference, reportSnapshotSchema, type ReportLocator,
  type ReportScope, type ReportSourceRead, type ReportingSource } from "../slackReporting/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { weeklySnapshotWindow, type WeeklyWindow } from "../weeklySnapshots/schedule.ts";
import { creatorHandoffPrefix, creatorPipelinePath, creatorWeeklyPrefix } from "./contract.ts";
import { summarizeCreatorWeek } from "./weekly.ts";

const destination = reportSnapshotSchema.shape.destination.pick({
  targetRef: true, version: true, workspaceId: true, channelId: true, botId: true,
});
const configuration = z.object({
  producerRef: reportReference, destination, controlledSandbox: z.boolean(),
  dashboardOrigin: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch { return false; }
  }),
}).strict();
type Binding = z.infer<typeof configuration>;
export type CreatorFeedConfig = Binding & {
  readWeeklyFacts(request: { scope: ReportScope; window: WeeklyWindow; sourceVersion: string }, context: ReportSourceRead): Promise<unknown>;
};

const owns = ({ eventRef }: ReportLocator) => eventRef.startsWith(creatorHandoffPrefix) || eventRef.startsWith(creatorWeeklyPrefix);
const snapshotEnvelope = z.object({ event: z.record(z.unknown()) }).passthrough();

/** Uses the existing reporting authorization, native attempt reconciliation and exact destination. */
export function bindCreatorFeed(delegate: ReportingSource, scope: ReportScope, config?: CreatorFeedConfig, now = Date.now): ReportingSource {
  const binding = config ? configuration.parse({ producerRef: config.producerRef, destination: config.destination,
    dashboardOrigin: config.dashboardOrigin, controlledSandbox: config.controlledSandbox }) : null;
  return {
    authorizeAttempt: (snapshot, command) => delegate.authorizeAttempt(snapshot, command),
    assertGrant: (grant, command, at) => delegate.assertGrant(grant, command, at),
    deliver: (command, context) => delegate.deliver(command, context),
    lookup: (command, context) => delegate.lookup(command, context),
    async readEvent(locator, context) {
      if (!owns(locator)) return delegate.readEvent(locator, context);
      if (!context) throw new ReportError("CREATOR_FEED_MACHINE_REQUIRED", 403);
      if ((!binding || !config) && context.purpose !== "read") throw new ReportError("CREATOR_FEED_UNCONFIGURED", 503);
      context.assertCurrent();
      const raw = await boundedSourceRead(() => delegate.readEvent(locator, context));
      context.assertCurrent();
      if (!locator.eventRef.startsWith(creatorWeeklyPrefix) || !binding || !config) return raw;
      // Original receipt reads may use the source-owned frozen summary even if fresh aggregation is unavailable.
      if (context.purpose === "read" && reportSnapshotSchema.safeParse(raw).success) return raw;
      const envelope = snapshotEnvelope.safeParse(raw), window = weeklySnapshotWindow(locator.eventRef.slice(creatorWeeklyPrefix.length));
      if (!envelope.success || !window) throw new ReportError("CREATOR_WEEK_SOURCE_UNVERIFIED");
      const facts = await boundedSourceRead(() => config.readWeeklyFacts({
        scope: structuredClone(scope), window: structuredClone(window), sourceVersion: locator.eventVersion,
      }, context));
      context.assertCurrent();
      const creatorWeekly = summarizeCreatorWeek(facts, window, scope, binding.dashboardOrigin + creatorPipelinePath, now());
      if (!creatorWeekly || creatorWeekly.sourceVersion !== locator.eventVersion) throw new ReportError("CREATOR_WEEK_SOURCE_UNVERIFIED");
      return { ...envelope.data, event: { ...envelope.data.event, creatorWeekly } };
    },
    assertCurrent(snapshot, purpose, at) {
      // The reporting service independently matches the original read target and current read permission.
      if (!owns(snapshot.event) || purpose === "read") return delegate.assertCurrent(snapshot, purpose, at);
      if (!binding) throw new ReportError("CREATOR_FEED_UNCONFIGURED", 503);
      const { event } = snapshot, fact = event.creatorHandoff, week = event.creatorWeekly;
      const { targetRef, version, workspaceId, channelId, botId } = snapshot.destination;
      const target = { targetRef, version, workspaceId, channelId, botId };
      const dashboard = fact?.dashboardLink ?? week?.dashboardLink;
      if (!dashboard || new URL(dashboard).origin !== binding.dashboardOrigin ||
          digest(target) !== digest(binding.destination) || event.producerRef !== binding.producerRef ||
          binding.controlledSandbox !== (snapshot.testProvenance?.kind === "controlledSandbox")) {
        throw new ReportError("CREATOR_FEED_DESTINATION_MISMATCH", 403);
      }
      const asOf = Date.parse(snapshot.evidence.asOf), occurredAt = Date.parse(event.occurredAt);
      if (fact && (Date.parse(fact.observedAt) > asOf ||
          Date.parse(snapshot.delivery.notBefore) < Date.parse(fact.observedAt) ||
          fact.kind === "agreement" && fact.postingDeadline && Date.parse(fact.postingDeadline) < occurredAt ||
          fact.kind === "sampleDelivered" && fact.clock && Date.parse(fact.clock.reviewAfter) < occurredAt) ||
          week && (digest(weeklySnapshotWindow(week.window.reportDate)) !== digest(week.window) ||
            snapshot.delivery.notBefore !== week.window.scheduledAt || occurredAt < Date.parse(week.window.scheduledAt) ||
            Date.parse(week.asOf) < Date.parse(week.window.end) || Date.parse(week.asOf) > asOf)) {
        throw new ReportError("CREATOR_FEED_TIME_MISMATCH");
      }
      assertSynchronousVoid(() => delegate.assertCurrent(snapshot, purpose, at));
    },
  };
}
