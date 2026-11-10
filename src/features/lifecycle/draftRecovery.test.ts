import { webcrypto } from "node:crypto";
import type { SaveResourceResponse } from "@/adapter/contract";
import { SCHEMA_VERSION } from "@/adapter/contract";
import { mandatoryPolicies, type NativeEmailFlow, type SaveReceipt } from "@/creator-agent/lifecycle/contract";
import { matchesDraftAck, prepareDraft, recoverDraft } from "./draftRecovery";

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());
const scope = { workspaceId: "test", accountId: "test", environment: "sandbox" as const };
async function example() {
  const pending = await prepareDraft(scope, "agent-reviewer", "flow-early-access", "lf1-" + "a".repeat(64), { entryEventRef: "event", timingRuleRef: "timing", timezone: "UTC", templateRef: "template", templateVersion: "version", templateName: "Local title" });
  const receipt: SaveReceipt = { scope, resourceRef: pending.resourceRef, resourceVersion: "lf1-" + "b".repeat(64), persistedAt: "2026-11-07T03:00:00Z", persistedByRef: pending.actorRef,
    record: { kind: "local-flow-draft", flow: "early-access", revision: 1, payload: pending.payload, sourceVersion: "source-1", catalogVersion: "catalog-1", policyVersion: "policy-1", templateVersion: "version", lockedPolicies: mandatoryPolicies, savedAt: "2026-11-07T03:00:00Z", savedBy: pending.actorRef },
    reasonCodes: [], requestKey: pending.requestKey, expectedVersion: pending.expectedVersion, payloadDigest: pending.payloadDigest };
  const ack: SaveResourceResponse<SaveReceipt> = { schemaVersion: SCHEMA_VERSION, requestId: "request", scope: { workspaceId: "test", accountIds: ["test"], environment: "sandbox", authorizationScopeVersion: "v1" }, resourceRef: receipt.resourceRef,
    resourceVersion: receipt.resourceVersion, persistedAt: receipt.persistedAt, persistedByRef: receipt.persistedByRef, record: receipt, reasonCodes: [], executionCertainty: "applied" };
  const data: NativeEmailFlow = { kind: "source-email-flow", flow: "early-access", observedAt: receipt.persistedAt, actorRef: pending.actorRef, sourceAsOf: null, sourceVersion: null, validUntil: null, freshness: "unknown", coverage: "unknown", sourceState: "unconfigured", missingReason: "No source binding", sourceLink: null,
    sourceConfig: null, lockedPolicies: mandatoryPolicies, draft: receipt.record, draftVersion: receipt.resourceVersion, currentSourceMatch: false, history: { total: 1, truncated: false, rows: [receipt.record] }, saveHoldReasons: ["No source binding"],
    requestedSave: { state: "applied", disposition: "recorded", requestKey: pending.requestKey, resourceRef: pending.resourceRef, actorRef: pending.actorRef, expectedVersion: pending.expectedVersion, payloadDigest: pending.payloadDigest, original: { payload: pending.payload, expectedVersion: pending.expectedVersion }, receipt, reasonCode: null } };
  return { pending, receipt, ack, data };
}

describe("native lifecycle draft acknowledgment and readback", () => {
  it("matches the immutable exact ACK and recovers the original intent after reload without browser persistence", async () => {
    const { pending, ack, data } = await example();
    expect(matchesDraftAck(ack, pending)).toBe(true);
    expect((await recoverDraft(scope, data, pending.requestKey, null))?.pending).toEqual(pending);
  });
  it.each(["resourceRef", "resourceVersion", "persistedAt", "persistedByRef"] as const)("rejects a mismatched outer %s", async field => {
    const { pending, ack } = await example(); expect(matchesDraftAck({ ...ack, [field]: "different" }, pending)).toBe(false);
  });
  it.each(["requestKey", "expectedVersion", "payloadDigest", "persistedByRef"] as const)("rejects another same-payload request's %s", async field => {
    const { pending, ack } = await example(); expect(matchesDraftAck({ ...ack, record: { ...ack.record, [field]: "different" } }, pending)).toBe(false);
  });
  it("does not treat uncertain generic success as applied", async () => { const { pending, ack } = await example(); expect(matchesDraftAck({ ...ack, executionCertainty: "uncertain" }, pending)).toBe(false); });
  it("rejects a receipt or outer acknowledgment belonging to another account", async () => {
    const { pending, ack, data } = await example();
    expect(matchesDraftAck({ ...ack, scope: { ...ack.scope, accountIds: ["foreign"] } }, pending)).toBe(false);
    expect(matchesDraftAck({ ...ack, record: { ...ack.record, scope: { ...scope, accountId: "foreign" } } }, pending)).toBe(false);
    expect(await recoverDraft({ ...scope, accountId: "foreign" }, data, pending.requestKey, null)).toBeNull();
  });
  it("does not resolve a pending intent with a different payload or actor", async () => {
    const { pending, data } = await example();
    expect(await recoverDraft(scope, data, pending.requestKey, { ...pending, payload: { ...pending.payload, templateName: "Other draft" } })).toBeNull();
    expect(await recoverDraft(scope, { ...data, actorRef: "agent-reader" }, pending.requestKey, null)).toBeNull();
  });
  it("verifies the payload digest even when the caller has only an opaque reload key", async () => {
    const { pending, data } = await example(); data.requestedSave!.original!.payload = { ...pending.payload, templateName: "Tampered payload" };
    expect(await recoverDraft(scope, data, pending.requestKey, null)).toBeNull();
  });
  it.each(["absent", "unverified"] as const)("keeps %s lookup held even if it contains an original-looking payload", async disposition => {
    const { pending, data } = await example(); data.requestedSave = { ...data.requestedSave!, state: "unknown", disposition, receipt: null };
    expect(await recoverDraft(scope, data, pending.requestKey, pending)).toBeNull();
  });
  it("requires a durable exact rejected receipt to permit a corrected new request", async () => {
    const { pending, data } = await example(); data.requestedSave = { ...data.requestedSave!, state: "notApplied", disposition: "rejected", receipt: null, reasonCode: "VERSION_CONFLICT" };
    expect((await recoverDraft(scope, data, pending.requestKey, pending))?.state).toBe("rejected");
    data.requestedSave.original = null;
    expect(await recoverDraft(scope, data, pending.requestKey, null)).toBeNull();
  });
});
