import { z } from "zod";

const ref = z.string().trim().min(1).max(240);
const label = z.string().trim().min(1).max(160);
/** Source-owned, permission-bound navigation only. URLs cannot carry credentials,
 * search tokens, fragments, or an arbitrary third-party destination. */
export const readinessSourceUrlSchema = z.string().url().max(1500).refine(value => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash &&
    ["notion.so", "www.notion.so", "linear.app"].includes(u.hostname) && u.pathname !== "/";
}, "A canonical Notion or Linear source URL is required.");
const notionUrl = readinessSourceUrlSchema.refine(value => new URL(value).hostname !== "linear.app", "The date workflow belongs to Notion.");
export const readinessGatePresentationSchema = z.object({ label, owner: label.nullable(), taskUrl: readinessSourceUrlSchema.nullable(),
  evidenceUrl: readinessSourceUrlSchema.nullable(), dueRelative: z.string().trim().min(1).max(80).nullable() }).strict();
export const readinessPresentationSchema = z.object({
  evidenceStage: z.enum(["synthetic", "source"]), recordRef: ref, recordVersion: ref, recordUrl: notionUrl.nullable(),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).nullable().optional(),
  dateProposalUrl: notionUrl.nullable(), sampleAcceptance: z.object({ state: z.enum(["verified", "pending", "rejected"]),
    evidenceRef: ref.nullable(), version: ref, observedAt: z.string().datetime({ offset: true }) }).strict().nullable(),
}).strict();
