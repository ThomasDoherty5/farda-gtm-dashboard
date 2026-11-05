import { z } from "zod";
import { verifiedScopeSchema } from "./contract";
import type { Environment, RequestedScope } from "./contract";

/** Scope is supplied by an authenticated server, never query parameters or fixture IDs. */
export async function loadSessionScope(baseUrl: string, environment: Exclude<Environment, "demo">, request: typeof fetch = fetch): Promise<{ scope: RequestedScope; principal: string }> {
  const base = new URL(baseUrl);
  if (base.username || base.password || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) throw new Error("Invalid session origin");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await request(`${baseUrl.replace(/\/+$/, "")}/v1/session`, { credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    if (!response.ok) throw new Error("Authenticated session unavailable");
    const session = z.object({ scope: verifiedScopeSchema, principal: z.string().min(1) }).parse(await response.json());
    if (session.scope.environment !== environment || !session.scope.workspaceId || !session.scope.accountIds.length) throw new Error("Session scope mismatch");
    return { scope: { workspaceId: session.scope.workspaceId, accountIds: session.scope.accountIds, environment: session.scope.environment }, principal: session.principal };
  } finally { clearTimeout(timer); }
}
