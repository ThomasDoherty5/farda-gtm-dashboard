import { EVENT_SCENARIOS, claimIsSupported, processEvents, type FlowEvent } from "./flowEvents";

const run = (key: string) => processEvents(EVENT_SCENARIOS.find((s) => s.key === key)!.events);
const results = (key: string) => run(key).outcomes.map((o) => o.result);

describe("FE12-05 event handling", () => {
  it("an eligible contact is enrolled once and sent once", () => {
    expect(results("eligible")).toEqual(["applied", "applied"]);
    expect(run("eligible").sends).toBe(1);
  });

  it("withdrawn consent mid-flow stops the flow, and nothing more is sent", () => {
    expect(results("withdrawn")).toEqual(["applied", "applied", "stopped"]);
    expect(run("withdrawn").sends).toBe(0);
    expect(run("withdrawn").outcomes[2]!.reason).toMatch(/Consent was withdrawn after enrollment/);
  });

  it("consent withdrawn after a send keeps that send and stops the rest", () => {
    const events: FlowEvent[] = [{ id: "a", kind: "enter", contact: "x" }, { id: "b", kind: "step", contact: "x" }, { id: "c", kind: "consentWithdrawn", contact: "x" }, { id: "d", kind: "step", contact: "x", entryKey: "other" }];
    const r = processEvents(events);
    expect(r.sends).toBe(1);
    expect(r.outcomes.at(-1)!.result).toBe("held");
  });

  it("a duplicate event id changes nothing", () => {
    expect(results("duplicate")).toEqual(["applied", "ignoredDuplicate", "applied"]);
    expect(run("duplicate").sends).toBe(1);
  });

  it("a replayed entry and step, with new ids, neither enroll nor send twice", () => {
    expect(results("replayed")).toEqual(["applied", "applied", "ignoredReplay", "ignoredReplay"]);
    expect(run("replayed").sends).toBe(1);
  });

  it("a step with no entry event is held for review, not guessed and not sent", () => {
    expect(results("missing")).toEqual(["held"]);
    expect(run("missing").sends).toBe(0);
  });

  it("an unsupported claim is blocked and a supported one is not", () => {
    expect(results("claim")).toEqual(["blocked", "applied"]);
    expect(claimIsSupported("Treats anxiety")).toBe(false);
    expect(claimIsSupported("Guaranteed results in a week")).toBe(false);
    expect(claimIsSupported("Pair your device in two minutes")).toBe(true);
  });

  it("an outage holds the send and recovery sends it once", () => {
    expect(results("outage")).toEqual(["applied", "applied", "held", "applied"]);
    expect(run("outage").sends).toBe(1);
  });

  it("a send held in an outage is not sent after recovery if consent was withdrawn meanwhile", () => {
    const events: FlowEvent[] = [{ id: "1", kind: "enter", contact: "x" }, { id: "2", kind: "providerOutage", contact: "x" }, { id: "3", kind: "step", contact: "x" }, { id: "4", kind: "consentWithdrawn", contact: "x" }, { id: "5", kind: "providerRecovered", contact: "x" }];
    expect(processEvents(events).sends).toBe(0);
  });
});
