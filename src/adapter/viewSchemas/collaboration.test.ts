import { collaborationViewSchemas as schemas } from "./collaboration";
import { REMOVE, expectAllParse, expectRejections, readVariants, scope } from "./acquisitionTestKit";
import { SCHEMA_VERSION, type ActionRequest } from "../contract";
import { COLLABORATION_ID, VOLUNTARY_COLLABORATION_ID, collaborationDemo, voluntaryCollaborationDemo } from "@/fixtures/collaboration";

const queue = (actionKind: string, key: string, payload: object): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "requestApproval", requestedScope: scope, actionKind, entityRefs: [], expectedVersion: "collab-v1", approvalRef: null, manifestRef: null, idempotencyKey: key, payload: { collaborationId: COLLABORATION_ID, ...payload }, requestId: `a-${key}`,
});

describe("collaboration view schemas", () => {
  it("covers exactly collaborationDetail", () => {
    expect(Object.keys(schemas)).toEqual(["collaborationDetail"]);
  });

  describe("every demo variant parses unchanged", () => {
    it("the collaboration under every ?fixture= switch", async () => {
      expect(expectAllParse(schemas.collaborationDetail!, await readVariants("collaborationDetail", [{ collaborationId: COLLABORATION_ID }]))).toBe(9);
    });
    it("the collaboration after a feedback request is queued for approval", async () => {
      const variants = await readVariants("collaborationDetail", [{ collaborationId: COLLABORATION_ID }], async (adapter) => {
        await adapter.submitAction(queue("queueFeedback", "k1", { text: "Please tighten the opening." }));
      });
      expect(expectAllParse(schemas.collaborationDetail!, variants)).toBe(9);
      expect((variants[0]!.response!.data as { requests: { state: string }[] }).requests.map((r) => r.state)).toEqual(["approvalPending"]);
    });
    it("the collaboration after several different requests are queued", async () => {
      const variants = await readVariants("collaborationDetail", [{ collaborationId: COLLABORATION_ID }], async (adapter) => {
        await adapter.submitAction(queue("queueFeedback", "k1", { text: "Tighten the opening." }));
        await adapter.submitAction({ ...queue("suppressOutreach", "k2", { reason: "Creator asked to stop." }), expectedVersion: "collab-v2" });
      });
      expect(expectAllParse(schemas.collaborationDetail!, variants)).toBe(9);
      expect((variants[0]!.response!.data as { requests: unknown[] }).requests).toHaveLength(2);
    });
  });

  describe("a voluntary collaboration, with no fee, no due date and no content", () => {
    it("parses under every ?fixture= switch", async () => {
      expect(expectAllParse(schemas.collaborationDetail!, await readVariants("collaborationDetail", [{ collaborationId: VOLUNTARY_COLLABORATION_ID }]))).toBe(9);
    });
    it("is accepted with a null fee and null content, and null content is not the same as a missing block", () => {
      expect(schemas.collaborationDetail!.safeParse(voluntaryCollaborationDemo).success).toBe(true);
      const withoutContent: Record<string, unknown> = { ...voluntaryCollaborationDemo };
      delete withoutContent.content;
      expect(schemas.collaborationDetail!.safeParse(withoutContent).success).toBe(false);
    });
    expectRejections(schemas.collaborationDetail!, voluntaryCollaborationDemo, [
      ["a negative observation window", "terms.posting.observeDays", -1],
      ["a voluntary post with a due date", "terms.posting", { kind: "voluntary", sampleDelivered: "2026-10-14", observeDays: 30, sampleCost: { minorUnits: 1_840, currency: "USD" }, due: "2026-11-04" }],
      ["a sample cost without a currency", "terms.posting.sampleCost", { minorUnits: 1_840 }],
      ["a fractional sample cost", "terms.posting.sampleCost.minorUnits", 18.4],
      ["a text sample delivery date", "terms.posting.sampleDelivered", "14 Oct"],
    ]);
  });

  describe("collaborationDetail rejects", () => {
    expectRejections(schemas.collaborationDetail!, collaborationDemo, [
      ["a missing terms block", "terms", REMOVE],
      ["a missing content block", "content", REMOVE],
      ["a text revision count", "terms.revisionRounds.used", "1"],
      ["a fractional revision count", "terms.revisionRounds.allowed", 1.5],
      ["a negative grace period", "terms.posting.graceDays", -3],
      ["a posting due date that is not a date", "terms.posting.due", "04 Nov"],
      ["a missing posting block", "terms.posting", REMOVE],
      ["an unknown posting kind", "terms.posting.kind", "optional"],
      ["a committed post with a voluntary field", "terms.posting", { kind: "committed", due: "2026-11-04", graceDays: 3, observeDays: 30 }],
      ["a missing server date", "asOf", REMOVE],
      ["a server date that is not a date", "asOf", "today"],
      ["a negative agreed fee", "terms.agreedFee.minorUnits", -15_000],
      ["a fractional agreed fee", "terms.agreedFee.minorUnits", 15_000.5],
      ["an agreed fee without a currency", "terms.agreedFee", { minorUnits: 15_000 }],
      ["a new commercial key beside the accepted fee", "terms", { ...collaborationDemo.terms, newFee: { minorUnits: 20_000, currency: "USD" } }],
      ["an unknown timeline state", "timeline.0.state", "Done"],
      ["an unknown checklist result", "content.checklist.0.result", "Maybe"],
      ["licenseSigned as text", "content.licenseSigned", "false"],
      ["a missing suppressed flag", "eligibility.suppressed", REMOVE],
      ["an approved request in the queued list", "requests", [{ id: "req-1", kind: "queueFeedback", summary: "Feedback", version: "collab-v2", state: "approved" }]],
      ["a sent request in the queued list", "requests", [{ id: "req-1", kind: "queueFeedback", summary: "Feedback", version: "collab-v2", state: "sent" }]],
      ["no closure outcomes", "closureOutcomes", []],
      ["an allowed action with no key", "allowedActions.0.key", REMOVE],
    ]);
  });
});
