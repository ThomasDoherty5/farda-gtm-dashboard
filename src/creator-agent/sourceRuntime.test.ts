// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { digest } from "./config.ts";
import { loadCreatorSourceRuntime } from "./sourceRuntime.ts";
import { assetTestScope } from "./assetTestFixtures.ts";

describe("private source launcher configuration", () => {
  it("preserves the unconfigured launcher and holds access without credentials", async () => {
    expect(loadCreatorSourceRuntime({}, assetTestScope).portfolioAuthority).toBeUndefined();
    expect(loadCreatorSourceRuntime({}, assetTestScope).stockSupportSource).toBeUndefined();
    const source = loadCreatorSourceRuntime({ FARDA_ASSET_SOURCE_CONFIG: JSON.stringify({ contentDataSourceId: "00000000-0000-4000-8000-000000000001", collaborationDataSourceId: "00000000-0000-4000-8000-000000000002" }) }, assetTestScope);
    await expect(source.assetRegistryReader!(assetTestScope, { registry: "content" })).rejects.toMatchObject({ code: "SOURCE_ACCESS_UNAVAILABLE" });
  });
  it("rejects invalid private settings with a redacted error", () => {
    expect(() => loadCreatorSourceRuntime({ FARDA_ASSET_SOURCE_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_ASSET_SOURCE_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ FARDA_PORTFOLIO_SOURCE_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_PORTFOLIO_SOURCE_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ FARDA_PROVIDER_HEALTH_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_PROVIDER_HEALTH_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ FARDA_STOCK_SUPPORT_SOURCE_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_STOCK_SUPPORT_SOURCE_CONFIG is invalid.");
  });
  it("binds registry health to private exact-scope read configuration without granting access or activation", async () => {
    const target = { registry: "content", ownerRef: "owner:synthetic-operator", maxAgeSeconds: 300, documentationCheckedAt: "2026-11-05T00:00:00.000Z",
      binding: { ...assetTestScope, environment: "sandbox", provider: "notion", providerAccountId: "synthetic-notion-account", action: "read-content-registry",
        mode: "observe", route: "api", routeRef: "route:synthetic-content-reader", authorizationScopeVersion: "synthetic-auth-v1", toolVersion: "synthetic-tool-v1",
        requiredScopes: ["content:read"], connectionRef: null, secretRef: null } };
    const env = { FARDA_PROVIDER_HEALTH_CONFIG: JSON.stringify({ notionRegistryTargets: [target] }) };
    const unconfigured = loadCreatorSourceRuntime(env, assetTestScope);
    expect(unconfigured.providerHealth!.catalog).toHaveLength(1);
    expect(unconfigured.providerHealth!.catalog[0]!.probe).toBeUndefined();
    expect(unconfigured.providerHealth!.activationRef).toBeUndefined();
    const configured = loadCreatorSourceRuntime({ ...env, FARDA_ASSET_SOURCE_CONFIG: JSON.stringify({ contentDataSourceId: "00000000-0000-4000-8000-000000000001",
      collaborationDataSourceId: "00000000-0000-4000-8000-000000000002" }) }, assetTestScope);
    const held = await configured.providerHealth!.catalog[0]!.probe!(new AbortController().signal);
    expect(held).toMatchObject({ status: "missing_access", permission: "unknown", roleScopePlan: "unknown", sourceLastSuccess: null });
    expect(() => loadCreatorSourceRuntime({ FARDA_PROVIDER_HEALTH_CONFIG: JSON.stringify({ notionRegistryTargets: [{ ...target,
      binding: { ...target.binding, accountId: "synthetic-foreign-account" } }] }) }, assetTestScope)).toThrow("FARDA_PROVIDER_HEALTH_CONFIG is invalid.");
  });
  it("binds stock/support to explicit private mirrors without granting source access or inventory authority", async () => {
    const ids = { stockDataSourceId: "00000000-0000-4000-8000-000000000001", supportDataSourceId: "00000000-0000-4000-8000-000000000002" };
    const env = { FARDA_STOCK_SUPPORT_SOURCE_CONFIG: JSON.stringify(ids), FARDA_AGENT_READ_TOKEN: "synthetic-source-reference-key-000000000000" };
    const runtime = loadCreatorSourceRuntime(env, assetTestScope), scope = { ...assetTestScope, environment: "sandbox" as const };
    const binding = { scope, principalRef: "agent-reader" as const, operation: "read" as const, viewKey: "inventoryOverview" as const, requestDigest: digest({}) };
    const provider = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unconfigured source must not call a provider"));
    try {
      await expect(runtime.stockSupportSource!.readInventory(binding)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_UNCONFIGURED" });
      await expect(runtime.stockSupportSource!.readSupport({ ...binding, viewKey: "supportWorkspace" })).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_UNCONFIGURED" });
      await expect(runtime.stockSupportSource!.readSupport({ ...binding, viewKey: "supportWorkspace", scope: { ...scope, accountId: "synthetic-other-account" } })).rejects.toMatchObject({ code: "SOURCE_SCOPE_DENIED" });
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); }
    expect(() => loadCreatorSourceRuntime({ ...env, FARDA_AGENT_READ_TOKEN: "" }, assetTestScope)).toThrow("FARDA_STOCK_SUPPORT_SOURCE_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ ...env, FARDA_STOCK_SUPPORT_SOURCE_CONFIG: JSON.stringify({ ...ids, supportDataSourceId: ids.stockDataSourceId }) }, assetTestScope)).toThrow("FARDA_STOCK_SUPPORT_SOURCE_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ ...env, FARDA_STOCK_SUPPORT_SOURCE_CONFIG: JSON.stringify({ ...ids, permission: true }) }, assetTestScope)).toThrow("FARDA_STOCK_SUPPORT_SOURCE_CONFIG is invalid.");
  });
});
