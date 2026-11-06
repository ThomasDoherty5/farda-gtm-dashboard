/**
 * Runtime schema for collaborationDetail.
 *
 * Strictness: `terms` is strict. It holds the one accepted, historical fee (read-only, never offered again),
 * and an unexpected extra commercial key there (a new fee, a bonus) must fail loudly instead of being stripped
 * and hidden from review. Everything else is loose, because an extra display field is harmless.
 *
 * `requests[].state` accepts only "approvalPending": a queued request is not an approved one, and approved is
 * not sent, so any other state in this list is a shape the screen does not know how to describe honestly.
 */
import { z } from "zod";
import { collaborationEvidenceSchema } from "@/creator-agent/collaborationEvidence";
import { calendarDate, count, money, text } from "./acquisitionPrimitives";

/**
 * Whether the accepted terms create a posting obligation. A committed post has a due date and a grace period; a voluntary
 * post has neither, only an observation window and the sample cost that is retained. The two never share fields, so a
 * voluntary record cannot carry a due date by accident.
 */
const posting = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("committed"), due: calendarDate, graceDays: count }).strict(),
  z.object({ kind: z.literal("voluntary"), sampleDelivered: calendarDate, observeDays: count, sampleCost: money }).strict(),
]);

const terms = z.object({
  deliverable: text,
  /** The accepted historical fee, read-only. Null means there is no fee at all (a gifted sample), which is not a zero fee. */
  agreedFee: money.nullable(),
  posting,
  sourceRecord: text,
  revisionRounds: z.object({ allowed: count, used: count }),
}).strict();

const content = z.object({
  version: text,
  title: text,
  receivedAt: text,
  checklist: z.array(z.object({ label: text, result: z.enum(["Pass", "Needs review", "Missing license", "Pending"]) })),
  revisions: z.array(text),
  rights: z.array(z.object({ key: text, label: text, value: text })),
  licenseSigned: z.boolean(),
  proposedFeedback: z.string(),
});

const collaborationDetail = z.object({
  datasetKey: text,
  /** The server's date for timing rules. The screen never reads the browser clock for an obligation. */
  asOf: calendarDate,
  collaborationId: text,
  ref: text,
  handle: text,
  channel: text,
  owner: text,
  stage: text,
  terms,
  timeline: z.array(z.object({ title: text, note: text, state: z.enum(["Completed", "Running", "Pending"]) })),
  eligibility: z.object({ current: text, suppression: text, lastDecision: text, suppressed: z.boolean() }),
  /** What the server will accept as a next action. The client offers nothing outside this list. */
  allowedActions: z.array(z.object({ key: text, label: text })),
  closureOutcomes: z.array(text).min(1),
  unresolved: z.array(text),
  /** Null when nothing has been submitted, which a voluntary collaboration may never do. */
  content: content.nullable(),
  requests: z.array(z.object({ id: text, kind: text, summary: text, version: text, state: z.literal("approvalPending") })),
});

export const collaborationViewSchemas: Record<string, z.ZodTypeAny> = { collaborationDetail, collaborationEvidence: collaborationEvidenceSchema };
