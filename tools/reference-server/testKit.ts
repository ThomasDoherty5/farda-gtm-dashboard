/** Test helpers for the reference server. Tests only. */
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { createHttpTransport, type HttpTransportOptions } from "@/adapter/httpTransport";
import type { FardaAdapter } from "@/adapter/adapter";
import type { ReferenceServer } from "./server";

let stateSeq = 0;
/** A state name no other test shares, so a test starts from fresh fixture state. */
export const freshState = (prefix = "t") => `${prefix}-${++stateSeq}-${Math.random().toString(36).slice(2, 8)}`;

export type CookieFetch = typeof fetch & { cookie(): string; signedIn(): boolean; drop(): void };

/**
 * Node's fetch has no cookie jar, so this one holds the session cookie the way a browser would. It signs in lazily on the
 * first call (`user` omitted: never signs in, so every call is unauthenticated).
 */
export function cookieFetch(baseUrl: string, who: { user?: string; state?: string; fixture?: string } = {}): CookieFetch {
  let cookie = "";
  let started: Promise<void> | null = null;
  const signIn = async () => {
    const res = await fetch(`${baseUrl}/dev/sign-in?user=${who.user}&state=${who.state ?? freshState()}${who.fixture ? `&fixture=${who.fixture}` : ""}`, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    cookie = setCookie ? setCookie.split(";")[0]! : "";
  };
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (who.user && !started) started = signIn();
    await started;
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", cookie);
    return fetch(input, { ...init, headers, redirect: "manual" });
  }) as CookieFetch;
  wrapped.cookie = () => cookie;
  wrapped.signedIn = () => cookie !== "";
  wrapped.drop = () => { cookie = ""; };
  return wrapped;
}

export const liveOverHttp = (server: Pick<ReferenceServer, "url">, who: { user?: string; state?: string; fixture?: string } = { user: "founder" }, options: HttpTransportOptions = {}): FardaAdapter =>
  createLiveAdapter("sandbox", { transport: createHttpTransport(server.url, { fetch: cookieFetch(server.url, who), ...options }), retryDelayMs: 0 });
