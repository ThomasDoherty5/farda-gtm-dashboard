// @vitest-environment node
import { expect, it } from "vitest";
import { digest } from "../config.ts";
import { createReportingTestkit, reportFixture } from "./fixtures.testkit.ts";
import { formatReport } from "./format.ts";
import { reportMaterial } from "./source.ts";

it("labels only source-marked controlled reports, binds the marker immutably, and grants no send authority", async () => {
  const kit = createReportingTestkit();
  try {
    const ordinary = reportFixture(kit.now);
    const legacyMaterial = { scope: ordinary.scope, event: ordinary.event, programme: { ...ordinary.programme, state: undefined }, destination: ordinary.destination, delivery: ordinary.delivery };
    const legacy = formatReport(ordinary);
    expect(legacy.body).toMatch(/^🔴 Act now\nOrder SYNTHETIC-001/);
    expect(legacy.body).not.toContain("Controlled sandbox test");
    expect(digest(reportMaterial(ordinary))).toBe(digest(legacyMaterial));

    const marked = { ...ordinary, testProvenance: { kind: "controlledSandbox" as const, evidenceRef: "fixture:controlled-report-v1" } };
    const rendered = formatReport(marked);
    expect(rendered.body).toBe(legacy.body.replace("🔴 Act now\n", "🔴 Act now · Controlled sandbox test\n"));
    expect(rendered.bodyHash).not.toBe(legacy.bodyHash);
    expect(digest(reportMaterial(marked))).not.toBe(digest(reportMaterial(ordinary)));
    kit.add(marked);
    const accepted = await kit.accept();
    const changed = { ...marked, testProvenance: { ...marked.testProvenance, evidenceRef: "fixture:changed-proof" } };
    kit.add(changed);
    await expect(kit.service.work(accepted.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_FROZEN_SOURCE_CHANGED" });
    expect(kit.state.calls).toHaveLength(0);

    const unapproved = { ...marked, event: { ...marked.event, eventRef: "event:unapproved-controlled" }, programme: { ...marked.programme, state: "unverified" as const } };
    await expect(kit.accept(kit.add(unapproved), "unapproved-controlled")).rejects.toMatchObject({ code: "REPORT_PROGRAMME_HELD" });
    expect(kit.state.calls).toHaveLength(0);
  } finally { kit.close(); }
});
