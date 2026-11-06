import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { respondWith } from "@/adapter/demoViews";
import { AdapterError } from "@/adapter/errors";
import { renderRoute, renderWithAdapter, scriptedAdapter } from "@/test/renderWithAdapter";
import { CollaborationEvidence } from "./CollaborationEvidence";
import type { CollaborationEvidenceData, CollaborationEvidenceRecord } from "@/creator-agent/collaborationEvidence";

const at = "2026-11-05T12:00:00Z";
const row: CollaborationEvidenceRecord = {
  id: "synthetic-review-1", kind: "review", reviewKey: "review-key", revision: 1,
  recordedAt: at, action: "renew", creatorId: "same-creator", sourceVerified: false,
};
function data(collaborationId: string, rows: CollaborationEvidenceRecord[], offset = 0, total = rows.length): CollaborationEvidenceData {
  return { kind: "collaboration-evidence", source: "saved-agent-records", collaborationId, observedAt: at, records: rows, offset, total, hasMore: offset + rows.length < total };
}

describe("evidence on the existing collaboration route", () => {
  it("opens the original fixture's separate evidence view and presents asset lineage and decisions", async () => {
    const user = userEvent.setup();
    renderRoute("/collaborations/demo-collaboration-1?tab=content", createDemoAdapter());
    await user.click(await screen.findByRole("button", { name: "Saved evidence" }, { timeout: 5000 }));
    const records = await screen.findByTestId("collaboration-evidence");
    expect(records).toHaveTextContent("Illustrative evidence");
    expect(records).toHaveTextContent("demo-routine-original · version 1");
    expect(records).toHaveTextContent("Usage rightsunknown");
    expect(records).toHaveTextContent("Portfolio decision · approved");
    expect(records).toHaveTextContent("Participation · accepted");
  });

  it("rejects a different collaboration's records even when the service returns a valid response shape", async () => {
    const adapter = scriptedAdapter(async request => respondWith(request, data("other", [row]), { dataVersion: "v1" }));
    renderWithAdapter(<CollaborationEvidence collaborationId="expected" />, adapter);
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(screen.queryByText("same-creator")).not.toBeInTheDocument();
  });

  it("makes known empty distinct from an unavailable record count", async () => {
    const adapter = scriptedAdapter(async request => respondWith(request, data("exact", []), { dataVersion: "v1", dataState: "empty" }));
    renderWithAdapter(<CollaborationEvidence collaborationId="exact" />, adapter);
    expect(await screen.findByText("No matching records in the saved asset and portfolio stores.")).toHaveAttribute("role", "status");
  });

  it("handles a missing projection as unknown rather than zero", async () => {
    const adapter = scriptedAdapter(async request => respondWith(request, null, { dataVersion: "v1", dataState: "unavailable" }));
    renderWithAdapter(<CollaborationEvidence collaborationId="exact" />, adapter);
    expect(await screen.findByText(/number of saved records is unknown/)).toHaveAttribute("role", "status");
  });

  it("clears earlier records if access is denied during a subsequent page", async () => {
    const user = userEvent.setup();
    const adapter = scriptedAdapter(async request => {
      if (request.page.cursor) throw new AdapterError({ code: "FORBIDDEN", message: "Denied", requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
      const result = respondWith(request, data("exact", [row], 0, 2), { dataVersion: "v1", dataState: "partial" });
      return { ...result, page: { hasMore: true, nextCursor: "synthetic-cursor" } };
    });
    renderWithAdapter(<CollaborationEvidence collaborationId="exact" />, adapter);
    const records = await screen.findByRole("list", { name: "Saved evidence records" });
    expect(within(records).getByText("same-creator")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more evidence" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No access to this account");
    expect(screen.queryByText("same-creator")).not.toBeInTheDocument();
  });
});
