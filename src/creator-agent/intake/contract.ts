import { z } from "zod";

/**
 * J01 creator signup intake and identity resolution (THO-318). Normalized Farda fields, never assumed provider API fields.
 * Social Cat is a recruitment source, not a publishing network.
 */
export const JOB_ID = "J01" as const;
export const JOB_VERSION = "creator-intake.v1" as const;
export const NETWORKS = ["instagram", "tiktok"] as const;
export const RECRUITMENT_SOURCES = ["social-cat", "tiktok-shop", "website-affiliate", "daily-discovery", "reviewed-correction"] as const;
export type Network = (typeof NETWORKS)[number];
export type RecruitmentSource = (typeof RECRUITMENT_SOURCES)[number];
export const NETWORK_HOSTS: Record<Network, readonly string[]> = { instagram: ["instagram.com", "www.instagram.com"], tiktok: ["tiktok.com", "www.tiktok.com"] };

export const opaqueRef = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "Use an opaque reference.")
  .refine((value) => !/^https?:/i.test(value), "Use an opaque reference, not an endpoint.");
const time = z.string().datetime({ offset: true });

/** A public address: https, no login details, no query string or fragment. */
export const sourceUrlSchema = z.string().url().max(500).refine((raw) => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Use a plain https address without login details or query parameters.");

/** The handoff's SourceRef. A missing native ID stays null; nothing invents one. */
export const sourceRefSchema = z.object({
  source: opaqueRef,
  accountId: opaqueRef,
  sourceId: opaqueRef.nullable(),
  url: sourceUrlSchema.nullable(),
  canonicalId: opaqueRef.nullable(),
  identityState: z.enum(["resolved", "unresolved"]),
  provenanceRef: opaqueRef,
}).strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;

/** A network profile: a SourceRef whose source is the publishing network, with the handle and update time the source showed. */
export const profileRefSchema = sourceRefSchema.extend({
  source: z.enum(NETWORKS),
  handle: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9._]+$/).nullable(),
  sourceUpdatedAt: time.nullable(),
}).strict().superRefine((profile, ctx) => {
  if (profile.url && !NETWORK_HOSTS[profile.source].includes(new URL(profile.url).hostname))
    ctx.addIssue({ code: "custom", path: ["url"], message: "The address is not on this profile's network." });
});
export type ProfileRef = z.infer<typeof profileRefSchema>;

const cursorSchema = z.object({ page: opaqueRef, position: z.number().int().nonnegative() }).strict();
export const intakeInputSchema = z.object({
  campaignRef: sourceRefSchema.nullable(),
  briefRef: z.object({ ref: opaqueRef, version: opaqueRef }).strict().nullable(),
  sourceCandidate: sourceRefSchema,
  recruitmentSource: z.enum(RECRUITMENT_SOURCES),
  trigger: z.enum(["signup", "discovery", "correction", "profileChange"]),
  eventId: opaqueRef,
  occurredAt: time.nullable(),
  observedAt: time,
  profileRefs: z.array(profileRefSchema).max(10),
  publishingNetworks: z.array(z.enum(NETWORKS)).max(NETWORKS.length),
  identityMapVersion: opaqueRef,
  suppressionVersion: opaqueRef,
  cursor: cursorSchema.nullable(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.publishingNetworks).size !== input.publishingNetworks.length)
    ctx.addIssue({ code: "custom", path: ["publishingNetworks"], message: "List each network once." });
  for (const [index, profile] of input.profileRefs.entries())
    if (!input.publishingNetworks.includes(profile.source))
      ctx.addIssue({ code: "custom", path: ["profileRefs", index, "source"], message: "A profile's network must be one of the publishing networks." });
  if (input.occurredAt && Date.parse(input.occurredAt) > Date.parse(input.observedAt))
    ctx.addIssue({ code: "custom", path: ["occurredAt"], message: "A source event cannot happen after it was observed." });
  if ((input.recruitmentSource === "reviewed-correction") !== (input.trigger === "correction"))
    ctx.addIssue({ code: "custom", path: ["trigger"], message: "Only a reviewed correction uses the correction trigger." });
});
export type IntakeInput = z.infer<typeof intakeInputSchema>;

export const intakeEnvelopeSchema = z.object({
  jobId: z.literal(JOB_ID),
  jobVersion: z.literal(JOB_VERSION),
  // The shared envelope allows four modes. J01 accepts observe and reconcile only: it never proposes or executes outbound work.
  mode: z.enum(["observe", "propose", "executeApproved", "reconcile"]),
  actor: z.object({ id: opaqueRef, role: z.enum(["agent", "reviewer"]) }).strict(),
  accountRef: z.object({ workspaceId: opaqueRef, accountId: opaqueRef }).strict(),
  policyVersion: z.literal("commission-only-v1"),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(240),
  correlationId: opaqueRef,
  requestedAt: time,
  deadline: time.nullable(),
  checkpoint: z.null(),
}).strict();
export type IntakeEnvelope = z.infer<typeof intakeEnvelopeSchema>;
export const intakeRequestSchema = z.object({ envelope: intakeEnvelopeSchema, input: intakeInputSchema }).strict();

/** A reviewed crosswalk maps a profile with no native ID (or a contested alias) to one canonical creator. */
export const crosswalkSchema = z.object({
  version: opaqueRef,
  entries: z.array(z.object({ network: z.enum(NETWORKS), profileKey: opaqueRef, creatorId: opaqueRef, reviewedRef: opaqueRef }).strict()).max(10_000),
}).strict();
export type Crosswalk = z.infer<typeof crosswalkSchema>;

/** Suppression is sticky here: once recorded, a later list that omits an entry does not lift it. */
export const suppressionListSchema = z.object({
  version: opaqueRef,
  entries: z.array(z.object({
    subject: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("creator"), creatorId: opaqueRef }).strict(),
      z.object({ kind: z.literal("profile"), network: z.enum(NETWORKS), profileKey: opaqueRef }).strict(),
    ]),
    reason: z.enum(["opt-out", "do-not-contact", "relationship-closed", "legal-hold"]),
    sourceRef: opaqueRef,
    effectiveAt: time,
  }).strict()).max(10_000),
}).strict();
export type SuppressionList = z.infer<typeof suppressionListSchema>;

export const routeStateSchema = z.enum(["Ready", "Unverified", "Unsupported", "Denied"]);
export type RouteState = z.infer<typeof routeStateSchema>;
export const sinkReceiptSchema = z.object({ receiptRef: opaqueRef }).strict();

export const evidenceRefSchema = z.object({
  evidenceId: opaqueRef,
  sourceRef: opaqueRef,
  occurredAt: time.nullable(),
  sourceUpdatedAt: time.nullable(),
  observedAt: time,
  syncedAt: time,
  method: z.enum(["source-signup", "source-discovery", "reviewed-correction", "profile-change"]),
}).strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const HANDOFF_TARGETS = ["notion-creator-crm", "sheets-watchlist"] as const;
export const handoffSchema = z.object({
  target: z.enum(HANDOFF_TARGETS),
  key: opaqueRef,
  // `superseded`: a newer creator revision exists, so this older record is never written.
  state: z.enum(["pending", "confirmed", "uncertain", "unavailable", "superseded"]),
  receiptRef: opaqueRef.nullable(),
}).strict();
export type Handoff = z.infer<typeof handoffSchema>;

export const intakeResultSchema = z.object({
  kind: z.literal("creator-intake"),
  jobId: z.literal(JOB_ID),
  jobVersion: z.literal(JOB_VERSION),
  eventId: opaqueRef,
  recruitmentSource: z.enum(RECRUITMENT_SOURCES),
  creatorRef: sourceRefSchema.nullable(),
  profileRefs: z.array(sourceRefSchema),
  relationshipRefs: z.array(sourceRefSchema),
  campaignRef: sourceRefSchema.nullable(),
  briefRef: z.object({ ref: opaqueRef, version: opaqueRef }).strict().nullable(),
  identityState: z.enum(["resolved", "needsReview"]),
  watchlistEligibility: z.enum(["active", "identityPending", "excluded"]),
  evidenceRefs: z.array(evidenceRefSchema),
  reviewReasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  nextWork: z.enum(["J20", "J02"]).nullable(),
  handoffs: z.array(handoffSchema),
  checkpoint: z.object({ cursor: cursorSchema.nullable(), handoffKeys: z.array(opaqueRef) }).strict(),
  identityMapVersion: opaqueRef,
  suppressionVersion: opaqueRef,
  // Intake never scores, invites, messages, reserves a sample or pays. These stay false by construction.
  outbound: z.object({ scored: z.literal(false), invited: z.literal(false), messaged: z.literal(false), sampleReserved: z.literal(false), paid: z.literal(false) }).strict(),
}).strict();
export type IntakeResult = z.infer<typeof intakeResultSchema>;
