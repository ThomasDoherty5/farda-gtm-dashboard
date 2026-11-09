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
it.each(["permission", "sampleDeadline", "acceptedProof"] as const)("rechecks %s after constructing the HTTP envelope and publishes no expired protected fact", async boundary => {
  const directory = mkdtempSync(join(tmpdir(), "recruitment-publication-"));
  const fixture = recruitmentServerFixture(join(directory, "agent.sqlite"));
  const deadline = new Date(fixture.o.now() + 1_000).toISOString();
  fixture.source.state.transform = snapshot => {
    if (boundary === "sampleDeadline") snapshot.samples = [{ requestRef: "fictional-open-request", version: "v1", creatorRef: "synthetic-private-profile",
      sourceRef: "fictional-sample-source", observedAt: new Date(fixture.source.state.observedAt).toISOString(),
      validUntil: new Date(fixture.source.state.validUntil).toISOString(), requestType: "open", nativeState: "pending", deadline,
      route: "verifiedApi", capabilityVersion: "fictional-api-v1", reasonCodes: [], approvalRef: null, runRef: null, receiptRef: null }];
    if (boundary === "acceptedProof" && snapshot.kind === "invitation") {
      snapshot.willingness = "willing";
      snapshot.acceptedOffer = { offerId: fixture.offer.offerId, version: fixture.offer.version, receiptRef: "fictional-acceptance", validUntil: deadline };
    }
  };
  let serialized = false, finalFences = 0;
  const create = recruitment.createRecruitmentService;
  vi.spyOn(recruitment, "createRecruitmentService").mockImplementation(options => {
    const actual = create(options);
    return { ...actual, async readInvitation(filters: unknown, principal: ApprovalPrincipal) {
      const result = await actual.readInvitation(filters, principal);
      if (boundary === "acceptedProof") expect(result.data.offer?.accepted).toBe(true);
      if (boundary === "sampleDeadline") expect(result.data.samples[0]?.route).toBe("verifiedApi");
      if (boundary !== "permission") expect(result.data.validUntil).toBe(deadline);
      // A test-only serialization probe identifies the server's dataVersion computation.
      // All data and the authority fence still come from the real reader and source fixture.
      const data = { ...result.data, toJSON() {
        if (!serialized && boundary !== "permission") fixture.o.advance(1_000);
        serialized = true; return result.data;
      } };
      return { data, assertCurrent() {
        finalFences++;
        if (!serialized) throw new Error("The publication fence ran before envelope construction.");
        if (boundary === "permission") fixture.source.state.denied = true;
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
  expect(response.status).toBe(boundary === "permission" ? 403 : 409);
  const body = await response.json();
  expect(body.code).toBe(boundary === "permission" ? "RECRUITMENT_SOURCE_SCOPE_DENIED" : "RECRUITMENT_SOURCE_STALE");
  expect(body).not.toHaveProperty("data");
  expect(fixture.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
  expect(fixture.owner.state.contexts).toEqual([]);
});
