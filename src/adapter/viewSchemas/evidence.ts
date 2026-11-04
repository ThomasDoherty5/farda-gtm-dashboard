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
import { MAX_OBSERVATIONS, MAX_TEXT } from "@/features/acquisition/evidenceRules";
import { instant, text } from "./acquisitionPrimitives";

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
});

export const evidenceViewSchemas: Record<string, z.ZodTypeAny> = { evidenceRecord };
