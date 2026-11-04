/**
 * Test doubles for the Transport seam. Tests only: nothing in the app imports this file.
 * Statuses and body shapes here are the test's stand-in for a server; they are not a proposal for the real one.
 */
import type { FardaAdapter } from "./adapter";
import type { ActionRequest, ReadRequest, SaveResourceRequest } from "./contract";
import { AdapterError, type ErrorCategory } from "./errors";
import { TransportFailure, type Transport, type TransportRequest } from "./transport";

const STATUS: Partial<Record<ErrorCategory, number>> = {
  unauthenticated: 401, forbidden: 403, notFound: 404, validation: 422, conflict: 409, approvalHold: 409, capabilityHold: 409,
  resourceHold: 409, rateLimited: 429, unavailable: 503, outcomeUncertain: 502,
};

const roundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A "server" that answers with a demo adapter's answers, serialized as JSON. The demo adapter only serves the demo
 * environment, so the double rewrites the environment on the way in and out. That rewrite is the test double's, not the live adapter's.
 */
export function demoBackedTransport(demo: FardaAdapter, serves: "sandbox" | "production" = "sandbox", log: TransportRequest[] = []): Transport {
  const inbound = <S extends { requestedScope: object }>(env: S): S => ({ ...env, requestedScope: { ...env.requestedScope, environment: "demo" } });
  const outbound = <R extends { scope: { environment: string } }>(res: R): R => ({ ...res, scope: { ...res.scope, environment: serves } });
  return {
    async send(request, { signal }) {
      log.push(roundTrip(request));
      if (signal.aborted) throw signal.reason;
      try {
        const body = roundTrip(request.envelope);
        if (request.kind === "read") return roundTrip(outbound(await demo.readView(inbound(body as ReadRequest<unknown>), { signal })));
        if (request.kind === "action") return roundTrip(outbound(await demo.submitAction(inbound(body as ActionRequest<unknown>), { signal })));
        return roundTrip(outbound(await demo.saveResource(inbound(body as SaveResourceRequest<unknown>), { signal })));
      } catch (error) {
        if (error instanceof AdapterError)
          throw new TransportFailure("http", { status: STATUS[error.category] ?? 500, body: roundTrip(error.body), retryAfterMs: error.body.retryAfterMs });
        throw error;
      }
    },
  };
}

/** Answers every call with the same failure. */
export const failingTransport = (make: () => TransportFailure): Transport => ({ send: () => Promise.reject(make()) });

/** Answers every call with the given raw body, as if the server returned it. */
export const rawTransport = (body: unknown): Transport => ({ send: () => Promise.resolve(body) });

/** Never answers, and ignores the abort signal, like a transport that hangs. */
export const hangingTransport: Transport = { send: () => new Promise(() => undefined) };

/** Fails the first `times` calls with `make()`, then passes through to `next`. */
export function flakyTransport(next: Transport, times: number, make: () => TransportFailure): Transport & { calls: () => number } {
  let calls = 0;
  return { calls: () => calls, send: (r, o) => (++calls <= times ? Promise.reject(make()) : next.send(r, o)) };
}

/**
 * Delivers every request to `next` twice, as a retrying proxy would, and returns the second answer. The server must
 * treat the repeat as the same command.
 */
export const duplicatingTransport = (next: Transport): Transport => ({
  async send(r, o) {
    await next.send(r, o);
    return next.send(r, o);
  },
});

/**
 * The request reaches the server and is applied, but the answer is lost: the first call fails with a network error
 * after `next` has answered. Later calls pass through.
 */
export function lostAnswerTransport(next: Transport): Transport & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async send(r, o) {
      const n = ++calls;
      const answer = await next.send(r, o);
      if (n === 1) throw new TransportFailure("network");
      return answer;
    },
  };
}
