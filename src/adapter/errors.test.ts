import { categorize, mustClearProtectedData } from "./errors";

describe("categorize", () => {
  it.each([
    ["SESSION_EXPIRED", "unauthenticated"],
    ["SOURCE_AUTHORITY_DENIED", "forbidden"],
    ["POLICY_VIOLATION", "validation"],
    ["MANIFEST_CHANGED", "conflict"],
    ["APPROVAL_EXPIRED", "approvalHold"],
    ["SOURCE_LOGIN_REQUIRED", "capabilityHold"],
    ["BUDGET_HOLD", "resourceHold"],
    ["RATE_LIMITED", "rateLimited"],
    ["TIMEOUT", "unavailable"],
    ["OUTCOME_UNCERTAIN", "outcomeUncertain"],
  ])("maps %s to %s", (code, category) => {
    expect(categorize(code)).toBe(category);
  });

  it("treats an unrecognized code as unknown rather than guessing", () => {
    expect(categorize("SOMETHING_NEW")).toBe("unknown");
  });
});

describe("mustClearProtectedData", () => {
  it("clears only on authentication and permission failures", () => {
    expect(mustClearProtectedData("unauthenticated")).toBe(true);
    expect(mustClearProtectedData("forbidden")).toBe(true);
    expect(mustClearProtectedData("unavailable")).toBe(false);
    expect(mustClearProtectedData("rateLimited")).toBe(false);
  });
});
