import { CURRENT_STAGES, DEFAULT_PIPELINE_FILTERS, PIPELINE_STAGES, filterPipeline, pipelineDemo, pipelineSources, type SourceFacts } from "@/fixtures/pipeline";
import { currentTotal, outcomeTotals, percent, sendTotals, stageRows, sum } from "./pipelineMetrics";

describe("pipeline fixture", () => {
  it("never grows between stages, and starts from the cohort", () => {
    for (const s of pipelineSources) {
      expect(s.reached).toHaveLength(PIPELINE_STAGES.length);
      s.reached.slice(1).forEach((n, i) => expect(n!).toBeLessThanOrEqual(s.reached[i]!));
    }
    expect(stageRows(pipelineSources)[0]!.reached).toBe(120);
  });

  it("splits the current stages exclusively, so they add up to the cohort", () => {
    expect(currentTotal(pipelineSources)).toBe(120);
    expect(CURRENT_STAGES).toHaveLength(10);
    for (const s of pipelineSources) expect(currentTotal([s])).toBe(s.reached[0]);
  });

  it("resolves approvals into confirmed, uncertain and queued with nothing left over", () => {
    for (const s of pipelineSources) expect(s.sends.confirmed + s.sends.uncertain + s.sends.queued).toBe(s.sends.approved);
    const total = sendTotals(pipelineSources);
    expect(total).toMatchObject({ approved: 60, confirmed: 54, uncertain: 2, queued: 4, attempts: 58, opportunities: 56 });
    expect(stageRows(pipelineSources).find((r) => r.key === "confirmedSent")!.reached).toBe(total.confirmed);
  });

  it("ties dispatch and closed counts to the exclusive stages", () => {
    for (const s of pipelineSources) {
      expect(s.dispatch.queued + s.dispatch.toReconcile).toBe(s.current.dispatch);
      expect(s.closed.waiting + s.closed.declined + s.closed.expired).toBe(s.current.matchPending);
      expect(s.dispatch.toReconcile).toBe(s.sends.uncertain);
    }
  });

  const F = DEFAULT_PIPELINE_FILTERS;
  const reachedOf = (filters: Partial<typeof F>, i = 0) => stageRows(filterPipeline({ ...F, ...filters }).sources)[i]!.reached;

  it("CF-01: every facet picks cells, so no facet is left unsplit and the default view is unchanged", () => {
    expect(filterPipeline(F).unsplit).toEqual([]);
    expect(filterPipeline({ ...F, source: "tiktok-shop" })).toMatchObject({ unsplit: [], sources: [{ source: "tiktok-shop" }] });
    expect(filterPipeline(F).scaleMax).toBe(pipelineDemo.scaleMax);
    expect(filterPipeline(F).sources).toEqual(pipelineSources);
  });

  it.each([
    ["network", "instagram", "tiktok"],
    ["checkout", "website", "tiktok-shop"],
    ["window", "sep", "oct"],
  ] as const)("CF-01: the %s facet partitions the cohort, so its values add up to the whole", (facet, a, b) => {
    expect(reachedOf({ [facet]: a })! + reachedOf({ [facet]: b })!).toBe(120);
    expect(reachedOf({ [facet]: a })).not.toBe(reachedOf({}));
  });

  it("CF-01: policy version partitions the cohort, and the cohort window is a different slice from it", () => {
    expect(reachedOf({ policy: "policy-2026-09" })! + reachedOf({ policy: "policy-2026-10" })!).toBe(120);
    expect(reachedOf({ policy: "policy-2026-09" })).not.toBe(reachedOf({ window: "sep" }));
  });

  it("CF-01: an inbound application has no confirmed outbound send, and that stage is N/A rather than zero", () => {
    const rows = stageRows(filterPipeline({ ...F, route: "inbound" }).sources);
    expect(rows[0]!.reached).toBe(24);
    expect(rows.find((r) => r.key === "confirmedSent")!.reached).toBeNull();
    expect(rows.find((r) => r.key === "confirmedSent")!.conversion).toBeNull();
    expect(filterPipeline({ ...F, route: "inbound" }).sources.map((s) => s.source)).toEqual(["social-cat"]);
    expect(filterPipeline({ ...F, route: "inbound", source: "tiktok-shop" }).sources).toEqual([]);
  });

  it("a combined median is shown only where the slices agree", () => {
    const rows = stageRows(filterPipeline({ ...F, route: "inbound" }).sources);
    expect(rows.find((r) => r.key === "confirmedSent")!.medianDays).toBeNull();
  });

  it("every slice's exclusive stage counts reconcile to its own cohort", () => {
    for (const filters of [{ network: "tiktok" }, { checkout: "tiktok-shop", window: "oct" }, { policy: "policy-2026-10" }, { route: "inbound" }] as const) {
      const sources = filterPipeline({ ...F, ...filters }).sources;
      expect(currentTotal(sources)).toBe(stageRows(sources)[0]!.reached);
    }
  });
});

describe("pipeline metrics", () => {
  it("derives conversion from the previous stage, and counts those that did not advance", () => {
    const rows = stageRows(pipelineSources);
    expect(rows.map((r) => r.conversion)).toEqual([null, "80.0%", "75.0%", "83.3%", "90.0%", "66.7%", "83.3%", "80.0%", "75.0%", "66.7%"]);
    expect(rows.map((r) => r.notAdvanced)).toEqual([null, 24, 24, 12, 6, 18, 6, 6, 6, 6]);
  });

  it("keeps a single source's own medians and drops a median the sources disagree on", () => {
    const [sc, tt] = pipelineSources as [SourceFacts, SourceFacts];
    expect(stageRows([sc])[5]!.medianDays).toBe(4);
    const slower = { ...tt, medianDays: tt.medianDays.map((d) => (d === null ? null : d + 1)) };
    expect(stageRows([sc, slower])[5]!.medianDays).toBeNull();
    expect(stageRows([sc, tt])[5]!.medianDays).toBe(4);
  });

  it("treats a missing count as unknown, not zero", () => {
    const [sc, tt] = pipelineSources as [SourceFacts, SourceFacts];
    const unknown = { ...tt, reached: tt.reached.map((n, i) => (i === 4 ? null : n)) };
    const rows = stageRows([sc, unknown]);
    expect(rows[4]).toMatchObject({ reached: null, conversion: null, notAdvanced: null });
    expect(rows[5]).toMatchObject({ reached: 36, conversion: null, notAdvanced: null });
    expect(sum([1, null])).toBeNull();
    expect(sum([1, 0])).toBe(1);
  });

  it("shows no rate when the denominator is zero or unknown, and a known zero rate as 0.0%", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(3, null)).toBeNull();
    expect(percent(0, 10)).toBe("0.0%");
  });

  it("reconciles outcomes: net sales are merchandise less refunds, and retained orders exclude full refunds", () => {
    const o = outcomeTotals(pipelineSources);
    expect(o).toMatchObject({ views: 120_000, engagementRate: "4.0%", orders: 40, fullyRefunded: 2, retained: 38 });
    expect(o.net.minorUnits).toBe(o.merchandise.minorUnits - o.refunds.minorUnits);
    expect(o.net.minorUnits).toBe(114_000);
  });
});
