import { randomUUID } from "node:crypto";

/** Public error metadata only. Never serialize an arbitrary source exception, payload, identity or locator. */
export function apiErrorEnvelope(status: number, raw: unknown, requestId: string | null) {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const code = typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.code) ? value.code : "SOURCE_UNAVAILABLE";
  const certainty = ["notApplied", "applied", "uncertain"].includes(String(value.executionCertainty))
    ? value.executionCertainty as "notApplied" | "applied" | "uncertain" : status >= 500 ? "uncertain" : "notApplied";
  const message = status === 401 || status === 403 ? "Access is not currently permitted."
    : status === 429 ? "The request rate limit was reached."
    : certainty === "uncertain" ? "The original outcome is unconfirmed. Reconcile the same request."
    : status === 409 ? "The current source or approval does not permit this request."
    : status === 400 || status === 422 ? "The request did not match the supported contract."
    : "The service could not complete the request.";
  return { code, message, requestId, correlationId: randomUUID(),
    retryable: status === 429 || status >= 500 && certainty !== "uncertain",
    retryAfterMs: typeof value.retryAfterMs === "number" && Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0 ? value.retryAfterMs : null,
    executionCertainty: certainty,
    ...(![401, 403].includes(status) && (typeof value.currentVersion === "string" || value.currentVersion === null) ? { currentVersion: value.currentVersion } : {}),
    ...(![401, 403].includes(status) && value.fieldErrors && typeof value.fieldErrors === "object" && !Array.isArray(value.fieldErrors)
      ? { fieldErrors: Object.fromEntries(Object.entries(value.fieldErrors).filter(([key, field]) => /^[A-Za-z0-9_.-]{1,120}$/.test(key) && typeof field === "string" && field.length <= 500)) } : {}) };
}
