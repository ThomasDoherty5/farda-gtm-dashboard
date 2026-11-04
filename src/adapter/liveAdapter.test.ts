import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveAdapter, redact } from "./liveAdapter";
import { createDemoAdapter } from "./demoAdapter";
import { selectAdapter } from "./selectAdapter";
import { AdapterError } from "./errors";
import { SCHEMA_VERSION, type ActionRequest, type ReadRequest, type SaveResourceRequest } from "./contract";
import { pendingTransport, TransportFailure, type Transport, type TransportRequest } from "./transport";
import { demoBackedTransport, duplicatingTransport, failingTransport, flakyTransport, hangingTransport, lostAnswerTransport, rawTransport } from "./transportTestKit";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "sandbox" as const };
let n = 0;
const read = (over: Partial<ReadRequest<unknown>> = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "overviewSummary", requestedScope: scope, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: `r-${++n}`, ...over,
});
const act = (over: Partial<ActionRequest<unknown>> = {}): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "decideApproval", requestedScope: scope, actionKind: "decideApproval", entityRefs: [], expectedVersion: "v1", approvalRef: "demo-approval-exact",
  manifestRef: null, idempotencyKey: `k-${++n}`, payload: { decision: "approved" }, requestId: `a-${n}`, ...over,
});
const dispatch = (over: Partial<ActionRequest<unknown>> = {}) => act({ operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", payload: {}, ...over });
const save = (over: Partial<SaveResourceRequest<unknown>> = {}): SaveResourceRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: scope, resourceKind: "evidenceDraft", resourceRef: "demo-evidence-1", expectedVersion: "v1", idempotencyKey: `s-${++n}`, requestId: `s-${n}`,
  payload: { mediaUrl: null, checkoutRoute: "tiktok-shop", observations: [] }, ...over,
});

const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const quick = { retryDelayMs: 0 };
const live = (transport: Transport, extra = {}) => createLiveAdapter("sandbox", { transport, ...quick, ...extra });
const served = (log: TransportRequest[] = []) => demoBackedTransport(createDemoAdapter(), "sandbox", log);
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);

describe("default transport", () => {
  it("answers INTEGRATION_PENDING with an honest message and sends nothing", async () => {
    const adapter = createLiveAdapter("sandbox");
    const r = await fail(adapter.readView(read()));
    expect(r.body.code).toBe("INTEGRATION_PENDING");
    expect(r.message).toMatch(/not connected yet/);
    const a = await fail(adapter.submitAction(act()));
    expect(a.body).toMatchObject({ code: "INTEGRATION_PENDING", executionCertainty: "notApplied" });
    expect(a.message).toMatch(/Nothing was sent/);
    const s = await fail(adapter.saveResource(save()));
    expect(s.body).toMatchObject({ code: "INTEGRATION_PENDING", executionCertainty: "notApplied" });
    expect(s.message).toMatch(/Nothing was saved/);
  });
  it("is what selectAdapter builds when the host supplies no transport, with or without the base URL", async () => {
    for (const env of [{ VITE_FARDA_ADAPTER: "sandbox" }, { VITE_FARDA_ADAPTER: "production", VITE_FARDA_ADAPTER_BASE_URL: "https://example.invalid" }]) {
      const adapter = selectAdapter(env);
      expect(adapter.kind).toBe("live");
      expect((await fail(adapter.readView(read({ requestedScope: { ...scope, environment: env.VITE_FARDA_ADAPTER as "sandbox" } })))).body.code).toBe("INTEGRATION_PENDING");
    }
  });
  it("hands the reserved base URL, uninterpreted, to the host's transport factory", () => {
    const seen: unknown[] = [];
    selectAdapter({ VITE_FARDA_ADAPTER: "sandbox", VITE_FARDA_ADAPTER_BASE_URL: " https://host.example.invalid " }, "", { createTransport: (c) => (seen.push(c), pendingTransport) });
    selectAdapter({ VITE_FARDA_ADAPTER: "production" }, "", { createTransport: (c) => (seen.push(c), pendingTransport) });
    expect(seen).toEqual([{ environment: "sandbox", baseUrl: "https://host.example.invalid" }, { environment: "production", baseUrl: null }]);
  });
  it("never serves demo data: an unavailable transport on every demo view key rejects", async () => {
    const adapter = live(failingTransport(() => new TransportFailure("network")));
    for (const viewKey of ["overviewSummary", "approvalDetail", "pipelineSummary", "runDetail"]) expect((await fail(adapter.readView(read({ viewKey })))).category).toBe("unavailable");
  });
});

describe("failures map to the right categories", () => {
  const cases: [string, TransportFailure, string, string][] = [
    ["401", new TransportFailure("http", { status: 401 }), "UNAUTHENTICATED", "unauthenticated"],
    ["401 with an expiry body", new TransportFailure("http", { status: 401, body: { code: "SESSION_EXPIRED" } }), "SESSION_EXPIRED", "unauthenticated"],
    ["401 whose body claims something else", new TransportFailure("http", { status: 401, body: { code: "STALE_VERSION" } }), "UNAUTHENTICATED", "unauthenticated"],
    ["403", new TransportFailure("http", { status: 403 }), "FORBIDDEN", "forbidden"],
    ["403 whose body claims something else", new TransportFailure("http", { status: 403, body: { code: "SOURCE_UNAVAILABLE" } }), "FORBIDDEN", "forbidden"],
    ["403 source denial", new TransportFailure("http", { status: 403, body: { code: "SOURCE_AUTHORITY_DENIED" } }), "SOURCE_AUTHORITY_DENIED", "forbidden"],
    ["404", new TransportFailure("http", { status: 404 }), "RECORD_NOT_FOUND", "notFound"],
    ["429", new TransportFailure("http", { status: 429, retryAfterMs: 2000 }), "RATE_LIMITED", "rateLimited"],
    ["503", new TransportFailure("http", { status: 503 }), "SOURCE_UNAVAILABLE", "unavailable"],
    ["500 with an unknown code", new TransportFailure("http", { status: 500, body: { code: "WHAT" } }), "SOURCE_UNAVAILABLE", "unavailable"],
    ["network loss", new TransportFailure("network"), "SOURCE_UNAVAILABLE", "unavailable"],
    ["transport timeout", new TransportFailure("timeout"), "TIMEOUT", "unavailable"],
    ["transport abort not from the caller", new TransportFailure("aborted"), "SOURCE_UNAVAILABLE", "unavailable"],
    ["a plain Error thrown by the transport", new Error("boom") as TransportFailure, "SOURCE_UNAVAILABLE", "unavailable"],
  ];
  for (const [label, failure, code, category] of cases) {
    it(`${label} reads as ${code}`, async () => {
      const e = await fail(live(failingTransport(() => failure)).readView(read()));
      expect(e.body.code).toBe(code);
      expect(e.category).toBe(category);
      expect(e.body.requestId).toMatch(/^r-/);
      expect(e.body.executionCertainty).toBeUndefined();
    });
  }
  it("a 401 and a 403 are never retryable and say nothing about what exists", async () => {
    for (const status of [401, 403]) {
      const e = await fail(live(failingTransport(() => new TransportFailure("http", { status, body: { code: "FORBIDDEN", message: "Creator ZZ exists in another workspace" } }))).readView(read()));
      expect(e.body.retryable).toBe(false);
      expect(e.message).not.toMatch(/Creator ZZ/);
    }
  });
  it("429 keeps the retry delay", async () => {
    const e = await fail(live(failingTransport(() => new TransportFailure("http", { status: 429, retryAfterMs: 2000 }))).readView(read()));
    expect([e.body.retryable, e.body.retryAfterMs]).toEqual([true, 2000]);
  });
  it("a typed 409 STALE_VERSION is a recoverable conflict with the current version, and a typed body wins on other statuses", async () => {
    const body = { code: "STALE_VERSION", currentVersion: "v7", retryable: true, executionCertainty: "notApplied" };
    const e = await fail(live(failingTransport(() => new TransportFailure("http", { status: 409, body }))).submitAction(act()));
    expect(e.category).toBe("conflict");
    expect(e.body).toMatchObject({ code: "STALE_VERSION", currentVersion: "v7", retryable: false, executionCertainty: "notApplied" });
  });
  it("an untyped refusal is a validation failure that applied nothing, not a guess at a conflict", async () => {
    const e = await fail(live(failingTransport(() => new TransportFailure("http", { status: 409, body: "<html>" }))).submitAction(act()));
    expect(e.body).toMatchObject({ code: "VALIDATION_FAILED", executionCertainty: "notApplied" });
  });
  it("redacts credential-shaped text in anything the server says", async () => {
    const body = { code: "VALIDATION_FAILED", message: "bad header Authorization: Bearer abc.def.ghi and token=sk_live_123", correlationId: "c-1", fieldErrors: { x: "cookie: sid=abcdefabcdefabcdefabcdefabcdefabcdef" } };
    const e = await fail(live(failingTransport(() => new TransportFailure("http", { status: 422, body }))).submitAction(act()));
    const text = JSON.stringify(e.body);
    expect(text).not.toMatch(/abc\.def|sk_live|sid=|abcdefabcdef/);
    expect(redact("Bearer xyz")).toBe("[redacted]");
  });
});

describe("a write that may have been applied is never shown as failed-cleanly or as success", () => {
  it("network loss, timeout and a 5xx are uncertain, not notApplied", async () => {
    for (const failure of [new TransportFailure("network"), new TransportFailure("timeout"), new TransportFailure("http", { status: 502 })]) {
      for (const call of [(a: ReturnType<typeof live>) => a.submitAction(act()), (a: ReturnType<typeof live>) => a.saveResource(save())]) {
        const e = await fail(call(live(failingTransport(() => failure))));
        expect(e.category).toBe("unavailable");
        expect(e.body.executionCertainty).toBe("uncertain");
        expect(e.body.retryable).toBe(true);
      }
    }
  });
  it("401, 403 and a refused connection applied nothing", async () => {
    for (const failure of [new TransportFailure("http", { status: 401 }), new TransportFailure("http", { status: 403 }), new TransportFailure("network", { requestSent: false })]) {
      expect((await fail(live(failingTransport(() => failure)).submitAction(act()))).body.executionCertainty).toBe("notApplied");
    }
  });
  it("a write with no idempotency key is refused before anything is sent", async () => {
    const log: TransportRequest[] = [];
    const adapter = live(served(log));
    expect((await fail(adapter.submitAction(act({ idempotencyKey: " " })))).body).toMatchObject({ code: "VALIDATION_FAILED", executionCertainty: "notApplied" });
    expect((await fail(adapter.saveResource(save({ idempotencyKey: "" })))).body.code).toBe("VALIDATION_FAILED");
    expect(log).toHaveLength(0);
  });
  it("a request for another environment is refused before anything is sent", async () => {
    const log: TransportRequest[] = [];
    const adapter = live(served(log));
    const other = { ...scope, environment: "production" as const };
    expect((await fail(adapter.readView(read({ requestedScope: other })))).category).toBe("forbidden");
    expect((await fail(adapter.submitAction(act({ requestedScope: other })))).body.executionCertainty).toBe("notApplied");
    expect((await fail(adapter.saveResource(save({ requestedScope: other })))).body.executionCertainty).toBe("notApplied");
    expect(log).toHaveLength(0);
  });
});

describe("answers are validated before a screen sees them", () => {
  const good = async () => (await served().send({ kind: "read", envelope: read({ requestId: "good" }) }, { signal: new AbortController().signal })) as Record<string, unknown>;
  const readOf = (body: unknown, id = "good") => live(rawTransport(body)).readView(read({ requestId: id }));

  it("accepts a well-formed answer and drops fields the contract does not define", async () => {
    const res = await readOf({ ...(await good()), surprise: 1 });
    expect(res.requestId).toBe("good");
    expect("surprise" in res).toBe(false);
  });
  for (const [label, mutate] of [
    ["a string body", () => "<html>ok</html>"],
    ["null", () => null],
    ["an empty object", () => ({})],
    ["a missing scope", (g: Record<string, unknown>) => ({ ...g, scope: undefined })],
    ["a bad data state", (g: Record<string, unknown>) => ({ ...g, dataState: "ok" })],
    ["a missing data key", (g: Record<string, unknown>) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== "data"))],
    ["accounts as text", (g: Record<string, unknown>) => ({ ...g, scope: { ...(g.scope as object), accountIds: "a" } })],
    ["coverage counts as text", (g: Record<string, unknown>) => ({ ...g, coverage: { ...(g.coverage as object), expectedCount: "5" } })],
    ["another request's answer", (g: Record<string, unknown>) => ({ ...g, requestId: "someone-else" })],
  ] as [string, (g: Record<string, unknown>) => unknown][]) {
    it(`rejects ${label} as unavailable and shows no data`, async () => {
      const e = await fail(readOf(mutate(await good())));
      expect(e).toBeInstanceOf(AdapterError);
      expect(e.category).toBe("unavailable");
      expect(e.body.retryable).toBe(false);
    });
  }
  it("rejects a scope mismatch on reads, actions and saves as forbidden", async () => {
    const wrong = (res: Record<string, unknown>, accountIds = ["someone-else"]) => ({ ...res, scope: { ...(res.scope as object), accountIds } });
    expect((await fail(readOf(wrong(await good())))).category).toBe("forbidden");
    for (const field of ["workspaceId", "environment"]) {
      const g = await good();
      expect((await fail(readOf({ ...g, scope: { ...(g.scope as object), [field]: field === "environment" ? "production" : "other" } }))).category).toBe("forbidden");
    }
    const t = served();
    const sig = { signal: new AbortController().signal };
    const aReq = act();
    const aRes = (await t.send({ kind: "action", envelope: aReq }, sig)) as Record<string, unknown>;
    const aErr = await fail(live(rawTransport(wrong(aRes))).submitAction(aReq));
    expect(aErr.category).toBe("forbidden");
    expect(aErr.body.executionCertainty).toBe("uncertain");
    const sReq = save();
    const sRes = (await t.send({ kind: "save", envelope: sReq }, sig)) as Record<string, unknown>;
    expect((await fail(live(rawTransport(wrong(sRes))).saveResource(sReq))).category).toBe("forbidden");
  });
  it("treats an unreadable write answer as an unknown outcome, never as success", async () => {
    for (const body of ["ok", {}, { state: "succeeded" }, null]) {
      const a = await fail(live(rawTransport(body)).submitAction(act()));
      expect(a.body).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
      expect((await fail(live(rawTransport(body)).saveResource(save()))).body.code).toBe("OUTCOME_UNCERTAIN");
    }
  });
  it("rejects a save answer for another resource, or one with no record", async () => {
    const sig = { signal: new AbortController().signal };
    const req = save();
    const res = (await served().send({ kind: "save", envelope: req }, sig)) as Record<string, unknown>;
    expect((await fail(live(rawTransport({ ...res, resourceRef: "other" })).saveResource(req))).body.code).toBe("OUTCOME_UNCERTAIN");
    const noRecord = Object.fromEntries(Object.entries(res).filter(([k]) => k !== "record"));
    expect((await fail(live(rawTransport(noRecord)).saveResource(req))).body.code).toBe("OUTCOME_UNCERTAIN");
  });
});

describe("the run reference is top-level (Q-03)", () => {
  const control = (over: Partial<ActionRequest<unknown>> = {}) =>
    act({ operation: "controlRun", actionKind: "pauseRun", approvalRef: "demo-approval-batch", expectedVersion: "r1", payload: { control: "pause" }, ...over });
  it.each([undefined, null, "", "  "])("refuses controlRun and reconcileRun with runRef %j and sends nothing", async (runRef) => {
    const log: TransportRequest[] = [];
    const adapter = live(served(log));
    for (const operation of ["controlRun", "reconcileRun"] as const) {
      const e = await fail(adapter.submitAction(control({ operation, ...(runRef === undefined ? {} : { runRef }) })));
      expect(e.body).toMatchObject({ code: "VALIDATION_FAILED", executionCertainty: "notApplied", fieldErrors: { runRef: expect.any(String) } });
    }
    expect(log).toEqual([]);
  });
  it("sends a named run through untouched", async () => {
    const log: TransportRequest[] = [];
    await live(served(log)).submitAction(control({ runRef: "demo-run-batch" })).catch(() => undefined);
    expect((log[0]!.envelope as ActionRequest<unknown>).runRef).toBe("demo-run-batch");
  });
  it("does not require one for an operation that is not about a run", async () => {
    const log: TransportRequest[] = [];
    await live(served(log)).submitAction(act());
    expect(log).toHaveLength(1);
  });
});

describe("approved is not sent", () => {
  it("treats `approved` as awaiting dispatch: it parses, carries no send claim, and is certain (Q-01, Q-04)", async () => {
    const { req, body } = await (async () => {
      const r = act();
      const base = (await served().send({ kind: "action", envelope: r }, { signal: new AbortController().signal })) as Record<string, unknown>;
      return { req: r, body: base };
    })();
    expect(body).toMatchObject({ state: "approved", executionCertainty: "applied", reasonCodes: ["AWAITING_DISPATCH"] });
    const res = await live(rawTransport(body)).submitAction(act({ requestId: req.requestId }));
    expect(res.state).toBe("approved");
    expect(res.receiptRefs).toEqual([]);
  });
  it("refuses a success that also says nothing was applied", async () => {
    const r = act();
    const base = (await served().send({ kind: "action", envelope: r }, { signal: new AbortController().signal })) as Record<string, unknown>;
    const e = await fail(live(rawTransport({ ...base, state: "succeeded", receiptRefs: ["x"], executionCertainty: "notApplied" })).submitAction(dispatch({ requestId: r.requestId })));
    expect(e.body).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
  });
  it("reads an action or save answer with no executionCertainty as unreadable, so the write is uncertain (Q-04)", async () => {
    const r = act();
    const action = without((await served().send({ kind: "action", envelope: r }, { signal: new AbortController().signal })) as Record<string, unknown>, "executionCertainty");
    expect((await fail(live(rawTransport(action)).submitAction(act({ requestId: r.requestId })))).body).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
    const s = save();
    const saved = without((await served().send({ kind: "save", envelope: s }, { signal: new AbortController().signal })) as Record<string, unknown>, "executionCertainty");
    expect((await fail(live(rawTransport(saved)).saveResource(save({ requestId: s.requestId })))).body).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
  });

  const actionBody = async (over: Record<string, unknown>) => {
    const req = act();
    const base = (await served().send({ kind: "action", envelope: req }, { signal: new AbortController().signal })) as Record<string, unknown>;
    return { req, body: { ...base, ...over } };
  };
  it("refuses a success with no source receipt", async () => {
    for (const state of ["succeeded", "partiallySucceeded"]) {
      const { req, body } = await actionBody({ state, receiptRefs: [] });
      const e = await fail(live(rawTransport(body)).submitAction(dispatch({ requestId: req.requestId })));
      expect(e.body).toMatchObject({ code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" });
    }
  });
  it("accepts a success that carries a receipt", async () => {
    const { req, body } = await actionBody({ state: "succeeded", receiptRefs: ["receipt-1"] });
    const res = await live(rawTransport(body)).submitAction(dispatch({ requestId: req.requestId }));
    expect(res.receiptRefs).toEqual(["receipt-1"]);
  });
  it("never lets a preview, an approval request or a decision answer as sent or running, even with a receipt", async () => {
    for (const operation of ["previewAction", "requestApproval", "decideApproval"] as const)
      for (const state of ["succeeded", "partiallySucceeded", "running"]) {
        const { req, body } = await actionBody({ state, receiptRefs: ["r"] });
        const e = await fail(live(rawTransport(body)).submitAction(act({ operation, requestId: req.requestId })));
        expect(e.body.code, `${operation}/${state}`).toBe("OUTCOME_UNCERTAIN");
      }
  });
  it("through the demo-backed server: approve gives no receipt, dispatch gives one, and an uncertain dispatch gives none", async () => {
    const adapter = live(served());
    const decided = await adapter.submitAction(act());
    expect([decided.state, decided.receiptRefs]).toEqual(["approved", []]);
    const sent = await adapter.submitAction(dispatch());
    expect(sent.state).toBe("succeeded");
    expect(sent.receiptRefs.length).toBeGreaterThan(0);
    const u = live(served());
    await u.submitAction(act({ approvalRef: "demo-approval-uncertain" }));
    const unsure = await u.submitAction(dispatch({ approvalRef: "demo-approval-uncertain" }));
    expect([unsure.state, unsure.receiptRefs]).toEqual(["outcomeUncertain", []]);
  });
});

describe("timeouts and aborts", () => {
  it("a transport that never answers times out, even if it ignores the abort signal", async () => {
    const adapter = live(hangingTransport, { timeoutMs: 20 });
    const r = await fail(adapter.readView(read()));
    expect([r.body.code, r.category]).toEqual(["TIMEOUT", "unavailable"]);
    const a = await fail(createLiveAdapter("sandbox", { transport: hangingTransport, timeoutMs: 20, writeAttempts: 1 }).submitAction(act()));
    expect([a.body.code, a.body.executionCertainty]).toEqual(["TIMEOUT", "uncertain"]);
  });
  it("the transport's signal aborts on timeout", async () => {
    let signal: AbortSignal | undefined;
    await fail(live({ send: (_r, o) => ((signal = o.signal), new Promise(() => undefined)) }, { timeoutMs: 10 }).readView(read()));
    expect(signal?.aborted).toBe(true);
  });
  it("the caller aborting rejects with the abort, not with an answer or an AdapterError, and reaches the transport", async () => {
    let signal: AbortSignal | undefined;
    const adapter = live({ send: (_r, o) => ((signal = o.signal), new Promise(() => undefined)) });
    const controller = new AbortController();
    const pending = adapter.readView(read(), { signal: controller.signal });
    controller.abort();
    const e = await fail(pending);
    expect(e).not.toBeInstanceOf(AdapterError);
    expect((e as unknown as Error).name).toBe("AbortError");
    expect(signal?.aborted).toBe(true);
    const done = new AbortController();
    done.abort();
    expect(await fail(adapter.submitAction(act(), { signal: done.signal }))).not.toBeInstanceOf(AdapterError);
  });
  it("an abort between write attempts stops the retry", async () => {
    const controller = new AbortController();
    const flaky = flakyTransport(served(), 5, () => new TransportFailure("network"));
    const adapter = createLiveAdapter("sandbox", { transport: flaky, retryDelayMs: 1000, writeAttempts: 3 });
    const pending = adapter.submitAction(act(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await fail(pending)).not.toBeInstanceOf(AdapterError);
    expect(flaky.calls()).toBe(1);
  });
});

describe("retries and duplicate delivery keep one logical command", () => {
  it("a write retried after a lost answer carries the same idempotency key and is applied once", async () => {
    const log: TransportRequest[] = [];
    const lost = lostAnswerTransport(served(log));
    const req = act();
    const res = await live(lost).submitAction(req);
    expect(lost.calls()).toBe(2);
    expect(log.map((r) => (r.envelope as ActionRequest<unknown>).idempotencyKey)).toEqual([req.idempotencyKey, req.idempotencyKey]);
    expect(log.map((r) => r.envelope.requestId)).toEqual([req.requestId, req.requestId]);
    // The server replayed its first answer rather than deciding twice.
    expect(res.state).toBe("approved");
  });
  it("a save retried the same way keeps its key and does not bump the version twice", async () => {
    const log: TransportRequest[] = [];
    const req = save();
    const once = await live(served()).saveResource({ ...req, idempotencyKey: "other" });
    const res = await live(lostAnswerTransport(served(log))).saveResource(req);
    expect(new Set(log.map((r) => (r.envelope as SaveResourceRequest<unknown>).idempotencyKey))).toEqual(new Set([req.idempotencyKey]));
    expect(res.resourceVersion).toBe(once.resourceVersion);
  });
  it("a write is retried for a flaky network up to its attempts, then reports an unknown outcome", async () => {
    const flaky = flakyTransport(served(), 5, () => new TransportFailure("network"));
    const e = await fail(createLiveAdapter("sandbox", { transport: flaky, retryDelayMs: 0, writeAttempts: 3 }).submitAction(act()));
    expect(flaky.calls()).toBe(3);
    expect(e.body.executionCertainty).toBe("uncertain");
  });
  it("is not retried when the server answered a definite refusal", async () => {
    for (const status of [401, 403, 404, 409, 422, 429]) {
      let calls = 0;
      const t: Transport = { send: () => (calls++, Promise.reject(new TransportFailure("http", { status }))) };
      await fail(live(t, { writeAttempts: 3 }).submitAction(act()));
      expect(calls, String(status)).toBe(1);
    }
  });
  it("reads are never retried by the adapter", async () => {
    const flaky = flakyTransport(served(), 5, () => new TransportFailure("network"));
    await fail(live(flaky, { writeAttempts: 3 }).readView(read()));
    expect(flaky.calls()).toBe(1);
  });
  it("duplicate delivery of one command is one dispatch: the server's receipt is preserved", async () => {
    const adapter = live(duplicatingTransport(served()));
    await adapter.submitAction(act());
    const dReq = dispatch();
    const first = await adapter.submitAction(dReq);
    const again = await adapter.submitAction({ ...dReq, requestId: "retry-1" });
    expect(first.receiptRefs.length).toBeGreaterThan(0);
    expect(again.receiptRefs).toEqual(first.receiptRefs);
    expect(again.actionRef).toBe(first.actionRef);
  });
  it("the same key with a changed payload is a conflict that applied nothing", async () => {
    const adapter = live(served());
    const req = act();
    await adapter.submitAction(req);
    const e = await fail(adapter.submitAction({ ...req, payload: { decision: "rejected", reason: "x" }, requestId: "alt" }));
    expect(e.category).toBe("conflict");
    expect(e.body.executionCertainty).toBe("notApplied");
  });
  it("a stale version is a recoverable conflict: the current version is returned and works", async () => {
    const adapter = live(served());
    const e = await fail(adapter.submitAction(act({ expectedVersion: "stale" })));
    expect([e.body.code, e.category, e.body.executionCertainty]).toEqual(["STALE_VERSION", "conflict", "notApplied"]);
    const res = await adapter.submitAction(act({ expectedVersion: e.body.currentVersion! }));
    expect(res.receiptRefs).toEqual([]);
  });
});

describe("no credentials in client code", () => {
  const sources = ["liveAdapter.ts", "transport.ts", "wire.ts", "selectAdapter.ts"].map((f) => [f, readFileSync(join(process.cwd(), "src/adapter", f), "utf8")] as const);
  for (const [file, text] of sources)
    it(`${file} touches no browser storage, cookie, credential header or fetch`, () => {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|\bfetch\s*\(|XMLHttpRequest|credentials\s*:|Authorization|Set-Cookie|\bhttps?:\/\//);
    });
  it("the envelopes handed to the transport carry only contract fields", async () => {
    const log: TransportRequest[] = [];
    await live(served(log)).readView(read());
    expect(Object.keys(log[0]!.envelope).sort()).toEqual(Object.keys(read()).sort());
  });
});
