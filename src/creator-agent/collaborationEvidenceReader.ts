import type { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { AgentConflict } from "./store.ts";
import { assetRightsSchema, sameAssetScope, type AssetAuthority, type AssetScope, type StoredAsset } from "./assets.ts";
import { collaborationEvidenceSchema, type CollaborationEvidenceRecord } from "./collaborationEvidence.ts";
import type { StoredPortfolioReview, StoredPortfolioDecision, StoredPortfolioParticipation } from "./portfolioStore.ts";

const marksSchema = z.object({ assets: z.number().int().nonnegative(), reviews: z.number().int().nonnegative(), decisions: z.number().int().nonnegative(), participation: z.number().int().nonnegative() }).strict();
const cursorSchema = z.object({ collaborationId: z.string(), scope: z.string(), marks: marksSchema,
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), expiresAt: z.number().int() }).strict();
const requestSchema = z.object({ collaborationId: z.string().min(1).max(240), cursor: z.string().max(4100).nullable(), limit: z.number().int().min(1).max(100) }).strict();
type Marks = z.infer<typeof marksSchema>;

/** Exact collaboration membership is evaluated in SQLite before applying the page bound. */
const sourceSql = `
 SELECT 'asset/'||a.asset_id||'/'||a.version AS key,'asset' AS kind,a.body AS body,NULL AS creator_id,NULL AS source_mode
 FROM creator_assets a WHERE a.rowid<=? AND json_extract(a.body,'$.submission.collaborationId')=?
 UNION ALL
 SELECT 'review/'||r.review_key||'/'||r.revision||'/'||json_extract(c.value,'$.creatorId'),'review',r.body,json_extract(c.value,'$.creatorId'),NULL
 FROM portfolio_reviews r,json_each(r.body,'$.packet.creators') c
 WHERE r.rowid<=? AND EXISTS(SELECT 1 FROM json_each(c.value,'$.collaborations') x WHERE json_extract(x.value,'$.collaborationId')=?)
 UNION ALL
 SELECT 'decision/'||json_extract(d.body,'$.decisionId')||'/'||json_extract(c.value,'$.creatorId'),'decision',d.body,json_extract(c.value,'$.creatorId'),json_extract(d.body,'$.sourceMode')
 FROM portfolio_decisions d JOIN portfolio_reviews r ON r.review_key=d.review_key AND r.revision=d.revision,json_each(r.body,'$.packet.creators') c
 WHERE d.rowid<=? AND EXISTS(SELECT 1 FROM json_each(c.value,'$.collaborations') x WHERE json_extract(x.value,'$.collaborationId')=?)
 AND EXISTS(SELECT 1 FROM json_each(d.body,'$.creatorDecisions') x WHERE json_extract(x.value,'$.creatorId')=json_extract(c.value,'$.creatorId'))
 UNION ALL
 SELECT 'participation/'||p.participation_id,'participation',p.body,p.creator_id,json_extract(d.body,'$.sourceMode')
 FROM portfolio_participation p JOIN portfolio_decisions d ON d.decision_id=p.decision_id
 JOIN portfolio_reviews r ON r.review_key=d.review_key AND r.revision=d.revision,json_each(r.body,'$.packet.creators') c
 WHERE p.rowid<=? AND json_extract(c.value,'$.creatorId')=p.creator_id AND
 (EXISTS(SELECT 1 FROM json_each(c.value,'$.collaborations') x WHERE json_extract(x.value,'$.collaborationId')=?)
 OR EXISTS(SELECT 1 FROM json_each(p.body,'$.nextCollaborationIds') x WHERE x.value=?))`;

export function createCollaborationEvidenceReader(db: DatabaseSync, scope: AssetScope, secret: string, authority?: AssetAuthority, now = Date.now) {
  const bound = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if (!bound || bound.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
  const key = createHmac("sha256", secret).update("collaboration-evidence.v1").digest();
  const scopeHash = createHmac("sha256", key).update(JSON.stringify(scope)).digest("hex");
  const opaque = (raw: string) => "evidence:" + createHmac("sha256", key).update(raw).digest("hex");
  const safeId = (raw: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(raw) ? raw : opaque(raw);
  const encode = (data: z.infer<typeof cursorSchema>) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url");
  };
  const decode = (token: string) => {
    try {
      if (!/^[A-Za-z0-9_-]{40,4100}$/.test(token)) throw new Error();
      const bytes = Buffer.from(token, "base64url");
      if (bytes.toString("base64url") !== token || bytes.length < 29) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return cursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8")));
    } catch { throw new AgentConflict("INVALID_EVIDENCE_CURSOR"); }
  };
  const marks = (): Marks => ({
    assets: Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM creator_assets").get()!.n),
    reviews: Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM portfolio_reviews").get()!.n),
    decisions: Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM portfolio_decisions").get()!.n),
    participation: Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM portfolio_participation").get()!.n),
  });
  async function project(row: Record<string, unknown>, observations: Map<string, z.infer<typeof assetRightsSchema>>): Promise<CollaborationEvidenceRecord> {
    const common = { id: opaque(String(row.key)) };
    const body = JSON.parse(String(row.body));
    const creatorId = String(row.creator_id);
    if (row.kind === "asset") {
      const asset = body as StoredAsset;
      let rights: z.infer<typeof assetRightsSchema> | null = null;
      try {
        const result = assetRightsSchema.safeParse(await authority?.currentRights(asset, scope));
        if (result.success) {
          const r = result.data;
          const current = now();
          if (sameAssetScope(scope, r.scope) && r.assetId === asset.submission.assetId && r.assetVersion === asset.version
            && r.submissionHash === asset.submissionHash && r.checksum === asset.sourceEvidence.checksum
            && r.productId === asset.submission.productId && r.productRevision === asset.submission.productRevision
            && Date.parse(r.observedAt) <= current && Date.parse(r.validUntil) > current) rights = r;
        }
      } catch { /* An unavailable rights observation has an explicit unknown projection. */ }
      const s = asset.submission;
      if (rights) observations.set(common.id, rights);
      return { ...common, kind: "asset", assetId: s.assetId, version: asset.version, fileVersion: s.fileVersion,
        productId: s.productId, productRevision: s.productRevision, recordedAt: asset.recordedAt,
        parentAssetId: s.lineage?.parentAssetId ?? null, parentVersion: s.lineage?.parentVersion ?? null,
        availability: asset.sourceEvidence.availability, reviewState: "unknown", rightsState: "unknown", rightsObservedAt: null };
    }
    if (row.kind === "review") {
      const review = body as StoredPortfolioReview;
      const recommendation = review.proposal.recommendations.find(r => r.creatorId === creatorId)!;
      // Old records have no provenance. Only the explicit source-verified form is affirmative.
      const provenance = body.sourceEvidence as { mode?: string } | undefined;
      return { ...common, kind: "review", reviewKey: review.reviewKey, revision: review.revision, creatorId: safeId(creatorId),
        recordedAt: review.recordedAt, action: recommendation.action, sourceVerified: provenance?.mode === "verified-weekly" || provenance?.mode === "verified-on-demand" };
    }
    if (row.kind === "decision") {
      const decision = body as StoredPortfolioDecision;
      return { ...common, kind: "decision", reviewKey: decision.reviewKey, revision: decision.revision, creatorId: safeId(creatorId),
        recordedAt: decision.recordedAt, action: decision.creatorDecisions.find(c => c.creatorId === creatorId)!.action,
        decision: decision.decision, decidedAt: decision.decidedAt, linearDecisionRef: opaque(decision.linearDecisionRef), sourceVerified: row.source_mode === "source-verified" };
    }
    const participation = body as StoredPortfolioParticipation;
    return { ...common, kind: "participation", creatorId: safeId(participation.creatorId), decisionId: participation.decisionId,
      recordedAt: participation.recordedAt, state: participation.state, occurredAt: participation.occurredAt, sourceReceiptRef: opaque(participation.sourceReceiptRef), sourceVerified: row.source_mode === "source-verified" && body.sourceMode === "source-verified" };
  }
  return async (raw: unknown) => {
    const input = requestSchema.parse(raw);
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (cursor && (cursor.scope !== scopeHash || cursor.collaborationId !== input.collaborationId || cursor.limit !== input.limit)) throw new AgentConflict("INVALID_EVIDENCE_CURSOR");
    if (cursor && cursor.expiresAt <= now()) throw new AgentConflict("EVIDENCE_CURSOR_EXPIRED");
    const snapshot = cursor?.marks ?? marks();
    const args = [snapshot.assets, input.collaborationId, snapshot.reviews, input.collaborationId, snapshot.decisions, input.collaborationId, snapshot.participation, input.collaborationId, input.collaborationId];
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM (${sourceSql})`).get(...args)!.n);
    const offset = cursor?.offset ?? 0;
    if (offset > total) throw new AgentConflict("EVIDENCE_SNAPSHOT_UNAVAILABLE");
    const rows = db.prepare(`SELECT * FROM (${sourceSql}) ORDER BY key LIMIT ? OFFSET ?`).all(...args, input.limit, offset);
    const observations = new Map<string, z.infer<typeof assetRightsSchema>>();
    const records = await Promise.all(rows.map(row => project(row, observations)));
    const observedAt = now();
    for (const record of records) {
      if (record.kind !== "asset") continue;
      const rights = observations.get(record.id);
      const current = rights && Date.parse(rights.observedAt) <= observedAt && Date.parse(rights.validUntil) > observedAt;
      if (!current) continue;
      record.reviewState = rights.review;
      if (rights.review === "accepted" && (rights.acceptedVersion !== record.version || !rights.approvalVersion)) record.reviewState = "pending";
      record.rightsState = rights.status;
      if (rights.status === "granted") {
        if (!rights.startsAt || !rights.endsAt || Date.parse(rights.startsAt) >= Date.parse(rights.endsAt)) record.rightsState = "unknown";
        else if (Date.parse(rights.endsAt) <= observedAt) record.rightsState = "expired";
        else if (Date.parse(rights.startsAt) > observedAt) record.rightsState = "pending";
      }
      record.rightsObservedAt = rights.observedAt;
    }
    const hasMore = offset + records.length < total;
    const nextCursor = hasMore ? encode({ collaborationId: input.collaborationId, scope: scopeHash, marks: snapshot,
      offset: offset + records.length, limit: input.limit, expiresAt: cursor?.expiresAt ?? now() + 15 * 60_000 }) : null;
    return { data: collaborationEvidenceSchema.parse({ kind: "collaboration-evidence", source: "saved-agent-records", collaborationId: input.collaborationId,
      observedAt: new Date(observedAt).toISOString(), records, total, offset, hasMore }), nextCursor };
  };
}
