/**
 * Runtime schema for evidenceRecord (video evidence review).
 *
 * `assessments` are contract provenance values, so a score with no complete review is "unknown" with a reason
 * code, a known score always has a value, and a known zero stays a known zero. `mediaUrl` is null until a clip
 * is attached, and a non-null address must be https: evidence is never fetched from an insecure or non-URL source.
 * There is deliberately no "watched" field, so an unexpected one is stripped rather than trusted by the screen.
 *
 * Strictness: loose (unknown keys stripped). The record carries no commercial terms, so a stray key is noise.
 */
import { z } from "zod";
import { provenanceValueSchema } from "../contract";
import { MAX_DISPUTES, MAX_OBSERVATIONS, MAX_REASON, MAX_TEXT } from "@/features/acquisition/evidenceRules";
import { instant, text } from "./acquisitionPrimitives";
import { creatorAssessmentSchema } from "@/creator-agent/assessmentSchema";
import { evidencePacketSchema } from "@/creator-agent/evidence";

const seconds = z.number().finite().nonnegative();

const observation = z.object({
  id: text,
  category: z.enum(["hook", "demonstration", "framing", "audio"]),
  startSec: seconds,
  endSec: seconds,
  text: z.string().trim().min(1).max(MAX_TEXT),
  /** The media address this was recorded against. */
  recordedAgainst: z.string().min(1),
}).refine((o) => o.endSec > o.startSec, { message: "The end must be after the start", path: ["endSec"] });

const observationList = z.array(observation).max(MAX_OBSERVATIONS);
const checkoutRoute = z.enum(["website", "tiktok-shop"]);

/** The first reviewer's record, frozen when the first observations are saved (VE-08). */
const firstReview = z.object({
  version: text,
  recordedAt: instant,
  reviewerRole: text,
  mediaUrl: z.string().url().nullable(),
  checkoutRoute,
  observations: observationList,
});

const proposedObservation = z.object({
  category: z.enum(["hook", "demonstration", "framing", "audio"]),
  startSec: seconds,
  endSec: seconds,
  text: z.string().trim().min(1).max(MAX_TEXT),
});

/** A second reviewer's disagreement or override. It sits beside the first record and never replaces it. */
const dispute = z.object({
  id: text,
  observationId: text,
  stance: z.enum(["disagree", "override"]),
  reason: z.string().trim().min(1).max(MAX_REASON),
  proposed: z.union([proposedObservation, z.literal("remove")]).nullable(),
  prior: observation,
  reviewerRole: text,
  recordedAt: instant,
  recordedAgainst: z.string().nullable(),
  /** The route the first record was read against; a dispute no longer applies once the saved route differs. */
  recordedRoute: checkoutRoute,
});

/** There is no completed-review path, so a record is always not ready and always says why. */
const readiness = z.object({ state: z.literal("notReady"), reasonCodes: z.array(text).min(1) });

const httpsAddress = z.string().url().refine((u) => u.startsWith("https://"), { message: "Use an https:// address" });
const score = provenanceValueSchema(z.number().finite().min(0));

const evidenceRecord = z.object({
  evidenceRef: text,
  creatorHandle: text,
  version: text,
  mediaUrl: httpsAddress.nullable(),
  checkoutRoute: z.enum(["website", "tiktok-shop"]),
  observations: z.array(observation).max(MAX_OBSERVATIONS).superRefine((list, ctx) => {
    if (new Set(list.map((o) => o.id)).size !== list.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Observation ids must be unique" });
  }),
  savedAt: instant.nullable(),
  reviewerRole: text.nullable(),
  modelPublication: z.object({ label: text, note: text }),
  assessments: z.object({ creative: score, routine: score, commerce: score }),
  firstReview: firstReview.nullable(),
  disputes: z.array(dispute).max(MAX_DISPUTES),
  readiness,
  qualification: creatorAssessmentSchema.nullable().optional(),
  agentEvidence: evidencePacketSchema.nullable().optional(),
}).superRefine((record, ctx) => {
  const assessment = record.qualification;
  const packet = record.agentEvidence;
  if (!assessment || !packet) return;
  for (const field of ["creatorId", "briefId", "evidenceRevision", "termsRevision"] as const) {
    if (assessment[field] !== packet[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qualification", field], message: "The assessment and source packet must identify the same saved input." });
  }
  const expectedModel = packet.checkoutRoute === "website" ? "WEBSITE-AFFILIATE-v3" : "TIKTOK-SHOP-AFFILIATE-v3";
  if (assessment.modelId !== expectedModel) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qualification", "modelId"], message: "The server assessment must use the source packet's checkout model." });
});

export const evidenceViewSchemas: Record<string, z.ZodTypeAny> = { evidenceRecord };
