// @vitest-environment node
import { expect, it } from "vitest";
import { createSiteTrafficImportApi } from "./siteTrafficApi.ts";
import { siteTrafficServerFixture, SYNTHETIC_TRAFFIC_MACHINE_TOKEN } from "./siteTrafficServerFixture.testkit.ts";
import { ApiRequestLimits } from "./apiRequestLimits.ts";

it("a committed import still requires current source authority immediately before publishing its receipt", async () => {
  const h = siteTrafficServerFixture(":memory:");
  try {
    const api = createSiteTrafficImportApi({ scope: h.bindings.scope, service: h.service, machine: h.machine,
      limits: new ApiRequestLimits(h.store.database, h.bindings.scope, () => h.state.now), now: () => h.state.now });
    const result = await api.execute(h.command, `Bearer ${SYNTHETIC_TRAFFIC_MACHINE_TOKEN}`);
    try {
      expect(result.receipt.inserted).toBe(2);
      h.state.denied = true;
      expect(() => result.assertCurrent()).toThrow("TRAFFIC_SOURCE_DENIED");
      expect(h.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n).toBe(1);
    } finally { result.dispose(); }
    h.state.denied = false;
    const original = await api.execute(h.command, `Bearer ${SYNTHETIC_TRAFFIC_MACHINE_TOKEN}`);
    try { original.assertCurrent(); expect(original.receipt).toEqual(result.receipt); expect(h.state.importReads).toBe(1); }
    finally { original.dispose(); }
  } finally { h.close(); }
});

it("credential rotation after the final source await suppresses publication without claiming the original import was absent", async () => {
  const h = siteTrafficServerFixture(":memory:");
  try {
    const api = createSiteTrafficImportApi({ scope: h.bindings.scope, service: h.service, machine: h.machine,
      limits: new ApiRequestLimits(h.store.database, h.bindings.scope, () => h.state.now), now: () => h.state.now });
    const result = await api.execute(h.command, `Bearer ${SYNTHETIC_TRAFFIC_MACHINE_TOKEN}`);
    try {
      h.machine.token = "rotated-fictional-machine-credential-only";
      expect(() => result.assertCurrent()).toThrow("TRAFFIC_MACHINE_REQUIRED");
      expect(h.store.database.prepare("SELECT COUNT(*) AS n FROM site_traffic_imports").get()?.n).toBe(1);
    } finally { result.dispose(); }
  } finally { h.close(); }
});
