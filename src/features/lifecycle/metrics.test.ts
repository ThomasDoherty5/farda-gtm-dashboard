import { activationDemo, consentDemo, FLOW_KEYS, emailFlows, TIMING_OPTIONS } from "@/fixtures/lifecycle";
import { validateFlowDraft } from "./flowDraft";
import { consentReconciles, consentSegments, percent } from "./metrics";

describe("percent", () => {
  it("derives a share from counts, to one decimal", () => {
    expect(percent(740, 1000)).toBe("74.0%");
    expect(percent(64, 86)).toBe("74.4%");
    expect(percent(86, 100)).toBe("86.0%");
  });
  it("is unknown, not 0%, when there is nothing to divide by", () => expect(percent(0, 0)).toBeNull());
  it("shows a known zero as 0.0%", () => expect(percent(0, 50)).toBe("0.0%"));
});

describe("consent categories", () => {
  it("are mutually exclusive and add up to every record", () => {
    expect(consentReconciles(consentDemo)).toBe(true);
    expect(consentSegments(consentDemo).reduce((n, s) => n + s.count, 0)).toBe(consentDemo.total);
  });

  it("never count unknown consent as eligible", () => {
    const segments = consentSegments(consentDemo);
    expect(segments.find((s) => s.key === "unknown")!.count).toBe(70);
    expect(segments.find((s) => s.key === "eligible")!.count).toBe(consentDemo.eligible);
    expect(consentDemo.eligible + consentDemo.unknown).not.toBe(consentDemo.eligible);
  });

  it("flag a snapshot that doesn't add up", () => expect(consentReconciles({ ...consentDemo, unknown: 71 })).toBe(false));
});

describe("fixtures", () => {
  it("keep the demo cohort ordered: delivered ≥ paired ≥ active in week one", () => {
    const c = activationDemo.cohort;
    expect(c.delivered).toBeGreaterThanOrEqual(c.paired);
    expect(c.paired).toBeGreaterThanOrEqual(c.weekOne);
  });

  it("give every flow six ordered steps, and a timing its own approved list allows", () => {
    for (const key of FLOW_KEYS) {
      expect(emailFlows[key].steps.map((s) => s.n)).toEqual(["01", "02", "03", "04", "05", "06"]);
      expect(TIMING_OPTIONS[key]).toContain(emailFlows[key].draft.timing);
      expect(validateFlowDraft(key, emailFlows[key].draft)).toEqual({});
    }
  });

  it("hold the early-access launch notice until a launch date is approved", () => {
    expect(emailFlows["early-access"].steps.find((s) => s.hold)?.title).toMatch(/approved launch date/);
  });
});

describe("flow draft validation", () => {
  const draft = { timing: "4 hours after checkout", template: "One checkout reminder" };
  it("refuses a timing outside the flow's approved list", () => {
    expect(validateFlowDraft("abandoned-checkout", { ...draft, timing: "5 minutes after checkout" }).timing).toBeDefined();
    expect(validateFlowDraft("review-request", { ...draft, timing: "4 hours after checkout" }).timing).toBeDefined();
  });
  it("refuses an empty, long or markup-bearing template name", () => {
    expect(validateFlowDraft("abandoned-checkout", { ...draft, template: " " }).template).toBeDefined();
    expect(validateFlowDraft("abandoned-checkout", { ...draft, template: "x".repeat(81) }).template).toBeDefined();
    expect(validateFlowDraft("abandoned-checkout", { ...draft, template: "<script>" }).template).toBeDefined();
  });
});
