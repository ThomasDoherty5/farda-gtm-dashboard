// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "../server.ts";
import * as recruitment from "./service.ts";
import { recruitmentServerFixture } from "./serverFixture.testkit.ts";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";
import { SYNTHETIC_REVIEW_TOKEN } from "../testFixtures.ts";
import type { ApprovalPrincipal } from "../approvals/contract.ts";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of close.splice(0).reverse()) await cleanup(); });
it("rechecks the actual source after constructing the HTTP envelope and publishes no protected result after denial", async () => {
  const directory = mkdtempSync(join(tmpdir(), "recruitment-publication-"));
  const fixture = recruitmentServerFixture(join(directory, "agent.sqlite"));
  let serialized = false, finalFences = 0;
  const create = recruitment.createRecruitmentService;
  vi.spyOn(recruitment, "createRecruitmentService").mockImplementation(options => {
    const actual = create(options);
    return { ...actual, async readInvitation(filters: unknown, principal: ApprovalPrincipal) {
      const result = await actual.readInvitation(filters, principal);
      // A test-only serialization probe identifies the server's dataVersion computation.
      // All data and the authority fence still come from the real reader and source fixture.
      const data = { ...result.data, toJSON() { serialized = true; return result.data; } };
      return { data, assertCurrent() {
        finalFences++;
        if (!serialized) throw new Error("The publication fence ran before envelope construction.");
        fixture.source.state.denied = true;
        result.assertCurrent();
      } };
    } };
  });
  const app = createAgentServer(fixture.options);
  close.push(async () => { await app.close(); fixture.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("A local test socket is required.");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/read`, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}` }, body: JSON.stringify({
    schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "fictional-final-publication", viewKey: "invitationDraft",
    requestedScope: { workspaceId: fixture.scope.workspaceId, accountIds: [fixture.scope.accountId], environment: "sandbox" },
    filters: fixture.filters, period: null, sort: [], page: { cursor: null, limit: 50 },
  }) });
  expect(finalFences).toBe(1);
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.code).toBe("RECRUITMENT_SOURCE_SCOPE_DENIED");
  expect(body).not.toHaveProperty("data");
  expect(fixture.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
  expect(fixture.owner.state.contexts).toEqual([]);
});
