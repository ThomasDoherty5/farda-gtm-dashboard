// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DB } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store.ts";
import { createRuntimeTestkit, runtimeSyntheticScope, syntheticRuntimeRegistration } from "../jobs/runtime.testkit.ts";
import { runtimeRegistrationSchema, runtimeStepSchema, type RuntimeExecutionContext } from "../jobs/runtimeSchema.ts";
import { VideoEvidenceCollector } from "./collector.ts";
import { createVideoEvidenceExecutor, J20_EXECUTOR_REF } from "./executor.ts";
import { VideoEvidenceLedger } from "./ledger.ts";
import { ScriptedReader, syntheticInput } from "./fixtures.testkit.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const SUBJECT = "synthetic-subject-first-0";
const AT = "2026-11-08T12:30:00.000Z";

/** A J20-family registration shaped for the existing runtime. Built only in this test; nothing registers it in production. */
const j20Registration = () => {
  const base = syntheticRuntimeRegistration();
  return runtimeRegistrationSchema.parse({ ...base, registrationRef: "synthetic-j20", family: "J20", executorRef: J20_EXECUTOR_REF, browserExecutorRef: null, browserBinding: null,
    sourceRef: "source:synthetic-video-review", sourceSchemaVersion: "farda.video-evidence.v1", outputSchemaVersion: "farda.video-evidence.v1",
    definition: { ...base.definition, jobId: "synthetic-j20" } });
};

describe("J20 runtime executor", () => {
  let dir: string, db: DB, store: AgentStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "farda-j20-runtime-"));
    const path = join(dir, "agent.sqlite");
    new AgentStore(path, runtimeSyntheticScope).close();
    db = new DatabaseSync(path);
    store = new AgentStore(path, runtimeSyntheticScope);
  });
  afterEach(() => { store.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  const build = (reader: ScriptedReader) => {
    const ledger = new VideoEvidenceLedger(store, runtimeSyntheticScope, { now: () => Date.parse("2026-11-08T13:00:00Z") });
    const inputs = new Map([[SUBJECT, syntheticInput(3)]]);
    return createVideoEvidenceExecutor({ collector: new VideoEvidenceCollector(ledger, reader, {}), loadInput: async (subject) => inputs.get(subject),
      ownerRef: "owner:synthetic-reviewer", handoffRef: "handoff:synthetic-login" });
  };

  it("validates as a J20 daily registration and is not registered anywhere by this module", () => {
    expect(j20Registration()).toMatchObject({ family: "J20", executorRef: J20_EXECUTOR_REF, definition: { mode: "observe" }, cadence: { kind: "calendar", draft: { cadence: "daily" } } });
    expect(runtimeRegistrationSchema.safeParse({ ...j20Registration(), cadence: { kind: "hourly", timezone: "UTC", minute: 0, startsAt: "2026-11-06T10:00:00Z" } }).success).toBe(false);
  });

  it("runs through the real runtime: checkpoint at the record bound, resume and complete with ledger evidence refs", async () => {
    const reader = new ScriptedReader().observe(1).observe(2).observe(3);
    const f = createRuntimeTestkit(db, { registration: j20Registration(), executor: build(reader) });
    await f.initialize();
    const admitted = await f.fire();
    const done = await f.runtime.work({ runRef: admitted.run.runId, maxItems: 1 }, f.machine);
    expect(done.run.state).toBe("completed");
    expect(reader.calls).toEqual(["read:SYNTH1", "review:SYNTH1", "read:SYNTH2", "review:SYNTH2", "read:SYNTH3", "review:SYNTH3"]);
    expect((await f.runtime.readUsage(done.run.runId)).invocations.directApi).toBe(6);
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM video_evidence_records").get()?.n).toBe(3);
  });

  it("hands login to a person and holds denied permission without bypassing the source", async () => {
    const reader = new ScriptedReader().observe(1);
    reader.meta.set("SYNTH2", { state: "loginRequired", source_ref: "synthetic:login", observed_at: AT, reason_code: "SOURCE_LOGIN_REQUIRED" });
    const f = createRuntimeTestkit(db, { registration: j20Registration(), executor: build(reader) });
    await f.initialize();
    const admitted = await f.fire();
    const held = await f.runtime.work({ runRef: admitted.run.runId, maxItems: 1 }, f.machine);
    expect(held.takeovers).toMatchObject([{ kind: "login", ownerRef: "owner:synthetic-reviewer", handoffRef: "handoff:synthetic-login", resolved: false }]);
    expect(reader.calls).not.toContain("review:SYNTH2");
    expect(reader.calls).not.toContain("read:SYNTH3");
  });

  it("resumes through the real runtime after a resolved login takeover, without re-reading committed posts", async () => {
    const reader = new ScriptedReader().observe(1).observe(3);
    reader.meta.set("SYNTH2", { state: "loginRequired", source_ref: "synthetic:login", observed_at: AT, reason_code: "SOURCE_LOGIN_REQUIRED" });
    const f = createRuntimeTestkit(db, { registration: j20Registration(), executor: build(reader) });
    await f.initialize();
    const run = await f.fire();
    const held = await f.runtime.work({ runRef: run.run.runId }, f.machine);
    expect(held.run.state).toBe("held");
    expect(held.takeovers[0]).toMatchObject({ kind: "login", resolved: false });
    const callsWhileHeld = reader.calls.length;
    await f.runtime.work({ runRef: run.run.runId }, f.machine);
    expect(reader.calls).toHaveLength(callsWhileHeld);
    reader.observe(2);
    const request = { runRef: run.run.runId, itemRef: run.run.items[0]!.itemId, expectedVersion: 1, receiptRef: "receipt:synthetic-login-resolved", requestKey: "synthetic-login-recovery" };
    await f.runtime.resolveTakeover(request, f.machine);
    const done = await f.runtime.work({ runRef: run.run.runId }, f.machine);
    expect(done.run.state).toBe("completed");
    expect(reader.calls).toEqual(["read:SYNTH1", "review:SYNTH1", "read:SYNTH2", "read:SYNTH2", "review:SYNTH2", "read:SYNTH3", "review:SYNTH3"]);
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM video_evidence_records").get()?.n).toBe(3);
    expect(store.database.prepare("SELECT COUNT(*) AS n FROM video_evidence_access_events WHERE json_extract(body,'$.state')='loginRequired'").get()?.n).toBe(1);
  });

  it("maps each collector outcome to a valid runtime step", async () => {
    const context = (cursor: string | null = null): RuntimeExecutionContext => ({
      registration: j20Registration(), window: { windowRef: "w", registrationRef: "synthetic-j20", registrationVersion: 1, intendedAt: AT, windowStart: AT, windowEnd: AT, eventRef: null },
      runRef: "synthetic-run", itemRef: "synthetic-item", subjectRef: SUBJECT, cursor, maxRecords: 10, binding: j20Registration().apiBinding!,
      assertCurrent: () => undefined, invoke: (_channel, operation) => operation(),
    });
    for (const [state, expected] of [["mfaRequired", { state: "takeover", kind: "mfa" }], ["permissionDenied", { state: "held", reasonCode: "SOURCE_PERMISSION_DENIED" }],
      ["unavailable", { state: "retry", reasonCode: "SOURCE_READ_UNAVAILABLE" }]] as const) {
      const reader = new ScriptedReader();
      reader.meta.set("SYNTH1", { state, source_ref: "synthetic:x", observed_at: AT, reason_code: state === "permissionDenied" ? "SOURCE_PERMISSION_DENIED" : state === "unavailable" ? "SOURCE_READ_UNAVAILABLE" : "SOURCE_MFA_REQUIRED" });
      const step = await build(reader).execute(context());
      expect(runtimeStepSchema.parse(step)).toMatchObject(expected);
    }
    // Every evidence ref written in a step is reported, and recordCount counts those records, not source calls.
    const all = new ScriptedReader().observe(1).observe(2).observe(3);
    const ledger = new VideoEvidenceLedger(store, runtimeSyntheticScope);
    const wide = createVideoEvidenceExecutor({ collector: new VideoEvidenceCollector(ledger, all, {}), loadInput: async () => syntheticInput(3),
      ownerRef: "owner:synthetic-reviewer", handoffRef: "handoff:synthetic-login", callsPerStep: 10 });
    expect(await wide.execute(context())).toMatchObject({ state: "completed", recordCount: 3, evidenceRefs: ["instagram:SYNTH1:v1", "instagram:SYNTH2:v1", "instagram:SYNTH3:v1"] });
    const invalid = new ScriptedReader();
    invalid.meta.set("SYNTH1", { state: "observed", observation: { invented: true } });
    expect(await build(invalid).execute(context())).toEqual({ state: "held", reasonCode: "SOURCE_RESPONSE_INVALID" });
    expect(await build(new ScriptedReader()).execute(context("j20c:0000000000000000:1"))).toEqual({ state: "held", reasonCode: "CHECKPOINT_INPUT_MISMATCH" });
  });
});
