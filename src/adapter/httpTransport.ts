import type { Transport, TransportRequest } from "./transport";
import { TransportFailure } from "./transport";
import type { TransportFactory } from "./selectAdapter";

/**
 * A real HTTP Transport for the live adapter (D-1 of docs/adapter-decisions.md). It carries the adapter's three envelopes
 * to three POST paths and reads the signed-in session from one GET path. The paths are decided defaults, not a published
 * contract: THO-283 may change them, and this file is the only place that names them.
 *
 * Nothing secret lives here. The session is an HttpOnly cookie the browser holds and this code cannot read. The per-session
 * CSRF token comes from the session call and is kept only in this closure: never in browser storage, never in a URL.
 */
export const DEFAULT_PATHS = { read: "/v1/read", action: "/v1/action", save: "/v1/save", session: "/v1/session" } as const;
export const CSRF_HEADER = "X-CSRF-Token";

export type HttpTransportOptions = {
  /** For tests. Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** The transport gives up waiting after this long. The live adapter has its own bound too. Default 30 s. */
  timeoutMs?: number;
  paths?: Partial<typeof DEFAULT_PATHS>;
};

/** Plain http is allowed only for a loopback host (local development). Anything else must be https. */
function normalizeBase(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("VITE_FARDA_ADAPTER_BASE_URL is not a valid URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("VITE_FARDA_ADAPTER_BASE_URL must be https (plain http is allowed only for localhost).");
  if (url.username || url.password) throw new Error("VITE_FARDA_ADAPTER_BASE_URL must not carry credentials.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createHttpTransport(baseUrl: string, options: HttpTransportOptions = {}): Transport {
  const base = normalizeBase(baseUrl);
  const paths = { ...DEFAULT_PATHS, ...options.paths };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  /** In memory only. Cleared when the server says the session is gone. */
  let csrf: Promise<string> | null = null;

  /** Runs one fetch bounded by the caller's signal and this transport's own timeout. */
  async function exchange(path: string, init: RequestInit, signal: AbortSignal): Promise<{ status: number; headers: Headers; json: unknown; readable: boolean }> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, { ...init, signal: controller.signal, credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
      let json: unknown = null;
      let readable = true;
      const text = await response.text();
      if (text !== "") {
        try { json = JSON.parse(text); } catch { readable = false; }
      }
      return { status: response.status, headers: response.headers, json, readable };
    } catch (error) {
      if (timedOut) throw new TransportFailure("timeout");
      if (signal.aborted) throw signal.reason instanceof TransportFailure ? signal.reason : new TransportFailure("aborted");
      if (error instanceof TransportFailure) throw error;
      throw new TransportFailure("network");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  const retryAfterOf = (headers: Headers, body: unknown): number | null => {
    if (isRecord(body) && typeof body.retryAfterMs === "number") return body.retryAfterMs;
    const seconds = Number(headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  };

  /** Statuses and typed bodies become TransportFailure, as `transportTestKit.ts` assumes. */
  const fail = (r: { status: number; headers: Headers; json: unknown }): never => {
    throw new TransportFailure("http", { status: r.status, body: r.json, retryAfterMs: retryAfterOf(r.headers, r.json) });
  };

  async function csrfToken(signal: AbortSignal): Promise<string> {
    if (!csrf) {
      const pending = exchange(paths.session, { method: "GET", headers: { accept: "application/json" } }, signal).then((r) => {
        if (r.status < 200 || r.status >= 300) fail(r);
        const token = isRecord(r.json) ? r.json.csrfToken : undefined;
        if (typeof token !== "string" || token === "") throw new TransportFailure("http", { status: 502, message: "The session answer carried no CSRF token." });
        return token;
      });
      csrf = pending;
      // A failed session call must not poison the next attempt.
      pending.catch(() => { if (csrf === pending) csrf = null; });
    }
    return csrf;
  }

  return {
    async send(request: TransportRequest, { signal }): Promise<unknown> {
      const write = request.kind !== "read";
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (write) {
        // If the session call fails, no write was put on the wire, so say so.
        try {
          headers[CSRF_HEADER] = await csrfToken(signal);
        } catch (error) {
          if (error instanceof TransportFailure) {
            throw new TransportFailure(error.kind, { status: error.status, body: error.body, retryAfterMs: error.retryAfterMs, requestSent: false, message: error.message });
          }
          throw error;
        }
      }
      const r = await exchange(paths[request.kind], { method: "POST", headers, body: JSON.stringify(request.envelope) }, signal);
      if (r.status === 401) csrf = null;
      if (r.status < 200 || r.status >= 300) return fail(r);
      // A 2xx whose body is not JSON resolves as null, so the live adapter reads it as unreadable and never as success.
      return r.readable ? r.json : null;
    },
  };
}

/**
 * The host's transport factory: the real HTTP transport when a base URL is set, and nothing otherwise, so the live adapter
 * keeps its honest pending transport. A malformed or non-https base URL is a startup error, not a silent fallback.
 */
export const httpTransportFactory: TransportFactory = ({ baseUrl }) => (baseUrl ? createHttpTransport(baseUrl) : undefined);
