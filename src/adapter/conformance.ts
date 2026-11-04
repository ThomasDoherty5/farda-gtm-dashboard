/**
 * Adapter conformance suite. Registers vitest tests that any `FardaAdapter` must pass, so the demo adapter and the
 * authenticated adapter (THO-283, not built) answer to the same rules. It does not know any backend URL and builds no
 * transport. To check an adapter, describe it as a `ConformanceTarget` and call `runAdapterConformance` from a test file.
 *
 * A rule the target cannot exercise yet is never skipped quietly. Either it names a reason in `gaps` (registered as
 * `it.todo`), or it names a reason in `knownFailures` (registered as `it.fails`, which turns red the day the rule starts
 * passing so the entry gets removed). A rule with no scenario and no reason fails.
 *
 * See docs/adapter-conformance.md.
 */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FardaAdapter } from "./adapter";
import {
  SCHEMA_VERSION,
  actionResponseSchema,
  provenanceValueSchema,
  readResponseSchema,
  verifiedScopeSchema,
  type ActionRequest,
  type ActionResponse,
  type Environment,
  type ReadRequest,
  type RequestedScope,
  type SaveResourceRequest,
} from "./contract";
import { AdapterError } from "./errors";
import { scopeKey, ScopeProvider } from "./scope";
import { useAction, type ActionInput } from "./useAction";
import { useSave, type SaveInput } from "./useSave";
import { useView } from "./useView";

// ---- Target description -----------------------------------------------------------------------------

export type ReadSpec = { viewKey: string; filters?: unknown };
export type ReadScenario = { create: () => FardaAdapter; read: ReadSpec };

export type ConformanceTarget = {
  name: string;
  kind: FardaAdapter["kind"];
  environment: Environment;
  /** A fresh adapter. Services that hold state must not leak between tests. */
  create: () => FardaAdapter;
  /** The scope every request carries. Its environment is the adapter's own. */
  scope: RequestedScope;
  /** A view to ask for. It need not succeed when `canServeData` is false. */
  read: ReadSpec;
  /** False while there is no transport: the adapter cannot return data yet. */
  canServeData: boolean;
  /** An adapter whose reads fail with a session expiry or a missing grant. */
  unauthenticated?: () => FardaAdapter;
  forbidden?: () => FardaAdapter;
  /** An adapter whose reads fail because the backend is unavailable or integration is pending. */
  unavailable?: () => FardaAdapter;
  /** The same for actions and saves. */
  unavailableWrites?: () => FardaAdapter;
  /** Reads that must carry a known zero, and an unknown value, through the contract's value states. */
  valueStates?: { knownZero: ReadScenario; unknown: ReadScenario; notApplicable?: ReadScenario };
  /** An approval that can be decided and then dispatched. `operation` names are the contract's. */
  actions?: {
    approvalRef: string;
    version: string;
    approvePayload: unknown;
    /** A different payload for the same operation, for the changed-payload-same-key case. */
    altPayload: unknown;
    /** An approval whose dispatch ends with an unknown outcome. */
    uncertainApprovalRef?: string;
  };
  /** A versioned resource that can be saved. `changedPayload` must differ from what is stored. */
  saves?: {
    resourceKind: SaveResourceRequest<unknown>["resourceKind"];
    resourceRef: string;
    version: string;
    changedPayload: unknown;
  };
  /** Rule id to the reason this target cannot exercise it yet. Registered as `it.todo`. */
  gaps?: Record<string, string>;
  /** Rule id to the reason this target is known to fail it. Registered as `it.fails`. */
  knownFailures?: Record<string, string>;
};

// ---- Helpers ----------------------------------------------------------------------------------------

let seq = 0;
const next = (prefix: string) => `${prefix}-${++seq}`;

const readRequest = (scope: RequestedScope, spec: ReadSpec, over: Partial<ReadRequest<unknown>> = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey: spec.viewKey,
  requestedScope: scope,
  filters: spec.filters ?? {},
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: next("conf-read"),
  ...over,
});

type Actions = NonNullable<ConformanceTarget["actions"]>;
const decideRequest = (t: ConformanceTarget, a: Actions, over: Partial<ActionRequest<unknown>> = {}): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "decideApproval",
  requestedScope: t.scope,
  actionKind: "decideApproval",
  entityRefs: [],
  expectedVersion: a.version,
  approvalRef: a.approvalRef,
  manifestRef: null,
  idempotencyKey: next("conf-key"),
  payload: a.approvePayload,
  requestId: next("conf-act"),
  ...over,
});
const dispatchRequest = (t: ConformanceTarget, a: Actions, over: Partial<ActionRequest<unknown>> = {}): ActionRequest<unknown> =>
  decideRequest(t, a, { operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", payload: {}, ...over });

type Saves = NonNullable<ConformanceTarget["saves"]>;
const saveRequest = (t: ConformanceTarget, s: Saves, over: Partial<SaveResourceRequest<unknown>> = {}): SaveResourceRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "saveResource",
  requestedScope: t.scope,
  resourceKind: s.resourceKind,
  resourceRef: s.resourceRef,
  expectedVersion: s.version,
  idempotencyKey: next("conf-save"),
  requestId: next("conf-savereq"),
  payload: s.changedPayload,
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<AdapterError> {
  let resolved = false;
  try {
    await p;
    resolved = true;
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterError);
    return e as AdapterError;
  }
  if (resolved) throw new Error("expected the adapter to reject with an AdapterError, but it answered");
  throw new Error("unreachable");
}

const sameAccounts = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",");

/** Mirrors `SaveResourceResponse`; contract.ts exports only the type for it. */
const saveResponseSchema = z.object({
  schemaVersion: z.string(),
  requestId: z.string(),
  scope: verifiedScopeSchema,
  resourceRef: z.string(),
  resourceVersion: z.string(),
  persistedAt: z.string(),
  persistedByRef: z.string(),
  record: z.unknown(),
  reasonCodes: z.array(z.string()),
});

/**
 * The contract's schemas strip unknown keys. A response from a real backend must not carry any, so conformance parses
 * with this strict copy of the same schema: unknown keys at any depth are an error. `z.unknown()` leaves (view data) stay open.
 */
export function deepStrict(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) shape[key] = deepStrict(value);
    return z.object(shape).strict();
  }
  if (schema instanceof z.ZodEffects) return new z.ZodEffects({ ...schema._def, schema: deepStrict(schema._def.schema) });
  if (schema instanceof z.ZodArray) return z.array(deepStrict(schema.element));
  if (schema instanceof z.ZodNullable) return deepStrict(schema.unwrap()).nullable();
  if (schema instanceof z.ZodOptional) return deepStrict(schema.unwrap()).optional();
  return schema;
}

function expectStrict(schema: z.ZodTypeAny, value: unknown) {
  const parsed = deepStrict(schema).safeParse(value);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
}

/** Approved is not Sent: a response may claim the work was sent only if it carries a receipt. */
export function claimsSentWithoutReceipt(res: Pick<ActionResponse, "state" | "receiptRefs">): boolean {
  return (res.state === "succeeded" || res.state === "partiallySucceeded") && res.receiptRefs.length === 0;
}
export const claimsSent = (res: Pick<ActionResponse, "state">) => res.state === "succeeded" || res.state === "partiallySucceeded";

type Node = Record<string, unknown>;
const looksLikeProvenance = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && ["state", "value", "reasonCode", "evidenceRefs", "observedAt"].every((k) => k in v);
/** Every contract value node in a response body. */
export function provenanceNodes(body: unknown, out: Node[] = []): Node[] {
  if (looksLikeProvenance(body)) out.push(body);
  else if (Array.isArray(body)) body.forEach((x) => provenanceNodes(x, out));
  else if (typeof body === "object" && body !== null) Object.values(body).forEach((x) => provenanceNodes(x, out));
  return out;
}

/** Wraps an adapter so a test can watch, delay or fail calls. The wrapped adapter still does the work. */
export function intercept(
  base: FardaAdapter,
  hooks: { read?: (r: ReadRequest<unknown>) => unknown; action?: (r: ActionRequest<unknown>) => unknown; save?: (r: SaveResourceRequest<unknown>) => unknown },
): FardaAdapter {
  return {
    environment: base.environment,
    kind: base.kind,
    readView: (async (r: ReadRequest<unknown>, o?: { signal?: AbortSignal }) => {
      await hooks.read?.(r);
      return base.readView(r, o);
    }) as FardaAdapter["readView"],
    submitAction: (async (r: ActionRequest<unknown>, o?: { signal?: AbortSignal }) => {
      await hooks.action?.(r);
      return base.submitAction(r, o);
    }) as FardaAdapter["submitAction"],
    saveResource: (async (r: SaveResourceRequest<unknown>, o?: { signal?: AbortSignal }) => {
      await hooks.save?.(r);
      return base.saveResource(r, o);
    }) as FardaAdapter["saveResource"],
  };
}

function hookHarness<R>(adapter: FardaAdapter, scope: RequestedScope, hook: () => R) {
  const holder = { scope, principal: "conformance-principal" };
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, createElement(ScopeProvider, { adapter, scope: holder.scope, principal: holder.principal, children } as never));
  const rendered = renderHook(hook, { wrapper });
  return { ...rendered, qc, holder };
}

const err = (code: string, extra: Partial<ConstructorParameters<typeof AdapterError>[0]> = {}) =>
  new AdapterError({ code, message: code, requestId: null, correlationId: null, retryable: false, retryAfterMs: null, ...extra });

const anyInput: ActionInput<unknown> = { operation: "decideApproval", actionKind: "decideApproval", entityRefs: [], expectedVersion: "v1", approvalRef: null, manifestRef: null, payload: { n: 1 } };

// ---- Contract schema rules (adapter independent, register once) -------------------------------------

const node = (over: Record<string, unknown>) => ({ state: "known", value: 0, reasonCode: null, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: "2026-10-30T00:00:00.000Z", ...over });
const validRead = () => ({
  schemaVersion: SCHEMA_VERSION,
  requestId: "r",
  scope: { workspaceId: "w", accountIds: ["a"], environment: "demo", authorizationScopeVersion: "1" },
  dataVersion: "1",
  dataState: "ready",
  data: { x: 1 },
  sourceFreshness: [],
  coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
  capabilities: [{ actionKind: "k", state: "available", reasonCodes: [] }],
  page: { nextCursor: null, hasMore: false },
  refresh: { nextPollAfterMs: null },
});
const validAction = () => ({
  schemaVersion: SCHEMA_VERSION,
  requestId: "r",
  scope: { workspaceId: "w", accountIds: ["a"], environment: "demo", authorizationScopeVersion: "1" },
  actionRef: "act",
  state: "blocked",
  runRef: null,
  approvalRef: null,
  manifestRef: null,
  payloadVersion: "v1",
  policyVersion: "p1",
  modelVersion: null,
  offerVersion: null,
  reasonCodes: [],
  receiptRefs: [],
  nextAction: null,
  nextPollAfterMs: null,
});

/** Rules about the contract's own schemas. Call once; they do not depend on an adapter. */
export function runContractSchemaConformance() {
  const money = provenanceValueSchema(z.number());
  const read = readResponseSchema(z.unknown());

  describe("contract schemas: known zero, unknown and N/A stay distinct", () => {
    it("VALUE-1 a known zero parses as known and stays 0, never null", () => {
      const parsed = money.parse(node({ state: "known", value: 0 }));
      expect(parsed.state).toBe("known");
      expect(parsed.value).toBe(0);
    });
    it("VALUE-2 unknown and N/A carry null and a reason code", () => {
      for (const state of ["unknown", "notApplicable"]) {
        const parsed = money.parse(node({ state, value: null, reasonCode: "SOURCE_NOT_SELECTED" }));
        expect(parsed.value).toBeNull();
        expect(parsed.reasonCode).toBe("SOURCE_NOT_SELECTED");
      }
    });
    it("VALUE-3 missing data can't become zero, and a known value can't be missing", () => {
      expect(money.safeParse(node({ state: "known", value: null })).success).toBe(false);
      expect(money.safeParse(node({ state: "unknown", value: 0, reasonCode: "X" })).success).toBe(false);
      expect(money.safeParse(node({ state: "notApplicable", value: 0, reasonCode: "X" })).success).toBe(false);
      expect(money.safeParse(node({ state: "unknown", value: null, reasonCode: null })).success).toBe(false);
      expect(money.safeParse(node({ state: "notApplicable", value: null, reasonCode: "" })).success).toBe(false);
      expect(money.safeParse(node({ state: "zero", value: 0 })).success).toBe(false);
    });
    it("VALUE-4 the three states stay three through a JSON round trip", () => {
      const states = [node({ state: "known", value: 0 }), node({ state: "unknown", value: null, reasonCode: "A" }), node({ state: "notApplicable", value: null, reasonCode: "B" })];
      const back = states.map((n) => money.parse(JSON.parse(JSON.stringify(n))));
      expect(back.map((n) => n.state)).toEqual(["known", "unknown", "notApplicable"]);
      expect(back.map((n) => n.value)).toEqual([0, null, null]);
    });
  });

  describe("contract schemas: unknown fields and bad shapes are rejected, not trusted", () => {
    it("SCHEMA-0 the fixtures used here are valid", () => {
      expectStrict(read, validRead());
      expectStrict(actionResponseSchema, validAction());
    });
    it("SCHEMA-1 a strict parse rejects an unknown field at any depth", () => {
      const extra = (path: string[], value: unknown) => {
        const body = validRead() as Record<string, unknown>;
        let at = body;
        for (const key of path) at = at[key] as Record<string, unknown>;
        at.surprise = value;
        return body;
      };
      for (const path of [[], ["scope"], ["coverage"], ["page"], ["refresh"]]) expect(deepStrict(read).safeParse(extra(path, 1)).success, path.join(".") || "root").toBe(false);
      const cap = validRead();
      (cap.capabilities[0] as Record<string, unknown>).surprise = true;
      expect(deepStrict(read).safeParse(cap).success).toBe(false);
      expect(deepStrict(actionResponseSchema).safeParse({ ...validAction(), isSent: true }).success).toBe(false);
      expect(deepStrict(actionResponseSchema).safeParse({ ...validAction(), nextAction: { kind: "k", ownerRef: null, dueAt: null, available: true, surprise: 1 } }).success).toBe(false);
      expect(deepStrict(money).safeParse(node({ surprise: 1 })).success).toBe(false);
    });
    it("SCHEMA-2 bad shapes are rejected", () => {
      const bad: [string, unknown][] = [
        ["missing scope", { ...validRead(), scope: undefined }],
        ["unknown data state", { ...validRead(), dataState: "ok" }],
        ["accountIds as a string", { ...validRead(), scope: { ...validRead().scope, accountIds: "a" } }],
        ["unknown environment", { ...validRead(), scope: { ...validRead().scope, environment: "staging" } }],
        ["capabilities null", { ...validRead(), capabilities: null }],
        ["coverage count as text", { ...validRead(), coverage: { ...validRead().coverage, expectedCount: "5" } }],
        ["not an object", "ready"],
      ];
      for (const [label, value] of bad) expect(read.safeParse(value).success, label).toBe(false);
      const badActions: [string, unknown][] = [
        ["'approved' is not an action state", { ...validAction(), state: "approved" }],
        ["'sent' is not an action state", { ...validAction(), state: "sent" }],
        ["receiptRefs not a list", { ...validAction(), receiptRefs: "r-1" }],
        ["missing actionRef", { ...validAction(), actionRef: undefined }],
      ];
      for (const [label, value] of badActions) expect(actionResponseSchema.safeParse(value).success, label).toBe(false);
    });
    // The shipped schemas are plain z.object, which strips unknown keys instead of rejecting them. Adapters are held to the
    // strict copy above. THO-283 should decide whether the contract itself becomes strict; remove `fails` when it does.
    it.fails("SCHEMA-3 (known failure) the shipped contract schemas reject an unknown field themselves", () => {
      expect(read.safeParse({ ...validRead(), surprise: 1 }).success).toBe(false);
      expect(actionResponseSchema.safeParse({ ...validAction(), isSent: true }).success).toBe(false);
    });
  });
}

// ---- Adapter rules ----------------------------------------------------------------------------------

const DEMO_VIEW_KEYS = ["overviewSummary", "approvalDetail", "evidenceRecord", "pipelineSummary", "launchSnapshot", "recruitmentQueue"];

export function runAdapterConformance(t: ConformanceTarget) {
  describe(`adapter conformance: ${t.name}`, () => {
    const registered = new Set<string>();
    const readReq = (over: Partial<ReadRequest<unknown>> = {}) => readRequest(t.scope, t.read, over);

    /** Registers a rule. With no scenario it is a todo carrying the reason, or a failure when there is none. */
    function rule(id: string, title: string, available: boolean, run: () => void | Promise<void>) {
      registered.add(id);
      const name = `${id} ${title}`;
      const known = t.knownFailures?.[id];
      if (known) return it.fails(`${name} (known failure: ${known})`, run);
      if (available) return it(name, run);
      const gap = t.gaps?.[id];
      if (gap) return it.todo(`${name} (pending: ${gap})`);
      return it(name, () => {
        throw new Error(`${id} has no scenario on ${t.name} and no documented gap. Add a scenario or a reason to \`gaps\`.`);
      });
    }

    const data = t.canServeData;
    const a = t.actions;
    const s = t.saves;

    // -- Identity ----
    rule("IDENT-1", "the adapter reports its kind and environment, and demo data is only ever demo", true, () => {
      const adapter = t.create();
      expect(adapter.kind).toBe(t.kind);
      expect(adapter.environment).toBe(t.environment);
      expect(t.scope.environment).toBe(t.environment);
      if (t.kind === "live") expect(adapter.environment).not.toBe("demo");
      else expect(adapter.environment).toBe("demo");
    });
    rule("IDENT-2", "every response is labeled with the adapter's own environment", data, async () => {
      const res = await t.create().readView(readReq());
      expect(res.scope.environment).toBe(t.environment);
      if (t.kind === "demo") expect(res.scope.authorizationScopeVersion).toMatch(/demo/);
    });

    // -- Reads carry the full scope ----
    rule("SCOPE-READ-1", "a read response echoes the workspace, accounts and environment requested", data, async () => {
      const adapter = t.create();
      for (const accountIds of [t.scope.accountIds, ["acct-2", "acct-1"]]) {
        const req = readReq({ requestedScope: { ...t.scope, accountIds } });
        const res = await adapter.readView(req);
        expect(res.requestId).toBe(req.requestId);
        expect(res.schemaVersion).toBe(SCHEMA_VERSION);
        expect(res.scope.workspaceId).toBe(req.requestedScope.workspaceId);
        expect(res.scope.environment).toBe(req.requestedScope.environment);
        expect(sameAccounts(res.scope.accountIds, accountIds)).toBe(true);
      }
    });
    rule("SCOPE-READ-2", "a read response matches the contract schema strictly (no unknown fields)", data, async () => {
      expectStrict(readResponseSchema(z.unknown()), await t.create().readView(readReq()));
    });
    rule("SCOPE-READ-3", "a request for another environment is refused as forbidden and returns no data", data, async () => {
      const other: Environment = t.environment === "production" ? "sandbox" : "production";
      const error = await rejection(t.create().readView(readReq({ requestedScope: { ...t.scope, environment: other } })));
      expect(error.category).toBe("forbidden");
      expect(error.body.retryable).toBe(false);
    });
    rule("SCOPE-READ-4", "useView sends the full requested scope on every read", true, async () => {
      const seen: ReadRequest<unknown>[] = [];
      const h = hookHarness(intercept(t.create(), { read: (r) => void seen.push(r) }), t.scope, () => useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}));
      await waitFor(() => expect(h.result.current.isFetched).toBe(true));
      expect(seen.length).toBeGreaterThan(0);
      for (const r of seen) {
        expect(r.requestedScope).toEqual(t.scope);
        expect(r.schemaVersion).toBe(SCHEMA_VERSION);
        expect(r.operation).toBe("readView");
        expect(r.viewKey).toBe(t.read.viewKey);
        expect(r.requestId).toBeTruthy();
      }
    });
    rule("SCOPE-READ-5", "useView refuses a response whose verified scope differs from the request", data, async () => {
      const lying = intercept(t.create(), {});
      const read = lying.readView.bind(lying);
      lying.readView = (async (r: ReadRequest<unknown>, o?: { signal?: AbortSignal }) => {
        const res = await read(r, o);
        return { ...res, scope: { ...res.scope, accountIds: ["someone-else"] } };
      }) as FardaAdapter["readView"];
      const h = hookHarness(lying, t.scope, () => useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}));
      await waitFor(() => expect(h.result.current.isError).toBe(true));
      expect(h.result.current.data).toBeUndefined();
    });

    // -- Actions and saves carry the full scope ----
    rule("SCOPE-ACTION-1", "an action response echoes the requested scope and matches the schema strictly", a !== undefined, async () => {
      const req = decideRequest(t, a!);
      const res = await t.create().submitAction(req);
      expect(res.requestId).toBe(req.requestId);
      expect(res.scope.workspaceId).toBe(t.scope.workspaceId);
      expect(res.scope.environment).toBe(t.scope.environment);
      expect(sameAccounts(res.scope.accountIds, t.scope.accountIds)).toBe(true);
      expectStrict(actionResponseSchema, res);
    });
    rule("SCOPE-ACTION-2", "an action for another environment is refused and nothing is applied", a !== undefined, async () => {
      const other: Environment = t.environment === "production" ? "sandbox" : "production";
      const error = await rejection(t.create().submitAction(decideRequest(t, a!, { requestedScope: { ...t.scope, environment: other } })));
      expect(error.category).toBe("forbidden");
      expect(error.body.executionCertainty).toBe("notApplied");
    });
    rule("SCOPE-ACTION-3", "useAction sends the full scope, a key per logical action, and keeps the key across a retry", true, async () => {
      const seen: ActionRequest<unknown>[] = [];
      const h = hookHarness(intercept(t.create(), { action: (r) => void seen.push(r) }), t.scope, () => useAction<unknown>());
      const run = (input: ActionInput<unknown>) => act(async () => void (await h.result.current.mutateAsync(input).catch(() => undefined)));
      await run(anyInput);
      await run(anyInput);
      await run({ ...anyInput, payload: { n: 2 } });
      expect(seen).toHaveLength(3);
      for (const r of seen) {
        expect(r.requestedScope).toEqual(t.scope);
        expect(r.schemaVersion).toBe(SCHEMA_VERSION);
        expect(r.idempotencyKey.trim()).not.toBe("");
      }
      expect(seen[1]!.idempotencyKey).toBe(seen[0]!.idempotencyKey);
      expect(seen[2]!.idempotencyKey).not.toBe(seen[0]!.idempotencyKey);
      expect(new Set(seen.map((r) => r.requestId)).size).toBe(3);
    });
    rule("SCOPE-SAVE-1", "a save response echoes the requested scope and matches the schema strictly", s !== undefined, async () => {
      const req = saveRequest(t, s!);
      const res = await t.create().saveResource(req);
      expect(res.requestId).toBe(req.requestId);
      expect(res.scope.workspaceId).toBe(t.scope.workspaceId);
      expect(res.scope.environment).toBe(t.scope.environment);
      expect(sameAccounts(res.scope.accountIds, t.scope.accountIds)).toBe(true);
      expectStrict(saveResponseSchema, res);
    });
    rule("SCOPE-SAVE-2", "useSave sends the full scope, a key per logical save, and keeps the key across a retry", true, async () => {
      const seen: SaveResourceRequest<unknown>[] = [];
      const h = hookHarness(intercept(t.create(), { save: (r) => void seen.push(r) }), t.scope, () => useSave<unknown, unknown>());
      const input: SaveInput<unknown> = { resourceKind: "actionDraft", resourceRef: "r", expectedVersion: "v1", payload: { n: 1 } };
      const run = (i: SaveInput<unknown>) => act(async () => void (await h.result.current.mutateAsync(i).catch(() => undefined)));
      await run(input);
      await run(input);
      await run({ ...input, payload: { n: 2 } });
      expect(seen).toHaveLength(3);
      for (const r of seen) {
        expect(r.requestedScope).toEqual(t.scope);
        expect(r.idempotencyKey.trim()).not.toBe("");
      }
      expect(seen[1]!.idempotencyKey).toBe(seen[0]!.idempotencyKey);
      expect(seen[2]!.idempotencyKey).not.toBe(seen[0]!.idempotencyKey);
    });

    // -- Query keys include the full scope ----
    rule("KEY-1", "a view's query key starts with principal, environment, workspace and accounts, then schema and view", true, async () => {
      const h = hookHarness(t.create(), t.scope, () => useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}));
      await waitFor(() => expect(h.result.current.isFetched).toBe(true));
      const keys = h.qc.getQueryCache().getAll().map((q) => q.queryKey);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.slice(0, 5)).toEqual(scopeKey({ principal: h.holder.principal, scope: t.scope }));
      expect(keys[0]).toEqual(expect.arrayContaining([SCHEMA_VERSION, t.read.viewKey]));
      const base = { principal: "p", scope: t.scope };
      const variants = [
        { ...base, principal: "p2" },
        { ...base, scope: { ...t.scope, workspaceId: "w2" } },
        { ...base, scope: { ...t.scope, accountIds: [...t.scope.accountIds, "extra"] } },
        { ...base, scope: { ...t.scope, environment: (t.environment === "production" ? "sandbox" : "production") as Environment } },
      ];
      for (const v of variants) expect(scopeKey(v)).not.toEqual(scopeKey(base));
      expect(scopeKey({ ...base, scope: { ...t.scope, accountIds: ["b", "a"] } })).toEqual(scopeKey({ ...base, scope: { ...t.scope, accountIds: ["a", "b"] } }));
    });
    for (const [label, change] of [
      ["accounts", (h: { holder: { scope: RequestedScope; principal: string } }) => void (h.holder.scope = { ...t.scope, accountIds: ["acct-other"] })],
      ["workspace", (h: { holder: { scope: RequestedScope; principal: string } }) => void (h.holder.scope = { ...t.scope, workspaceId: "workspace-other" })],
      ["principal", (h: { holder: { scope: RequestedScope; principal: string } }) => void (h.holder.principal = "principal-other")],
    ] as const) {
      for (const keepPrevious of [false, true]) {
        rule(`KEY-2:${label}${keepPrevious ? ":keepPrevious" : ""}`, `changing the ${label} never shows the previous scope's data while the new answer is pending`, data, async () => {
          let calls = 0;
          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => (release = resolve));
          const adapter = intercept(t.create(), { read: () => (++calls > 1 ? gate : undefined) });
          const h = hookHarness(adapter, t.scope, () => useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}, null, { keepPrevious }));
          await waitFor(() => expect(h.result.current.data).toBeDefined());
          const oldRoot = scopeKey({ principal: h.holder.principal, scope: h.holder.scope });
          change(h);
          h.rerender();
          expect(h.result.current.data).toBeUndefined();
          expect(h.result.current.isPlaceholderData).toBe(false);
          expect(h.qc.getQueryCache().findAll({ queryKey: oldRoot })).toHaveLength(0);
          await act(async () => release());
          await waitFor(() => expect(h.result.current.data).toBeDefined());
          const root = scopeKey({ principal: h.holder.principal, scope: h.holder.scope });
          expect(h.qc.getQueryCache().findAll({ queryKey: root }).length).toBeGreaterThan(0);
          expect(h.qc.getQueryCache().findAll({ queryKey: oldRoot })).toHaveLength(0);
        });
      }
    }

    // -- 401 and 403 clear protected data ----
    for (const [code, category] of [
      ["UNAUTHENTICATED", "unauthenticated"],
      ["SESSION_EXPIRED", "unauthenticated"],
      ["FORBIDDEN", "forbidden"],
      ["SOURCE_AUTHORITY_DENIED", "forbidden"],
    ] as const) {
      rule(`AUTH-1:${code}`, `a ${code} on a read clears the data already cached for the scope`, data, async () => {
        let failure: AdapterError | null = null;
        const adapter = intercept(t.create(), { read: () => { if (failure) throw failure; } });
        const h = hookHarness(adapter, t.scope, () => useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}));
        await waitFor(() => expect(h.result.current.data).toBeDefined());
        failure = err(code);
        await act(async () => void (await h.result.current.refetch()));
        await waitFor(() => expect(h.result.current.isError).toBe(true));
        expect(h.result.current.data).toBeUndefined();
        expect((h.result.current.error as AdapterError).category).toBe(category);
        const root = scopeKey({ principal: h.holder.principal, scope: t.scope });
        for (const q of h.qc.getQueryCache().findAll({ queryKey: root })) expect(q.state.data).toBeUndefined();
      });
    }
    rule("AUTH-2", "a 401 on an action clears protected data; a 403 on an action fails only that action", data, async () => {
      let failure: AdapterError | null = null;
      const adapter = intercept(t.create(), { action: () => { if (failure) throw failure; } });
      const h = hookHarness(adapter, t.scope, () => ({ view: useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}), action: useAction<unknown>() }));
      await waitFor(() => expect(h.result.current.view.data).toBeDefined());
      failure = err("FORBIDDEN", { executionCertainty: "notApplied" });
      await act(async () => void (await h.result.current.action.mutateAsync(anyInput).catch(() => undefined)));
      await waitFor(() => expect(h.result.current.action.isError).toBe(true));
      expect(h.result.current.action.isSuccess).toBe(false);
      expect((h.result.current.action.error as AdapterError).category).toBe("forbidden");
      failure = err("SESSION_EXPIRED", { executionCertainty: "notApplied" });
      await act(async () => void (await h.result.current.action.mutateAsync({ ...anyInput, payload: { n: 9 } }).catch(() => undefined)));
      await waitFor(() => expect(h.result.current.view.data).toBeUndefined());
    });
    rule("AUTH-3", "an expired session reads as unauthenticated and a missing grant as forbidden, neither retryable", t.unauthenticated !== undefined && t.forbidden !== undefined, async () => {
      const expired = await rejection(t.unauthenticated!().readView(readReq()));
      expect(expired.category).toBe("unauthenticated");
      expect(expired.body.retryable).toBe(false);
      const denied = await rejection(t.forbidden!().readView(readReq()));
      expect(denied.category).toBe("forbidden");
      expect(denied.body.retryable).toBe(false);
    });

    // -- Unavailable backend: honest pending state, never demo data ----
    rule("PENDING-1", "an unavailable backend rejects the read as unavailable (SOURCE_UNAVAILABLE or INTEGRATION_PENDING) and returns no data", t.unavailable !== undefined, async () => {
      const req = readReq();
      const error = await rejection(t.unavailable!().readView(req));
      expect(error.category).toBe("unavailable");
      expect(["SOURCE_UNAVAILABLE", "INTEGRATION_PENDING"]).toContain(error.body.code);
      expect(error.body.requestId).toBe(req.requestId);
      expect(error.message.trim()).not.toBe("");
    });
    rule("PENDING-2", "useView shows an error and no data for an unavailable backend", t.unavailable !== undefined, async () => {
      const h = hookHarness(t.unavailable!(), t.scope, () => useView<object, unknown>(t.read.viewKey, t.read.filters ?? {}));
      await waitFor(() => expect(h.result.current.isError).toBe(true));
      expect(h.result.current.data).toBeUndefined();
      expect((h.result.current.error as AdapterError).category).toBe("unavailable");
      for (const q of h.qc.getQueryCache().getAll()) expect(q.state.data).toBeUndefined();
    });
    // Only a live adapter can fall back to demo data; a demo adapter serves it by design and labels it (IDENT-1, IDENT-2).
    if (t.kind === "live")
    rule("PENDING-3", "a live adapter never answers a demo view from demo data", t.unavailable !== undefined, async () => {
      const adapter = t.unavailable!();
      expect(adapter.kind).toBe("live");
      for (const viewKey of DEMO_VIEW_KEYS) {
        const error = await rejection(adapter.readView(readRequest(t.scope, { viewKey, filters: { approvalId: "demo-approval-exact", creatorId: "c", evidenceId: "demo-evidence-1" } })));
        expect(error.category, viewKey).toBe("unavailable");
      }
    });
    rule("PENDING-4", "unavailable actions and saves reject as unavailable with executionCertainty notApplied, never as success", t.unavailableWrites !== undefined, async () => {
      const adapter = t.unavailableWrites!();
      const action = await rejection(adapter.submitAction(decideRequest(t, a ?? { approvalRef: "r", version: "v1", approvePayload: {}, altPayload: {} })));
      expect(action.category).toBe("unavailable");
      expect(action.body.executionCertainty).toBe("notApplied");
      const save = await rejection(adapter.saveResource(saveRequest(t, s ?? { resourceKind: "actionDraft", resourceRef: "r", version: "v1", changedPayload: {} })));
      expect(save.category).toBe("unavailable");
      expect(save.body.executionCertainty).toBe("notApplied");
    });

    // -- Known zero, unknown and N/A through the contract ----
    const vs = t.valueStates;
    rule("VALUE-5", "a known zero stays a known 0 in adapter data, and every value node parses strictly", vs !== undefined, async () => {
      const res = await vs!.knownZero.create().readView(readRequest(t.scope, vs!.knownZero.read));
      const nodes = provenanceNodes(res.data);
      expect(nodes.length).toBeGreaterThan(0);
      for (const n of nodes) expectStrict(provenanceValueSchema(z.unknown()), n);
      expect(nodes.some((n) => n.state === "known" && (n.value === 0 || (n.value as { minorUnits?: number } | null)?.minorUnits === 0))).toBe(true);
    });
    rule("VALUE-6", "an unknown value stays null with a reason and is never turned into 0", vs !== undefined, async () => {
      const res = await vs!.unknown.create().readView(readRequest(t.scope, vs!.unknown.read));
      const nodes = provenanceNodes(res.data);
      for (const n of nodes) expectStrict(provenanceValueSchema(z.unknown()), n);
      const unknown = nodes.filter((n) => n.state === "unknown" || n.state === "notApplicable");
      expect(unknown.length).toBeGreaterThan(0);
      for (const n of unknown) {
        expect(n.value).toBeNull();
        expect(n.reasonCode).toBeTruthy();
      }
    });

    rule("VALUE-7", "a not-applicable value stays null with a reason and is distinct from unknown and zero", vs?.notApplicable !== undefined, async () => {
      const res = await vs!.notApplicable!.create().readView(readRequest(t.scope, vs!.notApplicable!.read));
      const nodes = provenanceNodes(res.data);
      for (const n of nodes) expectStrict(provenanceValueSchema(z.unknown()), n);
      const na = nodes.filter((n) => n.state === "notApplicable");
      expect(na.length).toBeGreaterThan(0);
      for (const n of na) {
        expect(n.value).toBeNull();
        expect(n.reasonCode).toBeTruthy();
      }
    });

    // -- Writes: idempotency ----
    rule("IDEM-1", "an action without an idempotency key is refused as a validation error and applies nothing", a !== undefined, async () => {
      const adapter = t.create();
      for (const idempotencyKey of ["", "   "]) {
        const error = await rejection(adapter.submitAction(decideRequest(t, a!, { idempotencyKey })));
        expect(error.category).toBe("validation");
        expect(error.body.executionCertainty).toBe("notApplied");
      }
      await expect(adapter.submitAction(decideRequest(t, a!))).resolves.toBeDefined();
    });
    rule("IDEM-2", "repeating an action with the same key returns the first answer", a !== undefined, async () => {
      const adapter = t.create();
      const req = decideRequest(t, a!);
      const first = await adapter.submitAction(req);
      const again = await adapter.submitAction({ ...req, requestId: next("conf-retry") });
      expect({ ...again, requestId: first.requestId }).toEqual(first);
    });
    rule("IDEM-3", "the same key with a changed payload is refused, not answered with the first result", a !== undefined, async () => {
      const adapter = t.create();
      const req = decideRequest(t, a!);
      await adapter.submitAction(req);
      const error = await rejection(adapter.submitAction({ ...req, payload: a!.altPayload, requestId: next("conf-alt") }));
      expect(error.category).toBe("conflict");
      expect(error.body.executionCertainty).toBe("notApplied");
    });
    rule("IDEM-4", "a save without an idempotency key is refused as a validation error and saves nothing", s !== undefined, async () => {
      const adapter = t.create();
      const error = await rejection(adapter.saveResource(saveRequest(t, s!, { idempotencyKey: "" })));
      expect(error.category).toBe("validation");
      expect(error.body.executionCertainty).toBe("notApplied");
      await expect(adapter.saveResource(saveRequest(t, s!))).resolves.toBeDefined();
    });
    rule("IDEM-5", "repeating a save with the same key returns the first answer and does not bump the version again", s !== undefined, async () => {
      const adapter = t.create();
      const req = saveRequest(t, s!);
      const first = await adapter.saveResource(req);
      const again = await adapter.saveResource({ ...req, requestId: next("conf-retry") });
      expect({ ...again, requestId: first.requestId }).toEqual(first);
      expect(again.resourceVersion).toBe(first.resourceVersion);
    });

    // -- Writes: stale version ----
    rule("VER-1", "a stale expected version is a recoverable STALE_VERSION conflict that applies nothing", a !== undefined, async () => {
      const adapter = t.create();
      const error = await rejection(adapter.submitAction(decideRequest(t, a!, { expectedVersion: "conformance-stale-version" })));
      expect(error.body.code).toBe("STALE_VERSION");
      expect(error.category).toBe("conflict");
      expect(error.body.retryable).toBe(false);
      expect(error.body.executionCertainty).toBe("notApplied");
      expect(typeof error.body.currentVersion).toBe("string");
      const recovered = await adapter.submitAction(decideRequest(t, a!, { expectedVersion: error.body.currentVersion! }));
      expect(recovered.receiptRefs).toEqual([]);
    });
    rule("VER-2", "a stale expected version on a save is a recoverable STALE_VERSION conflict that saves nothing", s !== undefined, async () => {
      const adapter = t.create();
      const error = await rejection(adapter.saveResource(saveRequest(t, s!, { expectedVersion: "conformance-stale-version" })));
      expect(error.body.code).toBe("STALE_VERSION");
      expect(error.category).toBe("conflict");
      expect(error.body.executionCertainty).toBe("notApplied");
      expect(typeof error.body.currentVersion).toBe("string");
      const recovered = await adapter.saveResource(saveRequest(t, s!, { expectedVersion: error.body.currentVersion! }));
      expect(recovered.resourceRef).toBe(s!.resourceRef);
    });

    // -- Approved is not Sent ----
    rule("SENT-1", "an approval carries no source receipt and no success-as-sent state", a !== undefined, async () => {
      const res = await t.create().submitAction(decideRequest(t, a!));
      expect(claimsSent(res)).toBe(false);
      expect(res.receiptRefs).toEqual([]);
      expect(["running", "reconciling"]).not.toContain(res.state);
    });
    rule("SENT-2", "dispatch before approval is refused as an approval hold and sends nothing", a !== undefined, async () => {
      const error = await rejection(t.create().submitAction(dispatchRequest(t, a!)));
      expect(error.category).toBe("approvalHold");
      expect(error.body.executionCertainty).toBe("notApplied");
    });
    rule("SENT-3", "after approval, dispatch reads as sent only with a source receipt", a !== undefined, async () => {
      const adapter = t.create();
      await adapter.submitAction(decideRequest(t, a!));
      const res = await adapter.submitAction(dispatchRequest(t, a!));
      expectStrict(actionResponseSchema, res);
      expect(claimsSentWithoutReceipt(res)).toBe(false);
      if (claimsSent(res)) expect(res.receiptRefs.length).toBeGreaterThan(0);
    });
    rule("SENT-4", "a dispatch with an unknown outcome is not reported as sent and holds no receipt", a?.uncertainApprovalRef !== undefined, async () => {
      const adapter = t.create();
      const u = { ...a!, approvalRef: a!.uncertainApprovalRef! };
      await adapter.submitAction(decideRequest(t, u));
      const res = await adapter.submitAction(dispatchRequest(t, u));
      expect(res.state).toBe("outcomeUncertain");
      expect(res.receiptRefs).toEqual([]);
      expect(claimsSent(res)).toBe(false);
    });

    // A reason on a rule that was never registered is a typo, and would hide a missing scenario.
    for (const id of [...Object.keys(t.gaps ?? {}), ...Object.keys(t.knownFailures ?? {})])
      it(`config: "${id}" names a registered rule`, () => expect(registered.has(id), `${id} is not a rule id`).toBe(true));
  });
}
