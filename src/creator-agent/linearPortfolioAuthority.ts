// Server-only. Official GraphQL query with a fixed origin and a finite, complete issue comment set.
import { z } from "zod";
import { digest } from "./config.ts";
import { portfolioActionSchema } from "./portfolio.ts";
import { portfolioInstant, portfolioSourceBindingSchema, type VerifiedPortfolioWeeklyEvent } from "./portfolioSources.ts";
import type { PortfolioDecisionAuthority, PortfolioScope, VerifiedPortfolioParticipation } from "./portfolioStore.ts";

const uuid = z.string().uuid();
const ref = z.string().trim().min(1).max(240);
const instant = portfolioInstant;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({ workspaceId: ref, accountId: ref }).strict();
const configSchema = z.object({
  scope: scopeSchema, organizationId: uuid, teamId: uuid, issueIds: z.array(uuid).min(1).max(100),
  founderUserIds: z.array(uuid).min(1).max(25), j04WriterBotIds: z.array(uuid).max(25).optional(),
  credential: z.object({ kind: z.enum(["api-key", "oauth"]), value: z.string().min(1).max(8192).regex(/^[^\s]+$/) }).strict().optional(),
  approvedLaunchAt: instant.nullable().optional(),
}).strict();
export type LinearPortfolioConfig = z.input<typeof configSchema>;

const base = z.object({
  schemaVersion: z.literal("farda.portfolio.linear.v1"), issueId: uuid, scope: scopeSchema,
  founderUserId: uuid, j04ReceiptRef: ref, decidedAt: instant, expiresAt: instant,
});
export const linearPortfolioManifestSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("decision"), revision: z.number().int().positive().safe(), reviewKey: hash,
    reviewHash: hash, decision: z.enum(["approved", "rejected"]), creatorDecisions: z.array(z.object({ creatorId: ref, action: portfolioActionSchema }).strict()).max(100) }).strict(),
  base.extend({ kind: z.literal("review-request"), eventId: ref, approved: z.boolean(), binding: portfolioSourceBindingSchema }).strict(),
]);
export type LinearPortfolioManifest = z.infer<typeof linearPortfolioManifestSchema>;

// Returned by the independently authenticated J04 receipt resolver. A caller cannot supply this object.
export const portfolioJ04OriginSchema = z.object({
  scope: scopeSchema, sourceRef: ref, linearRef: ref, manifestDigest: hash, founderUserId: uuid,
  origin: z.literal("slack-thread"), slackWorkspaceRef: ref, slackChannelRef: ref, slackThreadRef: ref, slackEventRef: ref,
  decision: z.enum(["approved", "rejected"]), state: z.enum(["current", "revoked", "canceled"]),
  decidedAt: instant, checkedAt: instant, validUntil: instant,
}).strict();
export type PortfolioJ04Origin = z.infer<typeof portfolioJ04OriginSchema>;
export interface LinearPortfolioSources {
  resolveJ04Origin?(sourceRef: string, scope: PortfolioScope): Promise<PortfolioJ04Origin | null>;
  resolveWeeklySnapshot?(sourceRef: string, eventId: string, scope: PortfolioScope): Promise<VerifiedPortfolioWeeklyEvent | null>;
  resolveParticipation?(sourceRef: string, scope: PortfolioScope): Promise<VerifiedPortfolioParticipation | null>;
}
export interface LinearPortfolioRuntime { fetch?: typeof fetch; now?: () => number }

const commentSchema = z.object({
  id: uuid, issueId: uuid, body: z.string().max(64_000), createdAt: instant,
  editedAt: instant.nullable(), archivedAt: instant.nullable(), parentId: uuid.nullable(),
  user: z.object({ id: uuid, active: z.boolean() }).nullable(), botActor: z.object({ id: uuid.nullable() }).nullable(),
  onBehalfOf: z.object({ id: uuid }).nullable(), externalUser: z.object({ id: ref }).nullable(),
  agentSession: z.object({ id: ref }).nullable(),
});
const resultSchema = z.object({ data: z.object({ organization: z.object({ id: uuid }), issue: z.object({
  id: uuid, archivedAt: instant.nullable(), trashed: z.boolean().nullable(), team: z.object({ id: uuid }),
  state: z.object({ type: z.string() }), comments: z.object({
    nodes: z.array(commentSchema).max(100), pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
}) }), errors: z.array(z.unknown()).max(0).optional() });
const query = `query PortfolioReceipt($id: String!) {
  organization { id }
  issue(id: $id) {
    id archivedAt trashed team { id } state { type }
    comments(first: 100, includeArchived: true) {
      nodes { id issueId body createdAt editedAt archivedAt parentId user { id active } botActor { id } onBehalfOf { id } externalUser { id } agentSession { id } }
      pageInfo { hasNextPage }
    }
  }
}`;
const sameScope = (a: PortfolioScope, b: PortfolioScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;

async function boundedJson(response: Response) {
  const limit = 524_288;
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { reader.releaseLock(); }
}

export function createLinearPortfolioAuthority(rawConfig: LinearPortfolioConfig, sources: LinearPortfolioSources = {}, runtime: LinearPortfolioRuntime = {}): PortfolioDecisionAuthority {
  const config = configSchema.parse(rawConfig);
  const request = runtime.fetch ?? fetch;
  const now = runtime.now ?? Date.now;
  const allowedBot = (id: string | null | undefined) => Boolean(id && config.j04WriterBotIds?.includes(id));
  const knownPublisher = (c: z.infer<typeof commentSchema>) => Boolean(c.user && config.founderUserIds.includes(c.user.id) || allowedBot(c.botActor?.id));
  async function currentRecord(issueId: string, commentId: string): Promise<LinearPortfolioManifest | null> {
    if (!config.credential || !config.issueIds.includes(issueId)) return null;
    const token = config.credential.kind === "oauth" ? "Bearer " + config.credential.value : config.credential.value;
    const response = await request("https://api.linear.app/graphql", {
      method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { id: issueId } }),
      redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5000),
    });
    const parsed = resultSchema.safeParse(await boundedJson(response));
    if (!parsed.success) return null;
    const { organization, issue } = parsed.data.data;
    if (organization.id !== config.organizationId || issue.id !== issueId || issue.team.id !== config.teamId
      || issue.archivedAt || issue.trashed === true || !["started", "unstarted", "completed"].includes(issue.state.type)
      || issue.comments.pageInfo.hasNextPage) return null;
    const target = issue.comments.nodes.find((c) => c.id === commentId);
    if (!target || target.issueId !== issueId || target.archivedAt || target.editedAt || target.parentId || target.externalUser
      || target.onBehalfOf || target.agentSession || !knownPublisher(target) || Date.parse(target.createdAt) > now()) return null;
    // Each configured issue is a dedicated decision thread. A later founder/J04 message, including
    // a revocation or edit, invalidates the older decision until the new exact manifest is verified.
    const created = Date.parse(target.createdAt);
    if (issue.comments.nodes.some((c) => c.id !== target.id && knownPublisher(c)
      && Math.max(...[c.createdAt, c.editedAt, c.archivedAt].filter((t): t is string => t !== null).map(Date.parse)) >= created)) return null;
    const body = target.body.trim();
    const fence = /^\x60{3}json\s*\n([\s\S]*?)\n\x60{3}$/.exec(body);
    const manifest = linearPortfolioManifestSchema.safeParse(JSON.parse(fence?.[1] ?? body));
    if (!manifest.success) return null;
    const m = manifest.data;
    if (!sameScope(m.scope, config.scope) || m.issueId !== issueId || !config.founderUserIds.includes(m.founderUserId)
      || Date.parse(m.decidedAt) > created || Date.parse(m.expiresAt) <= now()) return null;
    const writerAllowed = target.botActor ? allowedBot(target.botActor.id) : target.user?.active === true && target.user.id === m.founderUserId;
    return writerAllowed ? m : null;
  }
  async function verify(locator: string, scope: PortfolioScope) {
    const [prefix, issueId, commentId, extra] = locator.split(":");
    if (!sameScope(scope, config.scope) || prefix !== "linear" || extra !== undefined || !uuid.safeParse(issueId).success || !uuid.safeParse(commentId).success
      || !issueId || !commentId || !sources.resolveJ04Origin || !config.credential) return null;
    try {
      const manifest = await currentRecord(issueId, commentId);
      if (!manifest) return null;
      const manifestDigest = digest(manifest);
      const raw = await sources.resolveJ04Origin(manifest.j04ReceiptRef, scope);
      const origin = portfolioJ04OriginSchema.safeParse(raw);
      if (!origin.success) return null;
      const receipt = origin.data;
      const expectedDecision = manifest.kind === "decision" ? manifest.decision : manifest.approved ? "approved" : "rejected";
      if (!sameScope(receipt.scope, scope) || receipt.state !== "current" || receipt.sourceRef !== manifest.j04ReceiptRef
        || receipt.linearRef !== locator || receipt.manifestDigest !== manifestDigest || receipt.founderUserId !== manifest.founderUserId
        || receipt.decidedAt !== manifest.decidedAt || receipt.decision !== expectedDecision
        || Date.parse(receipt.checkedAt) < Date.parse(receipt.decidedAt) || Date.parse(receipt.checkedAt) > now()) return null;
      // Re-read the actual Linear record after J04 resolution; edits/cancellations during either read hold the decision.
      const current = await currentRecord(issueId, commentId);
      const expiry = Math.min(Date.parse(manifest.expiresAt), Date.parse(receipt.validUntil));
      if (!current || digest(current) !== manifestDigest || expiry <= now()) return null;
      return { manifest, proof: { issueId, commentId, j04ReceiptRef: receipt.sourceRef, manifestDigest, expiresAt: new Date(expiry).toISOString() } };
    } catch { return null; } // Private provider errors/body/credential values never enter service responses.
  }
  return {
    mode: "source-verified", approvedLaunchAt: config.approvedLaunchAt,
    resolveWeeklyEvent: async (ref, eventId, scope) => sameScope(scope, config.scope) ? await sources.resolveWeeklySnapshot?.(ref, eventId, scope) ?? null : null,
    resolveParticipation: async (ref, scope) => sameScope(scope, config.scope) ? await sources.resolveParticipation?.(ref, scope) ?? null : null,
    resolveDecision: async (ref, scope) => {
      const record = await verify(ref, scope);
      if (!record || record.manifest.kind !== "decision") return null;
      const m = record.manifest;
      return { scope, linearDecisionRef: ref, reviewKey: m.reviewKey, revision: m.revision, reviewHash: m.reviewHash,
        decision: m.decision, decidedAt: m.decidedAt, founderRef: m.founderUserId, creatorDecisions: m.creatorDecisions, linearProof: record.proof };
    },
    resolveOnDemandApproval: async (ref, eventId, scope) => {
      const record = await verify(ref, scope);
      if (!record || record.manifest.kind !== "review-request" || record.manifest.eventId !== eventId) return null;
      return { scope, approvalRef: ref, eventId, approved: record.manifest.approved, binding: record.manifest.binding, linearProof: record.proof };
    },
  };
}
