import type { FardaAdapter } from "./adapter";
import { createDemoAdapter } from "./demoAdapter";
import { createLiveAdapter } from "./liveAdapter";
import type { Transport } from "./transport";
import type { Environment } from "./contract";
import { overviewFixtureKeys, type OverviewFixtureKey } from "@/fixtures/overview";

/**
 * What the host gives the live adapter. The host owns the address and the session, so it builds the transport.
 * `baseUrl` is the reserved VITE_FARDA_ADAPTER_BASE_URL, passed through untouched and never interpreted here.
 */
/** Returning nothing keeps the live adapter's default pending transport. */
export type TransportFactory = (config: { environment: Exclude<Environment, "demo">; baseUrl: string | null }) => Transport | undefined;

/** Chooses the adapter from build-time config. An unknown value is a hard error, not a demo fallback. */
export function selectAdapter(
  env: { VITE_FARDA_ADAPTER?: string; VITE_FARDA_ADAPTER_BASE_URL?: string },
  search = "",
  host: { createTransport?: TransportFactory } = {},
): FardaAdapter {
  const mode = env.VITE_FARDA_ADAPTER ?? "demo";
  if (mode === "demo") {
    const requested = new URLSearchParams(search).get("fixture");
    const fixture = overviewFixtureKeys.find((k) => k === requested || k.startsWith(`${requested}-`)) as OverviewFixtureKey | undefined;
    return createDemoAdapter({ fixture });
  }
  if (mode === "sandbox" || mode === "production") {
    // With no transport supplied the live adapter answers INTEGRATION_PENDING. Nothing falls back to demo data.
    const baseUrl = env.VITE_FARDA_ADAPTER_BASE_URL?.trim() || null;
    return createLiveAdapter(mode, { transport: host.createTransport?.({ environment: mode, baseUrl }) });
  }
  throw new Error(`Unknown VITE_FARDA_ADAPTER "${mode}". Expected demo, sandbox or production.`);
}
