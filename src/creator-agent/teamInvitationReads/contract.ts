import { z } from "zod";

/**
 * Team permissions (THO-305) and TikTok invitation draft (THO-298) read models served at the authenticated `/v1/read`
 * boundary. Read only: no role is granted or changed, no owner is assigned and no invitation is sent here.
 */
export const teamInvitationReadViewKeys = ["teamPermissions", "invitationDraft"] as const;
export type TeamInvitationReadViewKey = (typeof teamInvitationReadViewKeys)[number];
export const isTeamInvitationReadViewKey = (value: string): value is TeamInvitationReadViewKey => (teamInvitationReadViewKeys as readonly string[]).includes(value);

/** Reason-code prefix per view, so an unconfigured, failed or stale answer names the source it is about. */
export const teamInvitationReasonPrefix: Record<TeamInvitationReadViewKey, string> = { teamPermissions: "TEAM_PERMISSIONS", invitationDraft: "INVITATION" };

/**
 * Exact filters per view, matching what each screen sends through `useView` (both send `{}`). D-11: `scenario` and `fixture`
 * are demo-only and are refused here, so a demo selector can never pick what the service answers. No view accepts a query.
 */
export const teamInvitationReadFilters = {
  teamPermissions: z.object({}).strict(),
  invitationDraft: z.object({}).strict(),
} satisfies Record<TeamInvitationReadViewKey, z.ZodTypeAny>;

const ref = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

/**
 * What an injected server-only source reader must return for one view. The reader is never supplied by a browser request.
 * `record: null` is the source's own statement that nothing exists (no role registered, no draft); it is not used for an unread source.
 */
export const teamInvitationSnapshotSchema = z.object({
  scope: z.object({ workspaceId: z.string().min(1), accountId: z.string().min(1), environment: z.literal("sandbox") }).strict(),
  viewKey: z.enum(teamInvitationReadViewKeys),
  version: ref,
  principalRef: ref,
  permissionVersion: ref,
  observedAt: instant,
  validUntil: instant,
  coverage: z.object({ state: z.enum(["complete", "partial"]), expectedCount: count.nullable(), observedCount: count.nullable(),
    reasonCodes: z.array(reasonCode).max(20) }).strict(),
  record: z.unknown().refine(value => value !== undefined, "A record or an explicit null is required."),
}).strict().superRefine((s, ctx) => {
  if (Date.parse(s.validUntil) <= Date.parse(s.observedAt)) ctx.addIssue({ code: "custom", message: "Invalid source lease." });
  const { state, expectedCount, observedCount, reasonCodes } = s.coverage;
  if (expectedCount !== null && observedCount !== null && observedCount > expectedCount) ctx.addIssue({ code: "custom", message: "Observed exceeds expected." });
  if (state === "complete" && (expectedCount === null || observedCount !== expectedCount)) ctx.addIssue({ code: "custom", message: "Complete coverage needs equal known counts." });
  if (state === "partial" && reasonCodes.length === 0) ctx.addIssue({ code: "custom", message: "Partial coverage needs a reason." });
  // "Nothing exists" is only a complete answer when the source counted zero expected rows; otherwise it is unknown, not empty.
  if (s.record === null && state === "complete" && expectedCount !== 0) ctx.addIssue({ code: "custom", message: "An empty record needs a counted zero." });
});
export type TeamInvitationSnapshot = z.infer<typeof teamInvitationSnapshotSchema>;
