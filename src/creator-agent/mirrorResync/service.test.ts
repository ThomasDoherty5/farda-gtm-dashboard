// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckSchedule, ReadCoverage, ReconciliationRow } from "../mirrorReconciliation/contract.ts";
import { MirrorReconciliationRepository } from "../mirrorReconciliation/repository.ts";
import type { RecordRef, SourceRead, SourceRecord } from "./contract.ts";
import { detectRecordDifference } from "./detect.ts";
import { FakeMirrorWriter, FakeSourceReader, type FakeHistoryEntry } from "./fakes.testkit.ts";
import { MirrorResyncRepository } from "./repository.ts";
import { MirrorResyncService } from "./service.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

// All records, scopes, versions and operators are synthetic.
const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
const SECRET = "synthetic-test-secret-0123456789abcdef";
const DAY = "2027-02-11";
const START = Date.parse("2027-02-12T06:00:00Z");
const LEASE = 60_000;
/** The fake writer's default `maxWriteMs` and the service's default settle margin. */
const MAX_WRITE = 10_000, MARGIN = 10_000;
const OPERATOR = "synthetic-operator-1";
const schedule: CheckSchedule = {
  checkId: "synthetic-orders-check", version: 1, timezone: "Europe/London", runAt: "03:00", cutoffLagMinutes: 120, coverage: { lookbackDays: 2 },
  expectedDatasets: [{ scope: "synthetic-store-a", grain: "order", amountField: "net-sales", currencies: ["GBP"], mirroredFields: ["record-status"] }],
};
const record = (key: string, amountMinor: number, status?: SourceRecord["status"]): SourceRecord =>
  ({ key, scope: "synthetic-store-a", grain: "order", period: DAY, currency: "GBP", amountMinor, ...(status ? { status } : {}) });
const asRow = (r: SourceRecord): ReconciliationRow => ({ ...r, read: "complete" });
const read = (side: ReadCoverage["side"]): ReadCoverage =>
  ({ side, scope: "synthetic-store-a", grain: "order", period: DAY, state: "complete", version: `synthetic-${side}-dataset-v1`, readAt: "2027-02-12T05:00:00Z" });
const ref = (recordKey: string): RecordRef =>
  ({ checkId: schedule.checkId, scope: "synthetic-store-a", grain: "order", period: DAY, currency: "GBP", recordKey });
const LOCAL = { synthetic_owner_note: "call back on Tuesday", synthetic_follow_up: true };
const LOCAL_HISTORY: FakeHistoryEntry[] = [
  { version: "synthetic-local-h1", actor: "synthetic-operator-2", changes: { local: { synthetic_owner_note: "first note" } }, writeKey: null },
  { version: "synthetic-local-h2", actor: "synthetic-operator-2", changes: { local: { synthetic_owner_note: "call back on Tuesday" } }, writeKey: null },
];

// Source: order-1 1000 confirmed, order-2 500 confirmed, order-3 700 open. Mirror: order-1 has the wrong amount, order-2 the
// wrong status, order-3 is missing and order-4 exists only in the mirror.
const SOURCE = [record("order-1", 1000, "confirmed"), record("order-2", 500, "confirmed"), record("order-3", 700, "open")];
const MIRROR = [record("order-1", 900, "confirmed"), record("order-2", 500, "pending"), record("order-4", 50, "open")];
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup(path = ":memory:", sched: CheckSchedule = schedule) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId, scope.accountId, scope.environment);
  const clock = { at: START, reads: 0 };
  const now = () => { clock.reads++; return clock.at; };
  const reconciliation = new MirrorReconciliationRepository(db, scope, { secret: SECRET, now });
  reconciliation.saveSchedule(sched);
  const check = reconciliation.recordCheck({ runId: "synthetic-run-1", checkId: schedule.checkId, scheduleVersion: 1, periods: [DAY],
    coverage: [read("source"), read("mirror")], sourceRows: SOURCE.map(asRow), mirrorRows: MIRROR.map(asRow) });
  clock.at += 60_000;
  const source = new FakeSourceReader(() => clock.at), writer = new FakeMirrorWriter(() => clock.at);
  for (const r of SOURCE) source.set(r);
  for (const r of MIRROR) writer.seed({ ...r, local: { ...LOCAL } }, LOCAL_HISTORY);
  const repo = new MirrorResyncRepository(reconciliation);
  const service = new MirrorResyncService(repo, { source, writer, secret: SECRET, leaseMs: LEASE });
  const finding = (recordKey: string, category?: string) =>
    check.raised.find(f => f.recordKey === recordKey && (!category || f.conflict.category === category))!;
  const propose = (key: string, recordKey: string, extra: object = {}) => service.propose({ idempotencyKey: key, checkId: schedule.checkId,
    fingerprint: finding(recordKey).fingerprint, intent: { kind: "operator-resync", operatorRef: OPERATOR, reason: "Synthetic mirror repair." }, ...extra });
  const apply = (key: string, operatorRef = OPERATOR) => service.apply({ idempotencyKey: key, operatorRef, confirm: true });
  return { db, clock, reconciliation, source, writer, repo, service, check, finding, propose, apply };
}
const events = (t: ReturnType<typeof setup>, key: string) => t.repo.auditTrail(t.repo.proposal(key)!.proposalId).map(e => [e.event, e.reasonCode]);

describe("mirror resync", () => {
  it("AC2: detects an amount or mirrored field difference against a successfully read source version, through the comparator", () => {
    const t = setup(), at = t.clock.at, observedAt = new Date(at).toISOString();
    const src = (r: SourceRecord) => ({ record: r, version: "synthetic-source-v1", observedAt });
    const mir = (r: SourceRecord | null) => ({ row: r ? { ...r, local: LOCAL } : null, version: r ? "synthetic-mirror-v1" : null, observedAt });
    const amount = detectRecordDifference(schedule, ref("order-1"), src(SOURCE[0]!), mir(MIRROR[0]!), at, SECRET, "synthetic-detect");
    // The same fingerprint as the stored reconciliation finding: one set of rules, not two.
    expect(amount).toMatchObject({ kind: "differences", set: { amountMinor: 1000 } });
    expect(amount.kind === "differences" && amount.findings.map(f => f.fingerprint)).toEqual([t.finding("order-1").fingerprint]);
    const field = detectRecordDifference(schedule, ref("order-2"), src(SOURCE[1]!), mir(MIRROR[1]!), at, SECRET, "synthetic-detect");
    expect(field).toMatchObject({ kind: "differences", set: { status: "confirmed" } });
    expect(field.kind === "differences" && field.findings.map(f => [f.conflict.category, f.conflict.field])).toEqual([["field", "record-status"]]);
    expect(detectRecordDifference(schedule, ref("order-3"), src(SOURCE[2]!), mir(null), at, SECRET, "synthetic-detect"))
      .toMatchObject({ kind: "differences", set: { amountMinor: 700, status: "open" } });
    expect(detectRecordDifference(schedule, ref("order-1"), src(SOURCE[0]!), mir(SOURCE[0]!), at, SECRET, "synthetic-detect")).toEqual({ kind: "matched" });
    // A source read that finished before the period's cutoff cannot prove a difference.
    expect(detectRecordDifference(schedule, ref("order-1"), { ...src(SOURCE[0]!), observedAt: "2027-02-12T01:00:00.000Z" }, mir(MIRROR[0]!), at, SECRET,
      "synthetic-detect")).toMatchObject({ kind: "incomplete", reason: "RECONCILIATION_INCOMPLETE" });
  });

  it("AC4: needs an explicit operator intent, and proposing reads and writes nothing", async () => {
    const t = setup();
    const base = { idempotencyKey: "synthetic-key-1", checkId: schedule.checkId, fingerprint: t.finding("order-1").fingerprint };
    expect(() => t.service.propose(base)).toThrow("INVALID_RESYNC_PROPOSAL");
    expect(() => t.service.propose({ ...base, intent: { kind: "automatic", operatorRef: OPERATOR, reason: "x" } })).toThrow("INVALID_RESYNC_PROPOSAL");
    const { proposal, duplicate } = t.propose("synthetic-key-1", "order-1");
    expect([proposal.state, duplicate, t.source.reads, t.writer.calls]).toEqual(["proposed", false, 0, { read: 0, write: 0, readBack: 0 }]);
    expect(t.propose("synthetic-key-1", "order-1").duplicate).toBe(true);
    expect(() => t.propose("synthetic-key-1", "order-1", { intent: { kind: "operator-resync", operatorRef: OPERATOR, reason: "Other." } }))
      .toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(() => t.propose("synthetic-key-2", "order-1")).toThrow("RESYNC_ALREADY_PROPOSED");
    // The source does not own a mirror-only record, so it cannot be resynced from the source.
    expect(() => t.propose("synthetic-key-3", "order-4")).toThrow("REPAIR_OWNERSHIP_HELD");
    expect(() => t.service.propose({ ...base, idempotencyKey: "synthetic-key-4", fingerprint: "0".repeat(64),
      intent: { kind: "operator-resync", operatorRef: OPERATOR, reason: "x" } })).toThrow("RESYNC_FINDING_NOT_OPEN");
    await expect(t.service.apply({ idempotencyKey: "synthetic-key-1", operatorRef: OPERATOR })).rejects.toThrow("INVALID_RESYNC_APPLY");
    await expect(t.apply("synthetic-key-1", "synthetic-operator-2")).rejects.toThrow("RESYNC_OPERATOR_MISMATCH");
    expect([t.source.reads, t.writer.calls.write]).toEqual([0, 0]);
    // A proposal that has not written can be withdrawn; it then frees the finding for a new one.
    expect(t.service.cancel({ idempotencyKey: "synthetic-key-1", operatorRef: OPERATOR }).state).toBe("cancelled");
    await expect(t.apply("synthetic-key-1")).resolves.toMatchObject({ replayed: true, proposal: { state: "cancelled" } });
    expect(t.propose("synthetic-key-2", "order-1").proposal.state).toBe("proposed");
  });

  it("AC4: refuses when source access, completeness, identity, freshness or version is uncertain, and writes nothing", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    const granted = (extra: Partial<Extract<SourceRead, { access: "granted" }>>): SourceRead => ({ access: "granted", complete: true,
      record: SOURCE[0]!, version: "synthetic-source-v1", observedAt: new Date(t.clock.at).toISOString(), ...extra });
    const cases: [SourceRead | Error, string][] = [
      [{ access: "denied", reason: "SYNTHETIC_DENIED" }, "SOURCE_ACCESS_UNCERTAIN"],
      [{ access: "unknown", reason: "SYNTHETIC_UNKNOWN" }, "SOURCE_ACCESS_UNCERTAIN"],
      [new Error("synthetic network failure"), "SOURCE_ACCESS_UNCERTAIN"],
      [granted({ complete: false }), "SOURCE_READ_INCOMPLETE"],
      [granted({ version: null }), "SOURCE_VERSION_UNCERTAIN"],
      [granted({ record: null }), "SOURCE_RECORD_ABSENT"],
      [granted({ record: { ...SOURCE[0]!, currency: "EUR" } }), "SOURCE_IDENTITY_MISMATCH"],
      [granted({ observedAt: new Date(t.clock.at - 16 * 60_000).toISOString() }), "SOURCE_STALE"],
      [granted({ observedAt: new Date(t.clock.at + 60_000).toISOString() }), "SOURCE_FRESHNESS_UNCERTAIN"],
    ];
    for (const [result, reason] of cases) {
      t.source.override(result);
      const out = await t.apply("synthetic-key-1");
      expect([out.proposal.state, out.proposal.reasonCode, out.finding?.status, out.finding?.reasonCode]).toEqual(["refused", reason, "open", reason]);
    }
    // A failed mirror read is just as uncertain.
    t.writer.failReads(1);
    expect((await t.apply("synthetic-key-1")).proposal.reasonCode).toBe("MIRROR_READ_FAILED");
    expect(t.writer.calls.write).toBe(0);
    expect(events(t, "synthetic-key-1").filter(([e]) => e === "refused")).toHaveLength(cases.length + 1);
    // Once the source is certain again, the same proposal applies.
    expect((await t.apply("synthetic-key-1")).proposal.state).toBe("verified");
  });

  it("AC4: rechecks the source and mirror versions just before writing, then writes with compare-and-set", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    // The mirror moves between the planning read and the recheck.
    t.writer.onRead = (how, n) => { if (how === "read" && n === 2) t.writer.edit("order-1", { local: { synthetic_owner_note: "moved" } }); };
    let out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.reasonCode, t.writer.calls.write]).toEqual(["conflict", "MIRROR_VERSION_CHANGED", 0]);
    // The source moves between the planning read and the recheck.
    t.writer.onRead = (how, n) => { if (how === "read" && n === 3) t.source.version = "synthetic-source-v2"; };
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.reasonCode, t.writer.calls.write]).toEqual(["conflict", "SOURCE_VERSION_CHANGED", 0]);
    // The mirror moves after the recheck: the compare-and-set write itself fails and nothing lands.
    t.writer.onRead = null;
    t.writer.next("conflict");
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.reasonCode, t.writer.calls.write, t.writer.current("order-1")!.row.amountMinor])
      .toEqual(["conflict", "MIRROR_VERSION_CHANGED", 1, 900]);
    expect(t.writer.writes[0]).toMatchObject({ expectedVersion: "synthetic-mirror-v2", set: { amountMinor: 1000 } });
    // Each retry re-plans from fresh reads against the mirror's new version.
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.attempts, t.writer.writes[1]!.expectedVersion]).toEqual(["verified", 4, "synthetic-mirror-v3"]);
  });

  it("AC5: writes only mirrored fields, keeps local fields and their history, and audits every attempt", async () => {
    const t = setup();
    const { proposal } = t.propose("synthetic-key-1", "order-1");
    const out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.replayed]).toEqual(["verified", false]);
    expect(t.writer.writes).toEqual([{ ref: ref("order-1"), expectedVersion: "synthetic-mirror-v1", set: { amountMinor: 1000 },
      writeKey: `${proposal.proposalId}.a1`, deadline: new Date(t.clock.at + MAX_WRITE).toISOString() }]);
    expect(t.writer.signals[0]).toBeInstanceOf(AbortSignal);
    const stored = t.writer.current("order-1")!;
    expect(stored.row).toEqual({ ...record("order-1", 1000, "confirmed"), local: LOCAL });
    expect(stored.history).toEqual([...LOCAL_HISTORY, { version: "synthetic-mirror-v2", actor: "resync", changes: { amountMinor: 1000 },
      writeKey: `${proposal.proposalId}.a1` }]);
    const trail = t.repo.auditTrail(proposal.proposalId);
    expect(trail.map(e => [e.attempt, e.event, e.state, e.reasonCode])).toEqual([[0, "proposed", "proposed", null], [1, "planned", "proposed", null],
      [1, "applying", "applying", null], [1, "verified", "verified", "RESYNC_VERIFIED"]]);
    expect(trail[1]!.detail).toMatchObject({ sourceVersion: "synthetic-source-v1", expectedVersion: "synthetic-mirror-v1", matchesFinding: true,
      mirrorBefore: { amountMinor: 900, status: "confirmed" }, set: { amountMinor: 1000 } });
    expect(trail[3]!.detail).toMatchObject({ versionAfter: "synthetic-mirror-v2", fieldsAfter: { amountMinor: 1000, status: "confirmed" } });
  });

  it("AC5: leaves the finding open when a local field changed around the write", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    t.writer.onRead = how => { if (how === "readBack") t.writer.edit("order-1", { local: { synthetic_follow_up: false } }, "synthetic-operator-2"); };
    const out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.reasonCode, out.finding?.status]).toEqual(["mismatch", "LOCAL_FIELDS_CHANGED", "open"]);
    expect(t.writer.current("order-1")!.row.local).toEqual({ ...LOCAL, synthetic_follow_up: false });
  });

  it("AC7: replaying a key after a final result returns it without reading or writing", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    const first = await t.apply("synthetic-key-1");
    const counts = { source: t.source.reads, writer: { ...t.writer.calls }, audit: events(t, "synthetic-key-1").length };
    const replay = await t.apply("synthetic-key-1");
    expect(replay).toEqual({ ...first, replayed: true });
    expect({ source: t.source.reads, writer: t.writer.calls, audit: events(t, "synthetic-key-1").length }).toEqual(counts);
    await expect(t.apply("synthetic-key-1", "synthetic-operator-2")).rejects.toThrow("RESYNC_OPERATOR_MISMATCH");
  });

  it("AC7: a timeout stays uncertain until its deadline has passed, and only an explicit apply then tries again", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    t.writer.next("timeout");
    const deadline = t.clock.at + MAX_WRITE;
    let out = await t.apply("synthetic-key-1");
    // The row is unchanged, but the write could still land until its deadline plus the margin.
    expect([out.proposal.state, out.proposal.reasonCode, out.finding?.status, t.writer.calls]).toEqual(["uncertain", "WRITE_OUTCOME_PENDING", "open",
      { read: 2, write: 1, readBack: 1 }]);
    t.clock.at = deadline + MARGIN - 1;
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.reasonCode, t.writer.calls]).toEqual(["uncertain", "WRITE_OUTCOME_PENDING", { read: 2, write: 1, readBack: 2 }]);
    t.clock.at = deadline + MARGIN;
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.reasonCode, t.writer.calls]).toEqual(["not_applied", "WRITE_NOT_APPLIED", { read: 2, write: 1, readBack: 3 }]);
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.proposal.attempts, t.writer.writes.map(w => w.writeKey.split(".").pop())]).toEqual(["verified", 2, ["a1", "a2"]]);
    expect(t.repo.auditTrail(out.proposal.proposalId).map(e => [e.attempt, e.event, e.reasonCode])).toEqual([[0, "proposed", null],
      [1, "planned", null], [1, "applying", null], [1, "uncertain", "WRITE_OUTCOME_PENDING"], [1, "uncertain", "WRITE_OUTCOME_PENDING"],
      [1, "not_applied", "WRITE_NOT_APPLIED"], [2, "planned", "WRITE_NOT_APPLIED"], [2, "applying", null], [2, "verified", "RESYNC_VERIFIED"]]);
  });

  it("AC7: a lost acknowledgement is settled from the read-back, never by writing again", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    t.writer.next("lostAck");
    let out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, t.writer.calls.write]).toEqual(["verified", 1]);

    t.propose("synthetic-key-2", "order-2");
    t.writer.next("lostAck").failReadBacks(1);
    out = await t.apply("synthetic-key-2");
    expect([out.proposal.state, out.proposal.reasonCode, out.finding?.status, t.writer.calls.write]).toEqual(["uncertain", "READBACK_FAILED", "open", 2]);
    expect(() => t.service.cancel({ idempotencyKey: "synthetic-key-2", operatorRef: OPERATOR })).toThrow("RESYNC_IN_PROGRESS");
    const reads = { source: t.source.reads, mirror: t.writer.calls.read };
    out = await t.apply("synthetic-key-2");
    // Reconciliation reads the mirror back once and reads nothing else.
    expect([out.proposal.state, out.proposal.attempts, t.writer.calls.write, t.source.reads, t.writer.calls.read])
      .toEqual(["verified", 1, 2, reads.source, reads.mirror]);
    expect(t.writer.current("order-2")!.row.status).toBe("confirmed");
    expect(events(t, "synthetic-key-2").map(([e]) => e)).toEqual(["proposed", "planned", "applying", "uncertain", "verified"]);
  });

  it("AC7: holds the proposal while an attempt is in flight and reads back once its lease expires", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    const write = t.writer.write.bind(t.writer);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    // The write lands at once but its acknowledgement is held back, as with a stalled worker.
    t.writer.write = async request => { const result = await write(request); await held; return result; };
    const first = t.apply("synthetic-key-1");
    await vi.waitFor(() => expect(t.writer.calls.write).toBe(1));
    await expect(t.apply("synthetic-key-1")).rejects.toThrow("RESYNC_IN_PROGRESS");
    t.clock.at += LEASE + 1;
    const second = await t.apply("synthetic-key-1");
    expect([second.proposal.state, t.writer.calls.write]).toEqual(["verified", 1]);
    release();
    await expect(first).rejects.toThrow("RESYNC_LEASE_LOST");
    expect(t.repo.proposal("synthetic-key-1")!.state).toBe("verified");
    const trail = t.repo.auditTrail(t.repo.proposal("synthetic-key-1")!.proposalId);
    expect(trail.map(e => [e.attempt, e.event, e.state])).toEqual([[0, "proposed", "proposed"], [1, "planned", "proposed"], [1, "applying", "applying"],
      [1, "verified", "verified"], [1, "late_result", "verified"]]);
    expect(trail[4]!.detail).toMatchObject({ intended: { event: "verified", state: "verified", reasonCode: "RESYNC_VERIFIED" } });
  });

  it("AC7: refuses a lease that cannot cover the writer's longest write plus the margin", () => {
    const t = setup();
    const make = (maxWriteMs: number) => () => new MirrorResyncService(t.repo, { source: t.source, writer: new FakeMirrorWriter(() => t.clock.at, maxWriteMs),
      secret: SECRET, leaseMs: LEASE });
    expect(make(LEASE - MARGIN)).toThrow("RESYNC_LEASE_SHORTER_THAN_WRITE");
    expect(make(0)).toThrow("INVALID_RESYNC_OPTIONS");
    expect(make(LEASE - MARGIN - 1)).not.toThrow();
  });

  it("AC7: a write stalled past the lease is not settled as not applied, and is never written again, before its deadline", async () => {
    const t = setup();
    t.propose("synthetic-key-1", "order-1");
    const claimedAt = t.clock.at, write = t.writer.write.bind(t.writer);
    let release!: () => void, invocations = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    // The first write stalls before reaching the provider and lands only when released; later writes go straight through.
    t.writer.write = async request => { if (++invocations === 1) await held; return write(request); };
    // The planning reads are slow, so the write starts late in the lease and its deadline falls after the lease expires.
    t.writer.onRead = (how, n) => { if (how === "read" && n === 2) t.clock.at = claimedAt + LEASE - 5_000; };
    const first = t.apply("synthetic-key-1");
    await vi.waitFor(() => expect(invocations).toBe(1));
    t.writer.onRead = null;
    const deadline = claimedAt + LEASE - 5_000 + MAX_WRITE;
    expect(t.repo.proposal("synthetic-key-1")!.plan!.writeDeadline).toBe(new Date(deadline).toISOString());

    for (const at of [claimedAt + LEASE + 1, deadline + 1, deadline + MARGIN - 1]) {
      t.clock.at = at;
      const out = await t.apply("synthetic-key-1");
      expect([out.proposal.state, out.proposal.reasonCode, out.proposal.attempts, invocations]).toEqual(["uncertain", "WRITE_OUTCOME_PENDING", 1, 1]);
    }
    // Only once the deadline plus the margin has passed does an unchanged row prove the write did not land.
    t.clock.at = deadline + MARGIN;
    expect((await t.apply("synthetic-key-1")).proposal.state).toBe("not_applied");
    const second = await t.apply("synthetic-key-1");
    expect([second.proposal.state, second.proposal.attempts, invocations]).toEqual(["verified", 2, 2]);
    // The stalled first write finally arrives. The provider's atomic compare-and-set refuses it, and its late result is
    // recorded under attempt 1, not the proposal's current attempt.
    release();
    await expect(first).rejects.toThrow("RESYNC_LEASE_LOST");
    expect(t.writer.current("order-1")!.history.filter(h => h.actor === "resync")).toHaveLength(1);
    const trail = t.repo.auditTrail(second.proposal.proposalId), late = trail.at(-1)!;
    // One late result: the refused write is not then read back as if it were uncertain.
    expect(trail.filter(e => e.event === "late_result")).toHaveLength(1);
    expect([late.attempt, late.event, late.state]).toEqual([1, "late_result", "verified"]);
    expect(late.detail).toMatchObject({ intended: { state: "conflict", reasonCode: "MIRROR_VERSION_CHANGED" } });
    expect(t.repo.proposal("synthetic-key-1")).toMatchObject({ state: "verified", attempts: 2 });
  });

  it("writes only the mirrored fields the dataset declares", async () => {
    const undeclared: CheckSchedule = { ...schedule, expectedDatasets: schedule.expectedDatasets.map(({ mirroredFields: _, ...d }) => d) };
    const t = setup(":memory:", undeclared);
    // Without the declaration, order-2's status difference is not a finding, and creating order-3 sets only its amount.
    expect(t.check.raised.map(f => [f.recordKey, f.conflict.category]).sort()).toEqual([["order-1", "amount"], ["order-3", "missing_mirror"],
      ["order-4", "missing_source"]]);
    t.propose("synthetic-key-3", "order-3");
    const out = await t.apply("synthetic-key-3");
    expect([out.proposal.state, t.writer.writes.map(w => w.set)]).toEqual(["verified", [{ amountMinor: 700 }]]);
    expect(t.writer.current("order-3")!.row.status).toBeUndefined();
  });

  it("AC8: closes the finding only when the read-back matches, and leaves a partial apply open with its reason", async () => {
    const t = setup();
    t.propose("synthetic-key-3", "order-3");
    t.writer.next("partial");
    let out = await t.apply("synthetic-key-3");
    expect([out.proposal.state, out.proposal.reasonCode, out.finding?.status, out.finding?.reasonCode])
      .toEqual(["mismatch", "PARTIAL_APPLY", "open", "PARTIAL_APPLY"]);
    expect(t.writer.writes[0]).toMatchObject({ expectedVersion: null, set: { amountMinor: 700, status: "open" } });
    expect(t.writer.current("order-3")!.row).toMatchObject({ amountMinor: 700, local: {} });
    expect(t.writer.current("order-3")!.row.status).toBeUndefined();
    // A mismatch is final; the replay returns it unchanged.
    expect((await t.apply("synthetic-key-3")).replayed).toBe(true);

    t.propose("synthetic-key-1", "order-1");
    out = await t.apply("synthetic-key-1");
    expect([out.proposal.state, out.finding?.status, out.finding?.reasonCode]).toEqual(["verified", "closed", "RESYNC_VERIFIED"]);

    // A mirror already corrected elsewhere closes without a write.
    t.propose("synthetic-key-2", "order-2");
    t.writer.edit("order-2", { status: "confirmed" });
    const writes = t.writer.calls.write;
    out = await t.apply("synthetic-key-2");
    expect([out.proposal.state, out.finding?.status, t.writer.calls.write]).toEqual(["already_matched", "closed", writes]);

    // The reconciliation check clears its own copies on its next complete run.
    const mirrorNow = [...t.writer.rows.values()].map(s => asRow({ key: s.row.key, scope: s.row.scope, grain: s.row.grain, period: s.row.period,
      currency: s.row.currency, amountMinor: s.row.amountMinor, ...(s.row.status ? { status: s.row.status } : {}) }));
    t.clock.at += 60_000;
    const rerun = t.reconciliation.recordCheck({ runId: "synthetic-run-2", checkId: schedule.checkId, scheduleVersion: 1, periods: [DAY],
      coverage: [{ ...read("source"), readAt: new Date(t.clock.at).toISOString() }, { ...read("mirror"), readAt: new Date(t.clock.at).toISOString() }],
      sourceRows: SOURCE.map(asRow), mirrorRows: mirrorNow });
    // order-3's missing-mirror finding clears too; its partial row now shows as a status difference instead.
    expect(rerun.cleared.sort()).toEqual(["order-1", "order-2", "order-3"].map(k => t.finding(k).fingerprint).sort());
    expect(rerun.raised.map(f => [f.recordKey, f.conflict.category])).toEqual([["order-3", "field"]]);
  });

  it("reads the clock only inside the write lock and holds no transaction across a provider call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-resync-")); dirs.push(dir);
    const path = join(dir, "agent.db"), t = setup(path);
    const other = new DatabaseSync(path);
    other.exec("BEGIN IMMEDIATE");
    const before = t.clock.reads;
    expect(() => t.propose("synthetic-key-1", "order-1")).toThrow();
    expect(t.clock.reads).toBe(before);
    other.exec("ROLLBACK"); other.close();
    t.propose("synthetic-key-1", "order-1");
    const inTransaction: boolean[] = [];
    t.writer.onRead = () => { inTransaction.push(t.db.isTransaction); };
    const write = t.writer.write.bind(t.writer);
    t.writer.write = request => { inTransaction.push(t.db.isTransaction); return write(request); };
    const sourceRead = t.source.read.bind(t.source);
    t.source.read = r => { inTransaction.push(t.db.isTransaction); return sourceRead(r); };
    expect((await t.apply("synthetic-key-1")).proposal.state).toBe("verified");
    expect(inTransaction).toEqual([false, false, false, false, false, false]);
    expect(t.repo.proposal("synthetic-key-1")).toMatchObject({ state: "verified" });
  });
});
