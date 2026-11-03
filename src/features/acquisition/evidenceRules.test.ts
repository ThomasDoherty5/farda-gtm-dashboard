import { coveredSeconds, formatTime, parseTime, validateMediaUrl, validateObservation } from "./evidenceRules";
import type { Observation } from "./evidenceTypes";

const obs = (over: Partial<Observation> = {}): Observation => ({ id: "o", category: "hook", startSec: 0, endSec: 10, text: "x", recordedAgainst: "https://www.instagram.com/reel/AAA/", ...over });

describe("validateMediaUrl", () => {
  it.each([
    "https://www.instagram.com/reel/DEMOREEL001/",
    "https://instagram.com/p/DEMOPOST01",
    "https://www.tiktok.com/@demo.creator/video/1234567890123456789",
  ])("accepts the address of one video: %s", (url) => expect(validateMediaUrl(url)).toBeNull());

  it("leaves an empty address unknown rather than invalid", () => {
    expect(validateMediaUrl("")).toBeNull();
    expect(validateMediaUrl("   ")).toBeNull();
  });

  it.each(["https://www.instagram.com/demo.creator/", "https://www.tiktok.com/@demo.creator"])("rejects a profile, which isn't video evidence: %s", (url) => {
    expect(validateMediaUrl(url)).toMatch(/profile/);
  });

  it.each([
    ["http://www.instagram.com/reel/AAA/", /https/],
    ["https://user:pw@www.instagram.com/reel/AAA/", /login details/],
    ["https://example.com/video/1", /Only Instagram and TikTok/],
    ["not a url", /full address/],
    ["https://www.tiktok.com/discover", /isn't a single video/],
  ])("rejects %s", (url, message) => expect(validateMediaUrl(url)).toMatch(message));
});

describe("time and observations", () => {
  it("parses m:ss and rejects anything else", () => {
    expect(parseTime("0:08")).toBe(8);
    expect(parseTime("12:30")).toBe(750);
    expect(["8", "0:60", "-1:00", "1:5", "abc", ""].map(parseTime)).toEqual([null, null, null, null, null, null]);
    expect(formatTime(750)).toBe("12:30");
  });

  it("requires an end after the start and some text", () => {
    expect(validateObservation({ category: "hook", startSec: 5, endSec: 5, text: "x" })).toHaveProperty("end");
    expect(validateObservation({ category: "hook", startSec: 5, endSec: 9, text: "  " })).toHaveProperty("text");
    expect(validateObservation({ category: "hook", startSec: 5, endSec: 9, text: "x".repeat(501) })).toHaveProperty("text");
    expect(validateObservation({ category: "hook", startSec: 5, endSec: 9, text: "ok" })).toEqual({});
  });
});

describe("coveredSeconds", () => {
  const url = "https://www.instagram.com/reel/AAA/";
  it("counts overlapping intervals once", () => {
    expect(coveredSeconds([obs({ startSec: 0, endSec: 10 }), obs({ id: "b", startSec: 5, endSec: 15 }), obs({ id: "c", startSec: 20, endSec: 25 })], "visual", url)).toBe(20);
  });
  it("keeps visual and audio apart, so silent viewing isn't audio review", () => {
    const list = [obs({ category: "demonstration", endSec: 30 })];
    expect(coveredSeconds(list, "visual", url)).toBe(30);
    expect(coveredSeconds(list, "audio", url)).toBe(0);
  });
  it("ignores observations recorded against other media", () => {
    expect(coveredSeconds([obs()], "visual", "https://www.instagram.com/reel/BBB/")).toBe(0);
    expect(coveredSeconds([obs()], "visual", null)).toBe(0);
  });
});
