import { evidenceViewSchemas as schemas } from "./evidence";
import { REMOVE, expectAllParse, expectRejections, readRequest, readVariants, scope } from "./acquisitionTestKit";
import { SCHEMA_VERSION, type SaveResourceRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import type { EvidenceDraft } from "@/features/acquisition/evidenceTypes";
import { DEMO_EVIDENCE_PARTIAL_ID, DEMO_MEDIA_URL, seedEvidence } from "@/fixtures/evidence";
import { DEMO_CREATOR_ID, DEMO_EVIDENCE_ID } from "@/fixtures/ids";

const [empty, partial] = seedEvidence() as [ReturnType<typeof seedEvidence>[number], ReturnType<typeof seedEvidence>[number]];
const filters = (evidenceId: string) => ({ creatorId: DEMO_CREATOR_ID, evidenceId });

const save = (key: string, resourceRef: string, expectedVersion: string, payload: EvidenceDraft): SaveResourceRequest<EvidenceDraft> => ({
  schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: scope, resourceKind: "evidenceDraft", resourceRef, expectedVersion, idempotencyKey: key, requestId: `s-${key}`, payload,
});

describe("evidence view schemas", () => {
  it("covers exactly evidenceRecord", () => {
    expect(Object.keys(schemas)).toEqual(["evidenceRecord"]);
  });

  describe("every demo variant parses unchanged", () => {
    it("the empty record and the partly reviewed record under every ?fixture= switch", async () => {
      const variants = await readVariants("evidenceRecord", [filters(DEMO_EVIDENCE_ID), filters(DEMO_EVIDENCE_PARTIAL_ID)]);
      expect(expectAllParse(schemas.evidenceRecord!, variants)).toBe(18);
    });

    it("keeps unknown scores unknown with their reason, and never turns them into 0", async () => {
      const [first] = await readVariants("evidenceRecord", [filters(DEMO_EVIDENCE_ID)]);
      const { assessments } = schemas.evidenceRecord!.parse(first!.response!.data) as { assessments: Record<string, { state: string; value: number | null; reasonCode: string }> };
      expect(Object.values(assessments).map((a) => [a.state, a.value])).toEqual([["unknown", null], ["unknown", null], ["unknown", null]]);
    });

    it("the record after a draft with a clip and observations is saved", async () => {
      const adapter = createDemoAdapter();
      const draft: EvidenceDraft = {
        mediaUrl: DEMO_MEDIA_URL,
        checkoutRoute: "tiktok-shop",
        observations: [{ id: "obs-new-1", category: "framing", startSec: 2, endSec: 9.5, text: "Product is centered in frame.", recordedAgainst: DEMO_MEDIA_URL }],
      };
      await adapter.saveResource(save("k1", DEMO_EVIDENCE_ID, "v1", draft));
      const response = await adapter.readView(readRequest("evidenceRecord", filters(DEMO_EVIDENCE_ID)));
      expect((response.data as { version: string }).version).toBe("v2");
      expect(expectAllParse(schemas.evidenceRecord!, [{ label: "saved", fixture: "FX-01-happy-read", response, error: null }])).toBe(1);
    });
  });

  describe("evidenceRecord rejects", () => {
    const withScore = (over: object) => ({ ...partial.assessments, creative: { ...partial.assessments.creative, ...over } });
    expectRejections(schemas.evidenceRecord!, partial, [
      ["a missing evidence reference", "evidenceRef", REMOVE],
      ["a missing checkout route", "checkoutRoute", REMOVE],
      ["an unknown checkout route", "checkoutRoute", "amazon"],
      ["a media address that is not a URL", "mediaUrl", "not a url"],
      ["an insecure media address", "mediaUrl", "http://www.instagram.com/reel/DEMOREEL001/"],
      ["a missing observation list", "observations", REMOVE],
      ["an unknown observation category", "observations.0.category", "lighting"],
      ["an observation start as text", "observations.0.startSec", "0"],
      ["a negative observation start", "observations.0.startSec", -1],
      ["an observation that ends before it starts", "observations.0.endSec", -0.5],
      ["an observation that ends where it starts", "observations.1.endSec", 8],
      ["an observation with blank text", "observations.0.text", "   "],
      ["an observation with no recorded-against media", "observations.0.recordedAgainst", REMOVE],
      ["a repeated observation id", "observations.1.id", "obs-seed-1"],
      ["a save time that is not an instant", "savedAt", "29 Oct"],
      ["a score of known with a null value (a known null)", "assessments", withScore({ state: "known", value: null, reasonCode: null })],
      ["a score of unknown with a value (unknown turned into a number)", "assessments", withScore({ state: "unknown", value: 0, reasonCode: "NO_COMPLETE_REVIEW" })],
      ["a score of unknown with no reason", "assessments", withScore({ state: "unknown", value: null, reasonCode: null })],
      ["a score of notApplicable with a value", "assessments", withScore({ state: "notApplicable", value: 50, reasonCode: "NOT_APPLICABLE" })],
      ["a negative known score", "assessments", withScore({ state: "known", value: -1, reasonCode: null })],
      ["a score state outside the contract", "assessments", withScore({ state: "pending" })],
      ["a missing commerce score", "assessments.commerce", REMOVE],
      ["a missing model publication note", "modelPublication.note", REMOVE],
      ["a missing dispute list", "disputes", REMOVE],
      ["a missing readiness", "readiness", REMOVE],
      ["readiness that claims ready", "readiness.state", "ready"],
      ["a first review with an unknown route", "firstReview", { version: "v1", recordedAt: "2026-10-30T00:00:00.000Z", reviewerRole: "reviewer", mediaUrl: null, checkoutRoute: "amazon", observations: [] }],
      ["a dispute with no recorded route", "disputes", [{ id: "d", observationId: "o", stance: "disagree", reason: "r", proposed: null, prior: { id: "o", category: "hook", startSec: 0, endSec: 1, text: "t", recordedAgainst: "https://www.instagram.com/reel/A/" }, reviewerRole: "x", recordedAt: "2026-10-30T00:00:00.000Z", recordedAgainst: null }]],
    ]);

    it("accepts a known zero score and an unknown or not-applicable score with a reason", () => {
      const parse = (over: object) => schemas.evidenceRecord!.safeParse({ ...partial, assessments: withScore(over) }).success;
      expect(parse({ state: "known", value: 0, reasonCode: null })).toBe(true);
      expect(parse({ state: "notApplicable", value: null, reasonCode: "NOT_APPLICABLE" })).toBe(true);
    });

    it("accepts the empty record with no media and no observations", () => {
      expect(schemas.evidenceRecord!.safeParse(empty).success).toBe(true);
    });
  });
});
