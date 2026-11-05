import { resolve } from "node:path";

const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

/** Deployment values are read only by the server process, never baked into the client or image. */
export function readRuntimeConfig(env = process.env) {
  const host = env.FARDA_AGENT_HOST ?? "127.0.0.1";
  if (!allowedHosts.has(host)) throw new Error("FARDA_AGENT_HOST must be an explicit loopback or wildcard interface.");
  const rawPort = env.FARDA_AGENT_PORT ?? env.PORT ?? "8787";
  if (!/^\d+$/.test(rawPort)) throw new Error("Invalid agent port.");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid agent port.");
  const rawSecure = env.FARDA_AGENT_SECURE_COOKIES;
  if (rawSecure !== undefined && !["true", "false"].includes(rawSecure)) throw new Error("FARDA_AGENT_SECURE_COOKIES must be true or false.");
  const secureCookies = rawSecure === "true";
  let publicOrigin;
  if (env.FARDA_AGENT_ORIGIN !== undefined) {
    let origin;
    try { origin = new URL(env.FARDA_AGENT_ORIGIN); } catch { throw new Error("Invalid FARDA_AGENT_ORIGIN."); }
    const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((!localHttp && origin.protocol !== "https:") || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
      throw new Error("FARDA_AGENT_ORIGIN must be a credential-free HTTPS origin (HTTP is local-only).");
    publicOrigin = origin.origin;
  }
  if (!loopbackHosts.has(host) && (!publicOrigin?.startsWith("https:") || !secureCookies))
    throw new Error("A non-loopback agent requires an explicit HTTPS origin and secure cookies behind a trusted TLS proxy.");
  const databasePath = resolve(env.FARDA_AGENT_DATABASE ?? ".agent-data/evidence.sqlite");
  return { host, port, databasePath, publicOrigin, secureCookies };
}
