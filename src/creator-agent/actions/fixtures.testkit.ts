import { digest } from "../config.ts";
import { ActionServiceError, type ActionAuthorityFence, type ActionPrincipal, type LedgerSnapshot, type LedgerSource, type PrincipalGrant, type ReadinessIntent,
  type ReadinessReceipt, type ReadinessSnapshot, type ReadinessSource, type ExportPayload } from "./contract.ts";

export const actionTestScope = { workspaceId: "fixture-workspace", accountId: "fixture-account", environment: "sandbox" as const };
export const actionTestSecret = "fixture-only-action-reference-key-not-for-deployment-000000";
export const actionTestTime = Date.parse("2026-11-07T05:00:00.000Z");
export const founderFixture: ActionPrincipal = { principalRef: "fixture-founder" };
export const exportFixturePayload: ExportPayload = { format: "csv", filters: { state: "all", startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-11-01T00:00:00.000Z", timezone: "America/Los_Angeles", currency: "USD" } };

/** Synthetic source boundaries only: no credentials, providers or production configuration. */
export function actionDomainFixture(rowCount = 110) {
  let clock = actionTestTime;
  const stamp = () => new Date(clock).toISOString(), until = () => new Date(clock + 3_600_000).toISOString();
  const state = { denyActor: false, denySource: false, writes: 0, pageReads: 0, roles: ["founder"] as PrincipalGrant["roles"],
    loseWriteAck: false, lookupUnknown: false, writeMalformed: false, terminalNotApplied: false };
  const snapshot: LedgerSnapshot = { scope: actionTestScope, snapshotRef: "fixture-ledger-snapshot", version: "ledger-v1", filters: exportFixturePayload.filters,
    asOf: stamp(), validUntil: until(), total: rowCount, complete: true, allowed: true, permissionVersion: "permission-v1" };
  const rows = Array.from({ length: rowCount }, (_, i) => ({ entitlementRef: "native-entitlement-" + i, creatorRef: "native-creator-" + i, sourceRef: "native-source", orderRef: "native-order-" + i,
    currency: "USD", eligibleMinor: i === 0 ? 0 : 3499, commissionMinor: i === 0 ? 0 : 700, commissionRatePct: 20, state: "earned" as const,
    eventAt: "2026-10-20T10:00:00.000Z", observedAt: "2026-11-01T00:00:00.000Z", policyVersion: "native-policy", ledgerRevision: "ledger-v1" }));
  const source: ReadinessSnapshot = { scope: actionTestScope, targetRef: "fixture-launch", version: "readiness-v1", observedAt: stamp(), validUntil: until(), writable: true,
    launchDate: "2026-11-20", launchDateApproved: true, phase: "review", phaseVersion: "phase-v1", phaseAllowed: true,
    gates: [{ id: "product", required: true, state: "pass", evidenceRef: "product-evidence" }, { id: "fulfillment", required: true, state: "pass", evidenceRef: "fulfillment-evidence" }],
    evidenceRefs: ["product-evidence", "fulfillment-evidence"], policyVersion: "readiness-policy-v1" };
  const receipts = new Map<string, ReadinessReceipt>();
  const authorize = async (principalRef: string) => {
    if (state.denyActor) throw new ActionServiceError("AUTHORITY_REQUIRED", 403);
    return { scope: actionTestScope, principalRef, personRef: principalRef + "-person", roles: state.roles, active: true,
      directoryVersion: "directory-v1", observedAt: stamp(), validUntil: until() } satisfies PrincipalGrant;
  };
  const assertAuthority: ActionAuthorityFence = ({ actor }, now) => {
    if (state.denyActor || !actor.active || actor.directoryVersion !== "directory-v1" || digest(actor.roles) !== digest(state.roles) || Date.parse(actor.validUntil) <= now)
      throw new ActionServiceError("AUTHORITY_REQUIRED", 403);
  };
  const denied = () => { if (state.denySource) throw new ActionServiceError("SOURCE_AUTHORITY_DENIED", 403); };
  const ledger: LedgerSource = {
    open: async () => { denied(); return structuredClone(snapshot); },
    page: async (_snapshot, cursor) => { denied(); state.pageReads++; const offset = cursor ? Number(cursor.slice(7)) : 0, selected = rows.slice(offset, offset + 40);
      return { snapshotRef: snapshot.snapshotRef, version: snapshot.version, offset, total: rows.length, rows: structuredClone(selected), nextCursor: offset + selected.length < rows.length ? "cursor-" + (offset + selected.length) : null }; },
    current: async () => { denied(); return structuredClone(snapshot); },
    assertCurrent: s => { denied(); if (digest(s) !== digest(snapshot)) throw new ActionServiceError("EXPORT_SNAPSHOT_CHANGED"); },
  };
  const readiness: ReadinessSource = {
    idempotency: "source-enforced",
    read: async () => { denied(); return structuredClone(source); },
    assertCurrent: s => { denied(); if (digest(s) !== digest(source)) throw new ActionServiceError("READINESS_BASIS_CHANGED"); },
    write: async intent => {
      denied(); state.writes++;
      if (state.writeMalformed) return { ok: true };
      if (intent.expectedVersion !== source.version) throw new ActionServiceError("SOURCE_VERSION_CONFLICT");
      if (intent.payloadDigest !== digest(intent.payload) || intent.confersRelease !== false) throw new Error("Invalid test intent");
      clock++; source.version = "readiness-v" + (state.writes + 1); source.observedAt = stamp();
      const receipt: ReadinessReceipt = { ...intent, kind: "launch-readiness-record", receiptRef: "native-notion-receipt-" + state.writes, recordedVersion: source.version,
        recordedAt: stamp(), provider: "notion" };
      receipts.set(intent.requestKey, receipt);
      if (state.loseWriteAck) throw new Error("Synthetic lost acknowledgment");
      return structuredClone(receipt);
    },
    lookup: async (intent: ReadinessIntent) => { denied();
      if (state.lookupUnknown) return { state: "unknown" };
      const receipt = receipts.get(intent.requestKey);
      if (receipt) return { state: "applied", receipt: structuredClone(receipt) };
      return state.terminalNotApplied ? { state: "notApplied", terminal: true, intent, receiptRef: "native-terminal-fence", observedAt: stamp() } : { state: "unknown" };
    },
  };
  return { state, snapshot, rows, source, receipts, authorize, assertAuthority, ledger, readiness, now: () => clock, tick: (ms = 1) => { clock += ms; } };
}
