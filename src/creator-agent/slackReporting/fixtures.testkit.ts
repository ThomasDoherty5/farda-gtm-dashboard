import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "../store.ts";
import { JobRepository } from "../jobs/repository.ts";
import { digest } from "../config.ts";
import { ReportError, reportSnapshotSchema, type ReportCommand, type ReportGrant, type ReportLocator, type ReportMachine, type ReportOutcome, type ReportScope, type ReportSnapshot, type ReportingSource } from "./contract.ts";
import { reportMaterial } from "./source.ts";
import { createSlackReporting } from "./service.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const reportingScope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
export function reportFixture(now: number, suffix = "one", scope: ReportScope = reportingScope): ReportSnapshot {
  return reportSnapshotSchema.parse({ scope,
    event: { eventRef: `event:${suffix}`, eventVersion: "source-v1", producerRef: "producer:synthetic-shipment", occurredAt: new Date(now - 1000).toISOString(), severity: "red", identity: { kind: "incident", conditionRef: `condition:${suffix}`, generation: 1, transition: "breach", sequence: 1, previousClearEventRef: null }, subject: { kind: "order", orderRef: "SYNTHETIC-001" }, facts: [{ label: "shipments", value: 1, unit: "count", missingReason: null }], nextAction: "inspectShipment", link: { kind: "linear", workspaceSlug: "synthetic", issueIdentifier: "EXAMPLE-1", authorizationRef: "source:synthetic-link" } },
    programme: { programmeRef: "programme:synthetic-reporting", version: "policy-v1", adoptionRef: "source:synthetic-adoption", authority: "report-policy", state: "adopted", permittedProducers: ["producer:synthetic-shipment"], policy: "immediate-red-digest-orange-source-scheduled-info", grantsBusinessAuthority: false },
    destination: { targetRef: "target:synthetic-alerts", version: "target-v1", workspaceId: "TSYNTHETIC", channelId: "CSYNTHETIC", botId: "BSYNTHETIC", member: "verified", owner: { state: "active", memberId: "USYNTHETIC", mappingVersion: "owner-v1" }, backup: "none-approved" },
    authority: { read: "allowed", send: "allowed", sourceRef: "source:synthetic-report", sourceVersion: "source-v1", permissionRef: "permission:synthetic", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString() },
    evidence: { asOf: new Date(now).toISOString(), freshness: "current", coverage: "complete", currentTransition: true, linkAuthorized: true },
    delivery: { notBefore: new Date(now - 1).toISOString(), binding: { ...scope, provider: "slack", providerAccountId: "TSYNTHETIC", action: "post-report", mode: "executeApproved", route: "api", routeRef: "route:synthetic-report", authorizationScopeVersion: "scope-v1", toolVersion: "tool-v1", requiredScopes: ["chat-write", "history-read"], connectionRef: null, secretRef: null } },
  });
}

/** Source-only synthetic fixture. No database, job repository, server, connection or sender is installed. */
export function createReportingSourceFixture(scope: ReportScope = reportingScope, initialNow = Date.parse("2026-11-07T12:00:00.000Z")) {
  let now = initialNow;
  const snapshots = new Map<string, ReportSnapshot>(), grants = new Map<string, ReportGrant>(), outcomes = new Map<string, unknown>();
  const key = (locator: ReportLocator) => `${locator.eventRef}|${locator.eventVersion}`;
  const state = { actorAllowed: true, readAllowed: true, sendAllowed: true, quotaAllowed: true, calls: [] as ReportCommand[], lookups: [] as ReportCommand[], grantCalls: 0,
    beforeRead: undefined as undefined | (() => void | Promise<void>), afterRead: undefined as undefined | (() => void), beforeGrant: undefined as undefined | (() => void | Promise<void>), beforeDeliver: undefined as undefined | (() => void | Promise<void>), afterDeliver: undefined as undefined | (() => void), beforeLookup: undefined as undefined | (() => void | Promise<void>), afterLookup: undefined as undefined | (() => void),
    mode: "applied" as "applied" | "lostAck" | "unknown" | "rate", ackOverride: undefined as undefined | ((outcome: ReportOutcome) => unknown) };
  const current = (locator: ReportLocator) => {
    const value = snapshots.get(key(locator)); if (!value) return null;
    return { ...structuredClone(value), authority: { ...value.authority, read: state.readAllowed ? value.authority.read : "denied" as const, send: state.sendAllowed ? value.authority.send : "denied" as const, observedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString() } };
  };
  const source: ReportingSource = {
    async readEvent(locator) { await state.beforeRead?.(); const value = current(locator); state.afterRead?.(); return value; },
    assertCurrent(snapshot, purpose) {
      const actual = current(snapshot.event); if (!actual || digest(reportMaterial(actual)) !== digest(reportMaterial(snapshot))) throw new ReportError("REPORT_FROZEN_SOURCE_CHANGED");
      if (!state.readAllowed || (purpose !== "read" && !state.sendAllowed)) throw new ReportError("REPORT_PERMISSION_DENIED", 403);
      if (purpose !== "read" && (actual.programme.state !== "adopted" || actual.destination.member !== "verified" || actual.evidence.freshness !== "current" || actual.evidence.coverage !== "complete" || !actual.evidence.currentTransition || !actual.evidence.linkAuthorized)) throw new ReportError("REPORT_EVIDENCE_HELD");
    },
    async authorizeAttempt(snapshot, command) {
      state.grantCalls++; await state.beforeGrant?.();
      const value: ReportGrant = { scope, authority: "report-policy", commandHash: digest(command), grantRef: `grant:${digest(command)}`, quotaAllocationRef: `quota:${digest(command)}`, exclusive: true, maxMessages: 1, binding: snapshot.delivery.binding, observedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString() };
      grants.set(value.grantRef, structuredClone(value)); return value;
    },
    assertGrant(grant, command) { if (!state.quotaAllowed || digest(grants.get(grant.grantRef)) !== digest(grant) || grant.commandHash !== digest(command)) throw new ReportError("REPORT_GRANT_UNVERIFIED"); },
    async deliver(command, context) {
      await state.beforeDeliver?.(); context.assertCurrent(); state.calls.push(structuredClone(command));
      let outcome: ReportOutcome;
      if (state.mode === "rate") outcome = { state: "notApplied", proof: { scope, requestKey: command.requestKey, attemptRef: command.attemptRef, attemptNumber: command.attemptNumber, commandHash: digest(command), targetVersion: command.targetVersion, proofRef: `closure:${digest(command)}`, observedAt: new Date(now).toISOString(), complete: true, originalAttemptClosed: true, reasonCode: "RATE_LIMITED", retryAfterMs: 5000 } };
      else if (state.mode === "unknown") outcome = { state: "uncertain", reasonCode: "OUTCOME_UNKNOWN" };
      else outcome = { state: "applied", receipt: { receiptRef: `native-receipt:${digest(command)}`, scope, requestKey: command.requestKey, attemptRef: command.attemptRef, attemptNumber: command.attemptNumber, reportRef: command.reportRef, eventRef: command.eventRef, eventVersion: command.eventVersion, targetRef: command.targetRef, targetVersion: command.targetVersion, workspaceId: command.workspaceId, channelId: command.channelId, botId: command.botId, threadTs: command.threadTs, messageTs: ((now - 10) / 1000 + state.calls.length / 1_000_000).toFixed(6), bodyHash: command.bodyHash, observedAt: new Date(now).toISOString() } };
      outcomes.set(command.requestKey, structuredClone(outcome)); state.afterDeliver?.();
      if (state.mode === "lostAck") throw new Error("synthetic-response-lost");
      return state.ackOverride ? state.ackOverride(outcome) : outcome;
    },
    async lookup(command, context) { await state.beforeLookup?.(); context.assertCurrent(); state.lookups.push(structuredClone(command)); const result = outcomes.get(command.requestKey) ?? null; state.afterLookup?.(); return result; },
  };
  const machine: ReportMachine = { workerRef: "worker:synthetic-reporter", assertCurrent() { if (!state.actorAllowed) throw new ReportError("REPORT_PERMISSION_DENIED", 403); } };
  const add = (snapshot: ReportSnapshot) => { snapshots.set(key(snapshot.event), structuredClone(snapshot)); return { eventRef: snapshot.event.eventRef, eventVersion: snapshot.event.eventVersion }; };
  const locator = add(reportFixture(now, "one", scope));
  return { scope, state, source, machine, snapshots, outcomes, locator, add, get now() { return now; }, advance(ms: number) { now += ms; } };
}

/** Controlled SQLite + the same source-only fixture; never a native Slack integration. */
export function createReportingTestkit() {
  const fixture = createReportingSourceFixture(), { scope, source, machine, locator } = fixture;
  const directory = mkdtempSync(join(tmpdir(), "farda-reporting-test-")), path = join(directory, "agent.sqlite");
  const seed = new AgentStore(path, scope); seed.close(); let db = new DatabaseSync(path);
  let jobs = new JobRepository(db, { scope, now: () => fixture.now }), service = createSlackReporting({ db, scope, secret: "synthetic-reporting-private-test-key-000000000000", jobs, source, now: () => fixture.now });
  return { ...fixture, directory, path,
    get db() { return db; }, get jobs() { return jobs; }, get service() { return service; }, get now() { return fixture.now; },
    async accept(input = locator, requestKey = "synthetic-request") { return service.accept(input, requestKey, machine); },
    reopen() { db.close(); db = new DatabaseSync(path); jobs = new JobRepository(db, { scope, now: () => fixture.now }); service = createSlackReporting({ db, scope, secret: "synthetic-reporting-private-test-key-000000000000", jobs, source, now: () => fixture.now }); },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
