import { digest } from "../config.ts";
import { ReportError, reportGrantSchema, reportSnapshotSchema, type ReportCommand, type ReportGrant, type ReportLocator, type ReportMachine, type ReportScope, type ReportSnapshot, type ReportingSource } from "./contract.ts";

export function reportMaterial(snapshot: ReportSnapshot) {
  return { scope: snapshot.scope, event: snapshot.event, programme: { ...snapshot.programme, state: undefined }, destination: snapshot.destination, delivery: snapshot.delivery };
}
export function assertLease(observedAt: string, validUntil: string, now: number) {
  if (!Number.isFinite(now) || Date.parse(observedAt) > now || Date.parse(validUntil) <= now || Date.parse(validUntil) <= Date.parse(observedAt)) throw new ReportError("REPORT_SOURCE_EXPIRED");
}
export function assertSyncFence(callback: () => unknown) {
  const value = callback();
  if (value !== undefined) {
    if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value) void Promise.resolve(value).catch(() => {});
    throw new ReportError("REPORT_SYNCHRONOUS_FENCE_REQUIRED", 503);
  }
}
export function assertSnapshot(source: ReportingSource, snapshot: ReportSnapshot, scope: ReportScope, purpose: "admit" | "send" | "read", now: number, machine: ReportMachine) {
  assertSyncFence(() => machine.assertCurrent());
  if (digest(snapshot.scope) !== digest(scope)) throw new ReportError("REPORT_SCOPE_MISMATCH", 403);
  if (snapshot.authority.read === "denied" || (purpose !== "read" && snapshot.authority.send === "denied")) throw new ReportError("REPORT_PERMISSION_DENIED", 403);
  if (snapshot.authority.read !== "allowed" || !snapshot.authority.permissionRef) throw new ReportError("REPORT_READ_UNVERIFIED");
  assertLease(snapshot.authority.observedAt, snapshot.authority.validUntil, now);
  const binding = snapshot.delivery.binding;
  if (digest({ workspaceId: binding.workspaceId, accountId: binding.accountId, environment: binding.environment }) !== digest(scope) || binding.provider !== "slack" || binding.providerAccountId !== snapshot.destination.workspaceId || binding.action !== "post-report" || binding.mode !== "executeApproved" || binding.route === "browser" || binding.requiredScopes.length === 0) throw new ReportError("REPORT_BINDING_MISMATCH");
  if (Date.parse(snapshot.event.occurredAt) > now || Date.parse(snapshot.evidence.asOf) > now) throw new ReportError("REPORT_SOURCE_TIME_INVALID");
  if (purpose !== "read") {
    if (snapshot.programme.state !== "adopted" || !snapshot.programme.permittedProducers.includes(snapshot.event.producerRef)) throw new ReportError("REPORT_PROGRAMME_HELD");
    if (snapshot.authority.send !== "allowed" || snapshot.destination.member !== "verified") throw new ReportError("REPORT_SEND_UNVERIFIED");
    if (!snapshot.evidence.currentTransition || snapshot.evidence.freshness !== "current" || snapshot.evidence.coverage !== "complete" || !snapshot.evidence.linkAuthorized) throw new ReportError("REPORT_EVIDENCE_HELD");
    if (purpose === "send" && Date.parse(snapshot.delivery.notBefore) > now) throw new ReportError("REPORT_NOT_DUE");
    const identity = snapshot.event.identity;
    if (identity.kind === "window") {
      if (Date.parse(identity.end) > now || Date.parse(identity.end) > Date.parse(snapshot.evidence.asOf)) throw new ReportError("REPORT_WINDOW_UNOBSERVED");
      if (identity.cadence === "weekdayDaily" || identity.cadence === "mondayWeekly") {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: identity.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(snapshot.delivery.notBefore));
        const value = (type: string) => parts.find(part => part.type === type)?.value;
        if (value("hour") !== "08" || value("minute") !== "30" || value("second") !== "00" || ["Sat", "Sun"].includes(value("weekday") ?? "") || (identity.cadence === "mondayWeekly" && value("weekday") !== "Mon")) throw new ReportError("REPORT_SCHEDULE_MISMATCH");
      }
    }
  }
  assertSyncFence(() => source.assertCurrent(snapshot, purpose, now));
  assertSyncFence(() => machine.assertCurrent());
}
export async function loadSnapshot(source: ReportingSource | undefined, locator: ReportLocator, scope: ReportScope, purpose: "admit" | "send" | "read", now: () => number, machine: ReportMachine): Promise<ReportSnapshot> {
  assertSyncFence(() => machine.assertCurrent()); if (!source) throw new ReportError("REPORT_SOURCE_UNBOUND", 503);
  const raw = await source.readEvent(locator), parsed = reportSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new ReportError("REPORT_SOURCE_UNVERIFIED", 503);
  const value = parsed.data;
  if (value.event.eventRef !== locator.eventRef || value.event.eventVersion !== locator.eventVersion) throw new ReportError("REPORT_EVENT_MISMATCH");
  assertSnapshot(source, value, scope, purpose, now(), machine); return value;
}
export function validateGrant(source: ReportingSource, raw: unknown, snapshot: ReportSnapshot, command: ReportCommand, now: number): ReportGrant {
  const parsed = reportGrantSchema.safeParse(raw); if (!parsed.success) throw new ReportError("REPORT_GRANT_UNVERIFIED");
  const grant = parsed.data;
  if (digest(grant.scope) !== digest(command.scope) || grant.commandHash !== digest(command) || digest(grant.binding) !== digest(snapshot.delivery.binding)) throw new ReportError("REPORT_GRANT_MISMATCH");
  assertLease(grant.observedAt, grant.validUntil, now); assertSyncFence(() => source.assertGrant(grant, command, now)); return grant;
}
