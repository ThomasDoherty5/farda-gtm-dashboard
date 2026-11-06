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
  });
});
