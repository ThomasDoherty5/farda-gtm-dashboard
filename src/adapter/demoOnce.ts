import { AdapterError } from "./errors";

/**
 * Idempotency for demo services: the same key and payload returns the first result, and the same key with a changed
 * payload is refused, as the real server must.
 */
export function createOnce() {
  const seen = new Map<string, { hash: string; result: unknown }>();
  return function once<T>(key: string, hash: string, requestId: string, run: () => T): T {
    const prior = seen.get(key);
    if (prior && prior.hash !== hash) throw new AdapterError({ code: "MANIFEST_CHANGED", message: "This request changed, so it needs a fresh review.", requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
    if (prior) return prior.result as T;
    const result = run();
    seen.set(key, { hash, result });
    return result;
  };
}
