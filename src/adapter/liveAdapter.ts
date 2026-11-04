import { z } from "zod";
import type { FardaAdapter, ReadOptions } from "./adapter";
import {
  actionResponseSchema,
  readResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type Environment,
  type ReadRequest,
  type ReadResponse,
  type RequestedScope,
  type SaveResourceRequest,
  type SaveResourceResponse,
  type VerifiedScope,
} from "./contract";
import { AdapterError, categorize, type AdapterErrorBody, type ErrorCategory } from "./errors";
import { pendingTransport, TransportFailure, type Transport, type TransportRequest } from "./transport";
import { adapterErrorBodySchema, saveResourceResponseSchema } from "./wire";
import { viewSchemas, type ViewSchemas } from "./viewSchemas";

/**
 * The live adapter (THO-283, front-end half). It carries typed envelopes over an injected `Transport` and checks every
 * answer before a screen sees it. It never falls back to demo data, keeps no token, cookie or secret, and invents no URL:
 * the host supplies the transport, which owns the address and the session. With no transport it answers INTEGRATION_PENDING.
 *
 * What it guarantees, and what only the server can: docs/live-adapter.md.
 */
export type LiveAdapterOptions = {
  /** Supplied by the host. Defaults to one that sends nothing and answers INTEGRATION_PENDING. */
  transport?: Transport;
  /** How long one attempt may take before it counts as a timeout. */
  timeoutMs?: number;
  /** Total attempts for a write that may not have reached the server. Every attempt carries the same idempotency key. */
  writeAttempts?: number;
  retryDelayMs?: number;
  /**
   * The schema for each view's data, by view key. A read whose data is present is checked against its key's schema, and a
   * key with no schema is rejected, because an answer the app cannot check is not shown. Defaults to the registry.
   */
  viewSchemas?: ViewSchemas;
};

const DEFAULTS = { timeoutMs: 30_000, writeAttempts: 2, retryDelayMs: 300 };

type Kind = TransportRequest["kind"];
const isWrite = (kind: Kind) => kind !== "read";

export function createLiveAdapter(environment: Exclude<Environment, "demo">, options: LiveAdapterOptions = {}): FardaAdapter {
  const transport = options.transport ?? pendingTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const writeAttempts = Math.max(1, options.writeAttempts ?? DEFAULTS.writeAttempts);
  const retryDelayMs = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
  const readSchema = readResponseSchema(z.unknown());
  const schemas = options.viewSchemas ?? viewSchemas;

  async function exchange(req: TransportRequest, callerSignal: AbortSignal | undefined): Promise<unknown> {
    const attempts = isWrite(req.kind) ? writeAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(callerSignal);
      try {
        return await attemptOnce(transport, req, timeoutMs, callerSignal);
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason ?? abortError();
        const failure = fromFailure(error, req);
        if (attempt < attempts && mayRetry(error)) {
          await sleep(retryDelayMs, callerSignal);
          continue;
        }
        throw failure;
      }
    }
  }

  return {
    environment,
    kind: "live",

    async readView<F, T>(request: ReadRequest<F>, opts?: ReadOptions): Promise<ReadResponse<T>> {
      refuseForeignEnvironment(environment, request.requestedScope, request.requestId, false);
      const raw = await exchange({ kind: "read", envelope: request as ReadRequest<unknown> }, opts?.signal);
      const parsed = readSchema.safeParse(raw);
      if (!parsed.success || !hasKey(raw, "data")) throw unreadable(request.requestId, false);
      const res = parsed.data;
      if (res.requestId !== request.requestId) throw unreadable(request.requestId, false);
      if (!sameScope(res.scope, request.requestedScope)) throw scopeMismatch(request.requestId, false);
      // Empty, denied and pending answers carry no data and nothing to check. Anything else must fit its view's schema.
      if (res.data !== null && res.data !== undefined) {
        const schema = schemas[request.viewKey];
        if (!schema) throw unreadable(request.requestId, false);
        const checked = schema.safeParse(res.data);
        if (!checked.success) throw unreadable(request.requestId, false);
        return { ...res, data: checked.data } as ReadResponse<T>;
      }
      return res as ReadResponse<T>;
    },

    async submitAction<P>(request: ActionRequest<P>, opts?: ReadOptions): Promise<ActionResponse> {
      refuseForeignEnvironment(environment, request.requestedScope, request.requestId, true);
      requireKey(request);
      const raw = await exchange({ kind: "action", envelope: request as ActionRequest<unknown> }, opts?.signal);
      const parsed = actionResponseSchema.safeParse(raw);
      // A replay of the same idempotency key returns the first answer, so a write's requestId may be the original's.
      if (!parsed.success) throw unreadable(request.requestId, true);
      const res = parsed.data;
      if (!sameScope(res.scope, request.requestedScope)) throw scopeMismatch(request.requestId, true);
      assertAuthoritative(request, res);
      return res;
    },

    async saveResource<P, T>(request: SaveResourceRequest<P>, opts?: ReadOptions): Promise<SaveResourceResponse<T>> {
      refuseForeignEnvironment(environment, request.requestedScope, request.requestId, true);
      requireKey(request);
      const raw = await exchange({ kind: "save", envelope: request as SaveResourceRequest<unknown> }, opts?.signal);
      const parsed = saveResourceResponseSchema.safeParse(raw);
      if (!parsed.success || !hasKey(raw, "record")) throw unreadable(request.requestId, true);
      const res = parsed.data;
      if (!sameScope(res.scope, request.requestedScope)) throw scopeMismatch(request.requestId, true);
      if (request.resourceRef !== null && res.resourceRef !== request.resourceRef) throw unreadable(request.requestId, true);
      return res as SaveResourceResponse<T>;
    },
  };
}

// ---- One attempt, bounded in time -------------------------------------------------------------------

/** Sends once. Resolves the raw body, or rejects with whatever the transport raised, or a timeout, or the caller's abort. */
function attemptOnce(transport: Transport, req: TransportRequest, timeoutMs: number, callerSignal: AbortSignal | undefined): Promise<unknown> {
  const controller = new AbortController();
  return new Promise<unknown>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      fn();
    };
    const timer = setTimeout(() => {
      controller.abort(new TransportFailure("timeout"));
      finish(() => reject(new TransportFailure("timeout")));
    }, timeoutMs);
    const onCallerAbort = () => {
      controller.abort(callerSignal?.reason);
      finish(() => reject(callerSignal?.reason ?? abortError()));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) return onCallerAbort();
    transport.send(req, { signal: controller.signal }).then(
      (body) => finish(() => resolve(body)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** A write may be retried only when the first attempt might not have reached the server, or the server said it was down. */
function mayRetry(error: unknown): boolean {
  if (!(error instanceof TransportFailure)) return true;
  if (error.kind === "network" || error.kind === "timeout") return true;
  if (error.kind === "http") return (error.status ?? 0) >= 500;
  return false;
}

// ---- Failures -> AdapterError -----------------------------------------------------------------------

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Your session has ended. Sign in again to continue.",
  SESSION_EXPIRED: "Your session has expired. Sign in again to continue.",
  FORBIDDEN: "You don't have access to this.",
  SOURCE_AUTHORITY_DENIED: "You don't have access to this.",
  RECORD_NOT_FOUND: "That record could not be found.",
  RATE_LIMITED: "The service is busy. Try again shortly.",
  SOURCE_UNAVAILABLE: "The data service could not be reached.",
  TIMEOUT: "The data service took too long to answer.",
  INTEGRATION_PENDING: "The live data service is not connected yet.",
  VALIDATION_FAILED: "The service did not accept that request.",
  OUTCOME_UNCERTAIN: "The service did not confirm what happened.",
};
const message = (code: string) => MESSAGES[code] ?? "The service could not complete that request.";

/** Categories whose server text is replaced by a fixed neutral message, so a denial never says what exists. */
const NEUTRAL: ErrorCategory[] = ["unauthenticated", "forbidden"];
/** Categories a retry cannot fix. */
const NEVER_RETRYABLE: ErrorCategory[] = ["unauthenticated", "forbidden", "conflict", "validation", "notFound", "approvalHold", "capabilityHold", "resourceHold"];

function fromFailure(error: unknown, req: TransportRequest): AdapterError {
  const write = isWrite(req.kind);
  const requestId = req.envelope.requestId;
  const failure = error instanceof TransportFailure ? error : new TransportFailure("network");
  // Without a word from the server, a write that may have been sent is of unknown outcome.
  const unknownOutcome = write && failure.requestSent;
  const certainty = (c: AdapterErrorBody["executionCertainty"]) => (write ? (c ?? (unknownOutcome ? "uncertain" : "notApplied")) : undefined);

  const build = (code: string, extra: Partial<AdapterErrorBody> = {}) => {
    const category = categorize(code);
    const retryable = NEVER_RETRYABLE.includes(category) ? false : (extra.retryable ?? (category === "unavailable" || category === "rateLimited"));
    return new AdapterError({
      code,
      message: NEUTRAL.includes(category) ? message(code) : (extra.message ?? message(code)),
      requestId,
      correlationId: extra.correlationId ?? null,
      retryable,
      retryAfterMs: extra.retryAfterMs ?? failure.retryAfterMs,
      ...(extra.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}),
      ...(extra.currentVersion !== undefined ? { currentVersion: extra.currentVersion } : {}),
      ...(write ? { executionCertainty: extra.executionCertainty ?? certainty(undefined) } : {}),
    });
  };

  if (failure.kind === "notConfigured") {
    const text = { read: message("INTEGRATION_PENDING"), action: "The live action service is not connected yet. Nothing was sent.", save: "The live save service is not connected yet. Nothing was saved." }[req.kind];
    return build("INTEGRATION_PENDING", { message: text, retryable: false, executionCertainty: "notApplied" });
  }
  if (failure.kind === "timeout") return build("TIMEOUT", { retryable: true });
  if (failure.kind === "aborted" || failure.kind === "network") return build("SOURCE_UNAVAILABLE", { retryable: true });

  // An answer with a non-success status. Prefer the server's typed body, but let the status keep a denial a denial.
  const status = failure.status ?? 0;
  const typed = adapterErrorBodySchema.safeParse(failure.body);
  const body = typed.success ? typed.data : null;
  const known = body && categorize(body.code) !== "unknown" ? body : null;
  const extra: Partial<AdapterErrorBody> = known
    ? {
        message: known.message ? redact(known.message) : undefined,
        correlationId: known.correlationId ? redact(known.correlationId) : null,
        retryable: known.retryable,
        retryAfterMs: known.retryAfterMs ?? failure.retryAfterMs,
        fieldErrors: known.fieldErrors ? Object.fromEntries(Object.entries(known.fieldErrors).map(([k, v]) => [k, redact(v)])) : undefined,
        currentVersion: known.currentVersion,
        executionCertainty: known.executionCertainty,
      }
    : {};
  const codeIs = (...cats: ErrorCategory[]) => (known && cats.includes(categorize(known.code)) ? known.code : null);

  if (status === 401) return build(codeIs("unauthenticated") ?? "UNAUTHENTICATED", { ...extra, executionCertainty: "notApplied" });
  if (status === 403) return build(codeIs("forbidden") ?? "FORBIDDEN", { ...extra, executionCertainty: "notApplied" });
  if (status === 404) return build(codeIs("notFound") ?? "RECORD_NOT_FOUND", { ...extra, executionCertainty: extra.executionCertainty ?? "notApplied" });
  if (status === 429) return build(codeIs("rateLimited") ?? "RATE_LIMITED", { ...extra, retryable: true, executionCertainty: extra.executionCertainty ?? "notApplied" });
  if (status >= 500 || status === 0) return build(known && categorize(known.code) !== "unauthenticated" && categorize(known.code) !== "forbidden" ? known.code : "SOURCE_UNAVAILABLE", { ...extra, retryable: extra.retryable ?? true });
  // Any other refusal. The server's typed code is used when it has one; otherwise the request was simply not accepted.
  return build(known && !NEUTRAL.includes(categorize(known.code)) ? known.code : "VALIDATION_FAILED", { ...extra, executionCertainty: extra.executionCertainty ?? "notApplied" });
}

/** Credential-shaped text is cut out of anything the server says before it can reach a screen or a log. */
export function redact(text: string): string {
  return text
    .replace(/\b(?:bearer|basic)\s+[\w.~+/=-]+/gi, "[redacted]")
    .replace(/\b(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|session[_-]?id)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .slice(0, 300);
}

// ---- Checks on a successful answer ------------------------------------------------------------------

/** What no screen may show as done, whatever the body says. Approved is not Sent. */
function assertAuthoritative(request: ActionRequest<unknown>, res: ActionResponse) {
  const claimsSent = res.state === "succeeded" || res.state === "partiallySucceeded";
  if (claimsSent && res.receiptRefs.length === 0)
    throw uncertain(request.requestId, "The service reported success without a source receipt, so it is not shown as done.");
  const decidesOnly = request.operation === "previewAction" || request.operation === "requestApproval" || request.operation === "decideApproval";
  if (decidesOnly && (claimsSent || res.state === "running"))
    throw uncertain(request.requestId, "An approval is not a send. The service's answer was not shown as done.");
}

function refuseForeignEnvironment(adapterEnvironment: Environment, scope: RequestedScope, requestId: string, write: boolean) {
  if (scope.environment === adapterEnvironment) return;
  throw new AdapterError({
    code: "FORBIDDEN",
    message: `This adapter serves ${adapterEnvironment} only.`,
    requestId,
    correlationId: null,
    retryable: false,
    retryAfterMs: null,
    ...(write ? { executionCertainty: "notApplied" as const } : {}),
  });
}

function requireKey(request: { idempotencyKey: string; requestId: string }) {
  if (typeof request.idempotencyKey === "string" && request.idempotencyKey.trim() !== "") return;
  throw new AdapterError({
    code: "VALIDATION_FAILED",
    message: "A write needs an idempotency key. Nothing was sent.",
    requestId: request.requestId,
    correlationId: null,
    retryable: false,
    retryAfterMs: null,
    executionCertainty: "notApplied",
    fieldErrors: { idempotencyKey: "An idempotency key is required." },
  });
}

function sameScope(verified: VerifiedScope, requested: RequestedScope) {
  return (
    verified.workspaceId === requested.workspaceId &&
    verified.environment === requested.environment &&
    [...verified.accountIds].sort().join(",") === [...requested.accountIds].sort().join(",")
  );
}

/** A body that is not the contract's shape. Reads show no data. A write's outcome is then unknown, never success. */
function unreadable(requestId: string, write: boolean) {
  return write
    ? uncertain(requestId, "The service's answer could not be read, so what happened is unconfirmed.")
    : new AdapterError({ code: "SOURCE_UNAVAILABLE", message: "The data service sent an answer this app cannot read. No data is shown.", requestId, correlationId: null, retryable: false, retryAfterMs: null });
}

function scopeMismatch(requestId: string, write: boolean) {
  return new AdapterError({
    code: "FORBIDDEN",
    message: "The answer was for a different workspace, account or environment, so it was discarded.",
    requestId,
    correlationId: null,
    retryable: false,
    retryAfterMs: null,
    ...(write ? { executionCertainty: "uncertain" as const } : {}),
  });
}

function uncertain(requestId: string, text: string) {
  return new AdapterError({ code: "OUTCOME_UNCERTAIN", message: text, requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "uncertain" });
}

const hasKey = (value: unknown, key: string) => typeof value === "object" && value !== null && key in value;

function abortError() {
  return new DOMException("The request was cancelled.", "AbortError");
}
function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? abortError();
}
function sleep(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? abortError()); }, { once: true });
  });
}
