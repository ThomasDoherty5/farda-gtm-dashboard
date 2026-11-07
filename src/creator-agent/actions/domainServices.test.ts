// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import { createActionDomainServices } from "./domainServices.ts";
import { ActionServiceError, exportPayloadSchema, readinessPayloadSchema } from "./contract.ts";
import { actionDomainFixture, actionTestScope as scope, actionTestSecret as secret, exportFixturePayload as payload, founderFixture as actor } from "./fixtures.testkit.ts";

const stores: AgentStore[] = [];
function setup(path = ":memory:", fixture = actionDomainFixture()) {
  const store = new AgentStore(path, scope); stores.push(store);
  const service = createActionDomainServices({ db: store.database, scope, secret, ...fixture });
  return { ...fixture, store, service };
}
const readinessPayload = { verdict: "go" as const, launchDate: "2026-11-20", rationale: "Fixture review of exact source gates", evidenceRefs: ["product-evidence"] };
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

describe("authorized full snapshot exports", () => {
  it("writes one private whole-snapshot CSV with exact known zeros, aliases, receipt and original-key replay", async () => {
    const w = setup(), receipt = await w.service.exportLedger(payload, "ledger-v1", actor, "export-key");
    const exported = await w.service.downloadExport(receipt.artifactRef, actor);
    expect(receipt).toMatchObject({ rowCount: 110, confersRelease: false });
    expect(w.state.pageReads).toBe(3); expect(exported.body.split("\r\n")).toHaveLength(112);
    expect(exported.body).toContain(",USD,0,0,20,earned,"); expect(exported.body).not.toContain("native-entitlement");
    expect(exported.body).not.toContain("native-order");
    expect(await w.service.exportLedger(payload, "ledger-v1", actor, "export-key")).toEqual(receipt);
    expect(w.state.pageReads).toBe(3);
    await expect(w.service.exportLedger({ ...payload, filters: { ...payload.filters, state: "earned" } }, "ledger-v1", actor, "export-key")).rejects.toMatchObject({ code: "MANIFEST_CHANGED", executionCertainty: "applied" });
  });
  it("atomically records the actual native job and refuses source withdrawal during the final actor await", async () => {
    const w = setup(), receipt = await w.service.exportLedger(payload, "ledger-v1", actor, "native-job");
    const job = w.store.database.prepare("SELECT state,result FROM job_items").get();
    expect(job?.state).toBe("completed"); expect(JSON.parse(String(job?.result))).toMatchObject({ artifactRef: receipt.artifactRef, sourceEffect: "none" });
    expect(w.store.database.prepare("SELECT run_id FROM job_runs").get()?.run_id).toBe(receipt.runRef);
    const race = actionDomainFixture(), original = race.authorize; let calls = 0;
    race.authorize = async ref => { const proof = await original(ref); if (++calls === 2) race.state.denySource = true; return proof; };
    const r = setup(":memory:", race);
    await expect(r.service.exportLedger(payload, "ledger-v1", actor, "source-withdrawal")).rejects.toMatchObject({ status: 403, executionCertainty: "notApplied" });
    expect(r.store.database.prepare("SELECT count(*) n FROM action_export_artifacts").get()?.n).toBe(0);
    expect(r.store.database.prepare("SELECT state FROM job_items").get()?.state).not.toBe("completed");
  });
  it("supports a complete known-empty snapshot but never unknown/truncated scope", async () => {
    const w = setup(":memory:", actionDomainFixture(0)); expect((await w.service.exportLedger(payload, "ledger-v1", actor, "empty")).rowCount).toBe(0);
    const short = setup(); short.ledger.page = async () => ({ snapshotRef: short.snapshot.snapshotRef, version: "ledger-v1", offset: 0, total: 110, rows: short.rows.slice(0, 1), nextCursor: null });
    await expect(short.service.exportLedger(payload, "ledger-v1", actor, "short")).rejects.toMatchObject({ code: "EXPORT_INCOMPLETE", executionCertainty: "notApplied" });
    expect(short.store.database.prepare("SELECT count(*) n FROM action_export_artifacts").get()?.n).toBe(0);
  });
  it.each(["privateEmail", "bankAccount", "providerToken"])("rejects source column %s instead of silently exporting private data", async field => {
    const w = setup(); const original = w.ledger.page; w.ledger.page = async (s, c) => { const page = await original(s, c) as { rows: object[] }; return { ...page, rows: page.rows.map(r => ({ ...r, [field]: "private" })) }; };
    await expect(w.service.exportLedger(payload, "ledger-v1", actor, "private")).rejects.toMatchObject({ code: "EXPORT_PAGE_INVALID" });
  });
  it("blocks wrong currency, duplicate identities and changed final snapshot", async () => {
    for (const kind of ["currency", "duplicate", "changed"] as const) {
      const w = setup(); if (kind === "currency") w.rows[0]!.currency = "CAD";
      if (kind === "duplicate") w.rows[1]!.entitlementRef = w.rows[0]!.entitlementRef;
      if (kind === "changed") w.ledger.current = async () => ({ ...w.snapshot, permissionVersion: "revoked" });
      await expect(w.service.exportLedger(payload, "ledger-v1", actor, kind)).rejects.toBeInstanceOf(ActionServiceError);
      expect(w.store.database.prepare("SELECT count(*) n FROM action_export_artifacts").get()?.n).toBe(0);
    }
  });
  it("concurrent replay cannot reject the first worker's claim or create a second artifact", async () => {
    const w = setup(); let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const page = w.ledger.page;
    w.ledger.page = async (s, c) => { await gate; return page(s, c); };
    const first = w.service.exportLedger(payload, "ledger-v1", actor, "concurrent");
    await new Promise(r => setTimeout(r, 5));
    await expect(w.service.exportLedger(payload, "ledger-v1", actor, "concurrent")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    expect(w.store.database.prepare("SELECT state FROM action_domain_requests").get()?.state).toBe("pending"); release();
    expect((await first).rowCount).toBe(110); expect(w.store.database.prepare("SELECT count(*) n FROM action_export_artifacts").get()?.n).toBe(1);
  });
  it("refuses role/source loss and expired downloads without erasing generated proof", async () => {
    const w = setup(), receipt = await w.service.exportLedger(payload, "ledger-v1", actor, "access");
    w.state.denySource = true; await expect(w.service.downloadExport(receipt.artifactRef, actor)).rejects.toMatchObject({ status: 403 });
    w.state.denySource = false; w.state.roles = ["reviewer"]; await expect(w.service.downloadExport(receipt.artifactRef, actor)).rejects.toMatchObject({ status: 403 });
    w.state.roles = ["founder"]; w.tick(3_600_001); await expect(w.service.downloadExport(receipt.artifactRef, actor)).rejects.toMatchObject({ code: "EXPORT_EXPIRED" });
    expect(w.store.database.prepare("SELECT state FROM action_domain_requests").get()?.state).toBe("applied");
  });
  it("can retry proven local generation failure with the same key; denies foreign snapshot and forged fields", async () => {
    const w = setup(), original = w.ledger.page; w.ledger.page = async () => { throw new Error("Synthetic read failure"); };
    await expect(w.service.exportLedger(payload, "ledger-v1", actor, "retry")).rejects.toMatchObject({ executionCertainty: "notApplied" });
    w.ledger.page = original; expect((await w.service.exportLedger(payload, "ledger-v1", actor, "retry")).rowCount).toBe(110);
    expect(exportPayloadSchema.safeParse({ ...payload, columns: ["customerEmail"] }).success).toBe(false);
    const foreign = setup(); foreign.snapshot.scope = { ...scope, accountId: "foreign" };
    await expect(foreign.service.exportLedger(payload, "ledger-v1", actor, "foreign")).rejects.toMatchObject({ status: 403 });
  });
});

describe("final named authority fences", () => {
  it("rejects founder withdrawal during the final readiness read before the source writer is called", async () => {
    const w = setup(), read = w.readiness.read; let calls = 0;
    w.readiness.read = async (...args) => { const source = await read(...args); if (++calls === 2) w.state.denyActor = true; return source; };
    await expect(w.service.recordReadiness(w.source.targetRef, readinessPayload, w.source.version, actor, "actor-final-read")).rejects.toMatchObject({ status: 403, executionCertainty: "notApplied" });
    expect(w.state.writes).toBe(0); expect(w.store.database.prepare("SELECT count(*) n FROM action_domain_requests").get()?.n).toBe(0);
  });
  it("retains the actual receipt but clears the response when source permission is withdrawn during write readback", async () => {
    const w = setup(), lookup = w.readiness.lookup;
    w.readiness.lookup = async intent => { const result = await lookup(intent); w.state.denySource = true; return result; };
    await expect(w.service.recordReadiness(w.source.targetRef, readinessPayload, w.source.version, actor, "post-write-source-loss")).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    expect(w.state.writes).toBe(1); expect(w.store.database.prepare("SELECT state FROM action_domain_requests").get()?.state).toBe("applied");
    expect(w.store.database.prepare("SELECT receipt FROM action_domain_requests").get()?.receipt).toContain("native-notion-receipt");
  });
  it("does not expose an applied replay after founder or source authority disappears in the final read", async () => {
    for (const loss of ["actor", "source"] as const) {
      const w = setup(), version = w.source.version, receipt = await w.service.recordReadiness(w.source.targetRef, readinessPayload, version, actor, "actor-replay");
      const before = w.store.database.prepare("SELECT receipt FROM action_domain_requests").get()?.receipt, read = w.readiness.read;
      w.readiness.read = async (...args) => { const source = await read(...args); if (loss === "actor") w.state.denyActor = true; else w.state.denySource = true; return source; };
      await expect(w.service.recordReadiness(w.source.targetRef, readinessPayload, version, actor, "actor-replay")).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
      expect(w.state.writes).toBe(1); expect(w.store.database.prepare("SELECT receipt FROM action_domain_requests").get()?.receipt).toBe(before); expect(receipt.confersRelease).toBe(false);
    }
  });
});

describe("public readiness reference boundary", () => {
  it("resolves only actor-scoped opaque view references and preserves original source receipt across refresh", async () => {
    const w = setup(), view = await w.service.readReadiness(w.source.targetRef, actor);
    const json = JSON.stringify(view); expect(json).not.toContain(w.source.targetRef); expect(json).not.toContain("product-evidence"); expect(json).not.toContain(w.source.policyVersion);
    const input = { ...readinessPayload, evidenceRefs: [view.evidenceRefs[0]!] };
    const receipt = await w.service.recordReadinessFromView(view.targetRef, input, view.version, actor, "public-record");
    expect(receipt.confersRelease).toBe(false); expect(w.state.writes).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain("native-notion"); expect(JSON.stringify(receipt)).not.toContain("product-evidence");
    const current = await w.service.readReadiness(w.source.targetRef, actor); expect(current.version).not.toBe(view.version);
    expect(await w.service.recordReadinessFromView(view.targetRef, input, view.version, actor, "public-record")).toEqual(receipt);
    expect(w.state.writes).toBe(1);
    await expect(w.service.recordReadinessFromView(view.targetRef, { ...input, evidenceRefs: ["product-evidence"] }, view.version, actor, "forged-native")).rejects.toMatchObject({ code: "READINESS_BASIS_INVALID" });
    await expect(w.service.recordReadinessFromView(view.targetRef, input, view.version, { principalRef: "other-founder" }, "foreign")).rejects.toMatchObject({ status: 403 });
  });
});

describe("J18 readiness recording is not release authority", () => {
  it("requires exact Notion ACK and readback; receipt replay is historical and never writes twice", async () => {
    const w = setup(), receipt = await w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "record");
    expect(receipt).toMatchObject({ provider: "notion", confersRelease: false, payload: { verdict: "go" } });
    expect(receipt.receiptRef).not.toContain("native-notion");
    expect(await w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "record")).toEqual(receipt);
    expect(w.state.writes).toBe(1);
    await expect(w.service.recordReadiness("fixture-launch", { ...readinessPayload, verdict: "hold" }, "readiness-v1", actor, "record")).rejects.toMatchObject({ code: "MANIFEST_CHANGED", executionCertainty: "applied" });
  });
  it.each(["unset", "unapproved", "failed", "unknown", "phase"])("blocks Go when %s; Hold remains a readiness record only", async reason => {
    const w = setup(); if (reason === "unset") { w.source.launchDate = null; w.source.launchDateApproved = false; }
    if (reason === "unapproved") w.source.launchDateApproved = false;
    if (reason === "failed") w.source.gates[0]!.state = "fail";
    if (reason === "unknown") w.source.gates[0]!.state = "unknown";
    if (reason === "phase") w.source.phaseAllowed = false;
    await expect(w.service.recordReadiness("fixture-launch", { ...readinessPayload, launchDate: w.source.launchDate }, "readiness-v1", actor, "go")).rejects.toBeInstanceOf(ActionServiceError);
    expect(w.state.writes).toBe(0);
    if (reason !== "phase") expect((await w.service.recordReadiness("fixture-launch", { ...readinessPayload, verdict: "hold", launchDate: w.source.launchDate }, "readiness-v1", actor, "hold")).confersRelease).toBe(false);
  });
  it("rejects forged role/release/gates and non-founders without source writes", async () => {
    for (const field of ["role", "confersRelease", "gates", "enabled", "recipients"]) expect(readinessPayloadSchema.safeParse({ ...readinessPayload, [field]: true }).success).toBe(false);
    const w = setup(); w.state.roles = ["reviewer"];
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "denied")).rejects.toMatchObject({ status: 403 }); expect(w.state.writes).toBe(0);
  });
  it("fences unknown write across keys and recovers original exact receipt after ACK loss", async () => {
    const w = setup(); w.state.loseWriteAck = true;
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "lost")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, w.source.version, actor, "new")).rejects.toMatchObject({ code: "READINESS_PRIOR_OUTCOME_UNCERTAIN" });
    const receipt = await w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "lost"); expect(receipt.confersRelease).toBe(false); expect(w.state.writes).toBe(1);
  });
  it("malformed/absent source receipts never release the original uncertain target", async () => {
    const w = setup(); w.state.writeMalformed = true;
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "bad")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "new")).rejects.toMatchObject({ code: "READINESS_PRIOR_OUTCOME_UNCERTAIN" });
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "bad")).rejects.toMatchObject({ executionCertainty: "uncertain" }); expect(w.state.writes).toBe(1);
  });
  it("only exact positive terminal nonapplication releases a failed attempt", async () => {
    const w = setup(); w.state.writeMalformed = true; w.state.terminalNotApplied = true;
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "terminal")).rejects.toMatchObject({ code: "READINESS_NOT_APPLIED", executionCertainty: "notApplied" });
    w.state.writeMalformed = false; expect((await w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "fresh")).confersRelease).toBe(false);
  });
  it("current source denial after an unknown attempt preserves certainty and never dispatches again", async () => {
    const w = setup(); w.state.loseWriteAck = true;
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "loss")).rejects.toMatchObject({ executionCertainty: "uncertain" });
    w.state.denySource = true; await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "loss")).rejects.toMatchObject({ status: 403, executionCertainty: "uncertain" }); expect(w.state.writes).toBe(1);
  });
  it("source withdrawal during the final await and equivalent-instant source conflicts block a write", async () => {
    const w = setup(), read = w.readiness.read; let n = 0;
    w.readiness.read = async (...args) => { n++; if (n === 2) { w.source.phaseAllowed = false; w.source.version = "readiness-v2"; w.source.observedAt = "2026-11-06T21:00:00.000-08:00"; } return read(...args); };
    await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "race")).rejects.toMatchObject({ code: "SOURCE_REGRESSED" }); expect(w.state.writes).toBe(0);
  });
  it("SQLite reopen keeps an unknown request fenced and recovers its original source receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "action-readiness-")), path = join(dir, "source.sqlite");
    try {
      const f = actionDomainFixture(), w = setup(path, f); w.state.loseWriteAck = true;
      await expect(w.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "restart")).rejects.toMatchObject({ executionCertainty: "uncertain" });
      stores.splice(stores.indexOf(w.store), 1); w.store.close(); const reopened = setup(path, f);
      expect((await reopened.service.recordReadiness("fixture-launch", readinessPayload, "readiness-v1", actor, "restart")).confersRelease).toBe(false); expect(f.state.writes).toBe(1);
      stores.splice(stores.indexOf(reopened.store), 1); reopened.store.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
