import type { FardaAdapter } from "./adapter";
import { createDemoAdapter } from "./demoAdapter";
import { createLiveAdapter } from "./liveAdapter";
import { overviewFixtureKeys, type OverviewFixtureKey } from "@/fixtures/overview";

/** Chooses the adapter from build-time config. An unknown value is a hard error, not a demo fallback. */
export function selectAdapter(env: { VITE_FARDA_ADAPTER?: string }, search = ""): FardaAdapter {
  const mode = env.VITE_FARDA_ADAPTER ?? "demo";
  if (mode === "demo") {
    const requested = new URLSearchParams(search).get("fixture");
    const fixture = overviewFixtureKeys.find((k) => k === requested || k.startsWith(`${requested}-`)) as OverviewFixtureKey | undefined;
    return createDemoAdapter({ fixture });
  }
  if (mode === "sandbox" || mode === "production") return createLiveAdapter(mode);
  throw new Error(`Unknown VITE_FARDA_ADAPTER "${mode}". Expected demo, sandbox or production.`);
}
