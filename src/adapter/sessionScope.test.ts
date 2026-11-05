import { loadSessionScope } from "./sessionScope";
const makeResponse = (scope: unknown, status = 200) => new Response(JSON.stringify({ scope, principal: "authenticated-reader" }), { status });
const scope = { workspaceId: "private-workspace", accountIds: ["private-account"], environment: "sandbox", authorizationScopeVersion: "v1" };

describe("authenticated session scope", () => {
  it("uses only a verified server scope and cookie credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(makeResponse(scope));
    expect(await loadSessionScope("http://127.0.0.1:8787", "sandbox", request)).toEqual({ scope, principal: "authenticated-reader" });
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:8787/v1/session", expect.objectContaining({ credentials: "include", cache: "no-store", redirect: "error" }));
  });
  it("rejects denied, absent and mismatched session scope without fixture fallback", async () => {
    await expect(loadSessionScope("https://example.com", "sandbox", vi.fn().mockResolvedValue(makeResponse(null, 401)))).rejects.toThrow();
    await expect(loadSessionScope("https://example.com", "sandbox", vi.fn().mockResolvedValue(makeResponse(null)))).rejects.toThrow();
    await expect(loadSessionScope("https://example.com", "production", vi.fn().mockResolvedValue(makeResponse(scope)))).rejects.toThrow("Session scope mismatch");
    await expect(loadSessionScope("https://example.com", "sandbox", vi.fn().mockResolvedValue(makeResponse({ ...scope, accountIds: [] })))).rejects.toThrow();
  });
  it("rejects embedded credentials and non-TLS remote origins before a request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(loadSessionScope("http://example.com", "sandbox", request)).rejects.toThrow("Invalid session origin");
    await expect(loadSessionScope("https://user:password@example.com", "sandbox", request)).rejects.toThrow("Invalid session origin");
    expect(request).not.toHaveBeenCalled();
  });
});
