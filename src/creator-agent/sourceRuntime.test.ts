// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadCreatorSourceRuntime } from "./sourceRuntime.ts";
import { assetTestScope } from "./assetTestFixtures.ts";

describe("private source launcher configuration", () => {
  it("preserves the unconfigured launcher and holds access without credentials", async () => {
    expect(loadCreatorSourceRuntime({}, assetTestScope).portfolioAuthority).toBeUndefined();
    const source = loadCreatorSourceRuntime({ FARDA_ASSET_SOURCE_CONFIG: JSON.stringify({ contentDataSourceId: "00000000-0000-4000-8000-000000000001", collaborationDataSourceId: "00000000-0000-4000-8000-000000000002" }) }, assetTestScope);
    await expect(source.assetRegistryReader!(assetTestScope, { registry: "content" })).rejects.toMatchObject({ code: "SOURCE_ACCESS_UNAVAILABLE" });
  });
  it("rejects invalid private settings with a redacted error", () => {
    expect(() => loadCreatorSourceRuntime({ FARDA_ASSET_SOURCE_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_ASSET_SOURCE_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ FARDA_PORTFOLIO_SOURCE_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_PORTFOLIO_SOURCE_CONFIG is invalid.");
    expect(() => loadCreatorSourceRuntime({ FARDA_PROVIDER_HEALTH_CONFIG: "private-invalid-text" }, assetTestScope)).toThrow("FARDA_PROVIDER_HEALTH_CONFIG is invalid.");
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
});
