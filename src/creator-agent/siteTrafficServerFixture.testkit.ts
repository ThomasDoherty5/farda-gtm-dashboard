import type { AgentServerOptions } from "./server.ts";
import { digest } from "./config.ts";
import { SiteTrafficApiError, type SiteTrafficImportMachine } from "./siteTrafficApi.ts";
import { siteTrafficFixture } from "./siteTraffic/fixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";

export const SYNTHETIC_TRAFFIC_MACHINE_TOKEN = "fictional-site-traffic-machine-credential-only";

/** Real server composition, fictional source owners. Imports populate the server's own SQLite database. */
export function siteTrafficServerFixture(databasePath: string) {
  const fixture = siteTrafficFixture({ now: Date.now() });
  const scope = fixture.bindings.scope;
  const machineState = { checks: 0, beforeResolve: null as (() => void | Promise<void>) | null, beforeFence: null as (() => void) | null };
  const machine: SiteTrafficImportMachine = {
    token: SYNTHETIC_TRAFFIC_MACHINE_TOKEN,
    principal: structuredClone(fixture.machine),
    async resolve(requestedScope, input) {
      await machineState.beforeResolve?.();
      if (digest(requestedScope) !== digest(scope) || fixture.state.machineDenied) throw new SiteTrafficApiError("TRAFFIC_MACHINE_DENIED", 403);
      return { scope: structuredClone(scope), principal: structuredClone(machine.principal), inputHash: digest(input), proofRef: "ref:" + digest("fictional-machine-proof"),
        observedAt: new Date(fixture.state.now).toISOString(), validUntil: new Date(fixture.state.now + 120_000).toISOString() };
    },
    assertCurrent(proof) {
      machineState.checks++; machineState.beforeFence?.();
      if (fixture.state.machineDenied || digest(proof.principal) !== digest(machine.principal)) throw new SiteTrafficApiError("TRAFFIC_MACHINE_DENIED", 403);
    },
  };
  const options: AgentServerOptions = {
    databasePath, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    workspaceId: scope.workspaceId, accountId: scope.accountId,
    operations: { now: () => fixture.state.now },
    siteTraffic: { source: fixture.source, orders: fixture.orders, clicks: fixture.clicks, machine },
  };
  const command = { schemaVersion: "farda.site-traffic-import.v1" as const, requestedScope: scope, input: fixture.input };
  return { ...fixture, machine, machineState, options, command };
}
