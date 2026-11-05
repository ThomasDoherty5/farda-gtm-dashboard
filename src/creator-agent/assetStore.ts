import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./config.ts";
import {
  assetIdSchema, assetScopeSchema, assetSubmissionSchema, assetUseSchema, sourceEvidenceSchema,
  assetRightsSchema, deploymentRequestSchema, deploymentEvidenceSchema, destinationEvidenceSchema, sourceReferenceSchema,
  withdrawalEvidenceSchema, evaluateAssetUse, sameAssetScope, unavailableAssetAuthority,
} from "./assets.ts";
import type {
  AssetScope, AssetAuthority, AssetSubmission, StoredAsset, AssetUse, AssetEligibility,
  AssetExport, AssetDeployment, DeploymentRequest, WithdrawalIntent, AssetSourceReference,
} from "./assets.ts";

export class AssetError extends Error {
  code: string;
  status: number;
  reasons: string[];
  constructor(code: string, status = 409, reasons: string[] = []) {
    super(code); this.code = code; this.status = status; this.reasons = reasons;
  }
}
export const assetIngestSchema = z.object({ scope: assetScopeSchema, expectedVersion: z.number().int().nonnegative(), submission: assetSubmissionSchema }).strict();
export const assetUseRequestSchema = z.object({ scope: assetScopeSchema, use: assetUseSchema }).strict();
export const assetDeploymentRequestSchema = z.object({ scope: assetScopeSchema, deployment: deploymentRequestSchema }).strict();
export const assetRightsReconcileSchema = z.object({
  scope: assetScopeSchema, assetId: assetIdSchema,
  cursor: z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).nullable().optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const assetWithdrawalRequestSchema = z.object({ scope: assetScopeSchema, receiptRef: sourceReferenceSchema }).strict();
export const assetSearchSchema = z.object({
  query: z.string().max(240).optional(), campaignId: assetIdSchema.optional(),
  creatorId: assetIdSchema.optional(), productId: assetIdSchema.optional(), productRevision: assetIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(100_000).default(0),
}).strict();
const enrichedSearchSchema = assetSearchSchema.extend({
  review: z.enum(["pending", "accepted", "rejected", "unknown"]).optional(),
  rightsState: z.enum(["unknown", "pending", "granted", "expired", "revoked"]).optional(),
  publicationNetwork: assetIdSchema.optional(),
}).strict();

/** Tables share the authenticated service's existing SQLite handle and scope. Owns no files or rights. */
export class AssetRepository {
  private db: DatabaseSync;
  readonly scope: AssetScope;
  private authority: AssetAuthority;
  private clock: () => string;
  constructor(db: DatabaseSync, scope: AssetScope,
    authority: AssetAuthority = unavailableAssetAuthority, clock = () => new Date().toISOString()) {
    this.db = db; this.scope = scope; this.authority = authority; this.clock = clock;
    assetScopeSchema.parse(scope);
    const bound = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (bound?.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId) throw new AssetError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`
      CREATE TABLE IF NOT EXISTS creator_assets (asset_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(asset_id,version));
      CREATE TABLE IF NOT EXISTS creator_asset_exports (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_asset_deployments (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, receipt_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_asset_deployment_state (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_asset_withdrawals (id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, deployment_version INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(deployment_id,deployment_version));
      CREATE TABLE IF NOT EXISTS creator_asset_withdrawal_events (receipt_key TEXT PRIMARY KEY, intent_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_asset_scan_cursors (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, after_row INTEGER NOT NULL, snapshot_max INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creator_asset_requests (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL);
    `);
  }
  private checkScope(scope: AssetScope) { if (!sameAssetScope(this.scope, scope)) throw new AssetError("SCOPE_DENIED", 403); }
  private prior<T>(key: string, input: unknown): T | null {
    if (!key.trim() || key.length > 240) throw new AssetError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const row = this.db.prepare("SELECT request_hash,response FROM creator_asset_requests WHERE key=?").get(key);
    if (!row) return null;
    if (row.request_hash !== digest(input)) throw new AssetError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(String(row.response)) as T;
  }
  private write<T>(key: string, input: unknown, action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.prior<T>(key, input);
      if (prior) { this.db.exec("COMMIT"); return prior; }
      const value = action();
      this.db.prepare("INSERT INTO creator_asset_requests VALUES(?,?,?)").run(key, digest(input), JSON.stringify(value));
      this.db.exec("COMMIT");
      return value;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(assetId: string, version?: number): StoredAsset | null {
    assetIdSchema.parse(assetId);
    if (version !== undefined) z.number().int().positive().parse(version);
    const row = version === undefined
      ? this.db.prepare("SELECT body FROM creator_assets WHERE asset_id=? ORDER BY version DESC LIMIT 1").get(assetId)
      : this.db.prepare("SELECT body FROM creator_assets WHERE asset_id=? AND version=?").get(assetId, version);
    return row ? JSON.parse(String(row.body)) as StoredAsset : null;
  }
  private required(assetId: string, version?: number) {
    const asset = this.get(assetId, version);
    if (!asset) throw new AssetError("ASSET_NOT_FOUND", 404);
    return asset;
  }
  list(input: z.input<typeof assetSearchSchema> = {}) {
    const filters = assetSearchSchema.parse(input);
    const where: string[] = [];
    const params: string[] = [];
    for (const field of ["campaignId", "creatorId", "productId", "productRevision"] as const) {
      if (filters[field]) { where.push(`json_extract(a.body,'$.submission.${field}')=?`); params.push(filters[field]); }
    }
    if (filters.query) {
      where.push("instr(lower(json_extract(a.body,'$.submission.useCase') || ' ' || json_extract(a.body,'$.submission.concept') || ' ' || json_extract(a.body,'$.submission.hook') || ' ' || json_extract(a.body,'$.submission.format')),?)>0");
      params.push(filters.query.toLowerCase());
    }
    const from = `FROM creator_assets a INNER JOIN (SELECT asset_id,MAX(version) AS version FROM creator_assets GROUP BY asset_id) l ON a.asset_id=l.asset_id AND a.version=l.version ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...params)?.count ?? 0);
    const records = this.db.prepare(`SELECT a.body ${from} ORDER BY a.asset_id LIMIT ? OFFSET ?`).all(...params, filters.limit, filters.offset).map((r) => JSON.parse(String(r.body)) as StoredAsset);
    return { records, total, nextOffset: filters.offset + records.length < total ? filters.offset + records.length : null };
  }
  /** Live rights fields come from J09. Filtering a bounded candidate page exposes scan coverage. */
  async search(raw: unknown = {}) {
    const { review, rightsState, publicationNetwork, ...filters } = enrichedSearchSchema.parse(raw);
    const page = this.list(filters);
    const records = await Promise.all(page.records.map(async (asset) => {
      const observed = await this.authority.currentRights(asset, this.scope);
      const rights = observed ? assetRightsSchema.parse(observed) : null;
      const now = Date.parse(this.clock());
      const bound = rights && sameAssetScope(rights.scope, this.scope) && rights.assetId === asset.submission.assetId && rights.assetVersion === asset.version && rights.submissionHash === asset.submissionHash && rights.checksum === asset.sourceEvidence.checksum && Date.parse(rights.observedAt) <= now && Date.parse(rights.validUntil) > now;
      const reviewState = bound ? rights.review : "unknown";
      const currentRights = bound ? (rights.status === "granted" && rights.endsAt && Date.parse(rights.endsAt) <= now ? "expired" : rights.status) : "unknown";
      const networks = [...new Set(this.deployments(asset.submission.assetId).filter((d) => d.assetVersion === asset.version).map((d) => d.destination.provider))];
      return { asset, reviewState, rightsState: currentRights, publicationNetworks: networks };
    }));
    return {
      records: records.filter((r) => (!review || r.reviewState === review) && (!rightsState || r.rightsState === rightsState) && (!publicationNetwork || r.publicationNetworks.includes(publicationNetwork))),
      candidateTotal: page.total, scanned: records.length, nextOffset: page.nextOffset,
      coverage: page.nextOffset === null && filters.offset === 0 ? "complete" : "partial",
    };
  }
  async ingest(raw: unknown, key: string): Promise<StoredAsset> {
    const input = assetIngestSchema.parse(raw); this.checkScope(input.scope);
    const operation = { operation: "ingest", input };
    const prior = this.prior<StoredAsset>(key, operation); if (prior) return prior;
    const source = await this.authority.resolveSource(input.submission, this.scope);
    if (!source) throw new AssetError("SOURCE_AUTHORITY_UNAVAILABLE");
    const evidence = sourceEvidenceSchema.parse(source);
    const hash = digest(input.submission);
    if (!sameAssetScope(evidence.scope, this.scope) || evidence.submissionHash !== hash) throw new AssetError("SOURCE_AUTHORITY_MISMATCH", 403);
    if (Date.parse(evidence.observedAt) > Date.parse(this.clock())) throw new AssetError("SOURCE_OBSERVATION_INVALID");
    return this.write(key, operation, () => {
      const previous = this.get(input.submission.assetId);
      if ((previous?.version ?? 0) !== input.expectedVersion) throw new AssetError("ASSET_VERSION_CONFLICT");
      if (previous) {
        for (const field of ["creatorId", "collaborationId", "deliverableId"] as const)
          if (previous.submission[field] !== input.submission[field]) throw new AssetError("ASSET_OWNERSHIP_IMMUTABLE");
        if (previous.sourceEvidence.checksum !== evidence.checksum && previous.submission.fileVersion === input.submission.fileVersion) throw new AssetError("FILE_VERSION_REUSED");
      }
      const lineage = input.submission.lineage;
      if (lineage) {
        if (lineage.parentAssetId === input.submission.assetId) throw new AssetError("LINEAGE_CYCLE");
        const parent = this.required(lineage.parentAssetId, lineage.parentVersion);
        for (const field of ["creatorId", "collaborationId", "deliverableId"] as const)
          if (parent.submission[field] !== input.submission[field]) throw new AssetError("LINEAGE_OWNERSHIP_MISMATCH");
        // A derivative is tied to the same agreed original; duplicate files in other campaigns stay independent assets.
        if (this.lineage(parent).length >= 20) throw new AssetError("LINEAGE_CYCLE_OR_LIMIT");
      }
      const record: StoredAsset = { submission: input.submission, version: input.expectedVersion + 1,
        recordedAt: this.clock(), submissionHash: hash, sourceEvidence: evidence,
        storageIdentity: evidence.checksum ? digest({ scope: this.scope, checksum: evidence.checksum }) : null };
      this.db.prepare("INSERT INTO creator_assets VALUES(?,?,?)").run(record.submission.assetId, record.version, JSON.stringify(record));
      return record;
    });
  }
  private lineage(asset: StoredAsset) {
    const chain: StoredAsset[] = []; const visited = new Set<string>(); let current = asset;
    for (;;) {
      const key = `${current.submission.assetId}:${current.version}`;
      if (visited.has(key) || chain.length >= 20) throw new AssetError("LINEAGE_CYCLE_OR_LIMIT");
      visited.add(key); chain.push(current);
      const parent = current.submission.lineage;
      if (!parent) return chain;
      current = this.required(parent.parentAssetId, parent.parentVersion);
    }
  }
  private async destinationReasons(use: AssetUse): Promise<string[]> {
    const observed = await this.authority.resolveDestination(use, this.scope);
    if (!observed) return ["DESTINATION_AUTHORITY_UNAVAILABLE"];
    const evidence = destinationEvidenceSchema.parse(observed);
    if (!sameAssetScope(evidence.scope, this.scope) || digest(evidence.destination) !== digest(use.destination)
      || evidence.kind !== use.kind || evidence.channel !== use.channel || evidence.territory !== use.territory) return ["DESTINATION_SCOPE_MISMATCH"];
    const now = Date.parse(this.clock());
    if (Date.parse(evidence.observedAt) > now || Date.parse(evidence.validUntil) <= now) return ["DESTINATION_OBSERVATION_STALE"];
    return [];
  }
  async eligibility(raw: unknown): Promise<AssetEligibility> {
    const input = assetUseRequestSchema.parse(raw); this.checkScope(input.scope);
    const asset = this.required(input.use.assetId, input.use.version);
    const records = this.lineage(asset);
    const chain = await Promise.all(records.map(async (record) => {
      const [rights, source] = await Promise.all([this.authority.currentRights(record, this.scope), this.authority.resolveSource(record.submission, this.scope)]);
      const currentSource = source ? sourceEvidenceSchema.parse(source) : null;
      const validSource = currentSource && sameAssetScope(currentSource.scope, this.scope) && currentSource.submissionHash === record.submissionHash && currentSource.checksum === record.sourceEvidence.checksum && Date.parse(currentSource.observedAt) <= Date.parse(this.clock());
      return { asset: { ...record, sourceEvidence: validSource ? currentSource : { ...record.sourceEvidence, availability: "unavailable" as const } }, rights: rights ? assetRightsSchema.parse(rights) : null };
    }));
    const destinationReasons = await this.destinationReasons(input.use);
    // Check rights time bounds after the final awaited authority lookup, not before a slow
    // destination lookup that could cross a permission's expiry or observation lifetime.
    const result = evaluateAssetUse(asset, input.use, this.scope, chain, this.clock());
    if (destinationReasons.length) { result.state = "blocked"; result.reasonCodes.push(...destinationReasons); }
    if (this.required(input.use.assetId).version !== input.use.version) {
      result.state = "blocked"; result.reasonCodes.push("ASSET_SUPERSEDED");
    }
    return result;
  }
  async prepareExport(raw: unknown, key: string): Promise<AssetExport> {
    const input = assetUseRequestSchema.parse(raw); this.checkScope(input.scope);
    const operation = { operation: "export", input };
    const prior = this.prior<AssetExport>(key, operation); if (prior) return prior;
    const eligibility = await this.eligibility(input);
    if (eligibility.state !== "eligible") throw new AssetError("ASSET_USE_BLOCKED", 409, eligibility.reasonCodes);
    return this.write(key, operation, () => {
      if (this.required(input.use.assetId).version !== input.use.version) throw new AssetError("ASSET_VERSION_CONFLICT");
      const result: AssetExport = { id: randomUUID(), assetId: input.use.assetId, version: input.use.version,
        use: input.use, preparedAt: this.clock(), state: "prepared", externalEffect: "none", eligibility };
      this.db.prepare("INSERT INTO creator_asset_exports VALUES(?,?,?)").run(result.id, result.assetId, JSON.stringify(result));
      return result;
    });
  }
  exports(assetId: string): AssetExport[] {
    return this.db.prepare("SELECT body FROM creator_asset_exports WHERE asset_id=? ORDER BY id").all(assetId).map((r) => JSON.parse(String(r.body)) as AssetExport);
  }
  private export(id: string) {
    const row = this.db.prepare("SELECT body FROM creator_asset_exports WHERE id=?").get(id);
    if (!row) throw new AssetError("EXPORT_NOT_FOUND", 404);
    return JSON.parse(String(row.body)) as AssetExport;
  }
  async observeDeployment(raw: unknown, key: string): Promise<AssetDeployment> {
    const input = assetDeploymentRequestSchema.parse(raw); this.checkScope(input.scope);
    const operation = { operation: "deployment", input };
    const prior = this.prior<AssetDeployment>(key, operation); if (prior) return prior;
    this.required(input.deployment.assetId, input.deployment.version);
    const observed = await this.authority.verifyDeployment(input.deployment, this.scope);
    if (!observed) throw new AssetError("DEPLOYMENT_AUTHORITY_UNAVAILABLE");
    const evidence = deploymentEvidenceSchema.parse(observed);
    if (!sameAssetScope(evidence.scope, this.scope) || evidence.assetId !== input.deployment.assetId || evidence.assetVersion !== input.deployment.version || evidence.exportId !== input.deployment.exportId || digest(evidence.receiptRef) !== digest(input.deployment.receiptRef)) throw new AssetError("DEPLOYMENT_BINDING_MISMATCH", 403);
    if (Date.parse(evidence.observedAt) > Date.parse(this.clock())) throw new AssetError("DEPLOYMENT_OBSERVATION_INVALID");
    const id = digest({ scope: this.scope, assetId: evidence.assetId, version: evidence.assetVersion, kind: evidence.kind, destination: evidence.destination });
    if (evidence.kind === "reuse") {
      if (!evidence.exportId) throw new AssetError("EXPORT_REQUIRED");
      const exp = this.export(evidence.exportId);
      if (exp.assetId !== evidence.assetId || exp.version !== evidence.assetVersion || digest(exp.use.destination) !== digest(evidence.destination)) throw new AssetError("EXPORT_DESTINATION_MISMATCH");
      const existingRow = this.db.prepare("SELECT body FROM creator_asset_deployment_state WHERE id=?").get(id);
      const existing = existingRow ? JSON.parse(String(existingRow.body)) as AssetDeployment : null;
      // A deleted placement may no longer be queryable. Its verified removal is still a fact
      // about the exact known deployment/export; recording it grants no future reuse permission.
      const knownRemoval = evidence.state === "removed" && existing !== null && existing.exportId === exp.id;
      if (!knownRemoval) {
        const reasons = await this.destinationReasons(exp.use);
        if (reasons.length) throw new AssetError("DEPLOYMENT_DESTINATION_UNVERIFIED", 409, reasons);
      }
    } else if (evidence.exportId) throw new AssetError("CREATOR_PUBLICATION_IS_NOT_EXPORT");
    return this.write(key, operation, () => {
      const receiptKey = digest(evidence.receiptRef);
      const old = this.db.prepare("SELECT body FROM creator_asset_deployments WHERE receipt_key=?").get(receiptKey);
      if (old) {
        const record = JSON.parse(String(old.body)) as AssetDeployment;
        if (digest(record) !== digest({ ...evidence, id: record.id })) throw new AssetError("DEPLOYMENT_RECEIPT_CONFLICT");
        return record;
      }
      const record: AssetDeployment = { ...evidence, id };
      const currentRow = this.db.prepare("SELECT body FROM creator_asset_deployment_state WHERE id=?").get(id);
      const current = currentRow ? JSON.parse(String(currentRow.body)) as AssetDeployment : null;
      if (current && current.sourceVersion === record.sourceVersion && (current.state !== record.state || current.exportId !== record.exportId)) throw new AssetError("DEPLOYMENT_SOURCE_VERSION_CONFLICT");
      // Immutable observations retain every receipt. The stable deployment projection never regresses
      // because an older active receipt arrives after a newer removal receipt.
      this.db.prepare("INSERT INTO creator_asset_deployments VALUES(?,?,?,?)").run(randomUUID(), record.assetId, receiptKey, JSON.stringify(record));
      if (!current || record.sourceVersion > current.sourceVersion || record.sourceVersion === current.sourceVersion && Date.parse(record.observedAt) >= Date.parse(current.observedAt))
        this.db.prepare("INSERT INTO creator_asset_deployment_state VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(id, record.assetId, JSON.stringify(record));
      return record;
    });
  }
  deployments(assetId: string): AssetDeployment[] {
    return this.db.prepare("SELECT body FROM creator_asset_deployment_state WHERE asset_id=? ORDER BY id").all(assetId).map((r) => JSON.parse(String(r.body)) as AssetDeployment);
  }
  deploymentObservations(assetId: string): AssetDeployment[] {
    return this.db.prepare("SELECT body FROM creator_asset_deployments WHERE asset_id=? ORDER BY rowid").all(assetId).map((r) => JSON.parse(String(r.body)) as AssetDeployment);
  }
  withdrawals(assetId: string): WithdrawalIntent[] {
    return this.db.prepare("SELECT body FROM creator_asset_withdrawals WHERE json_extract(body,'$.assetId')=? ORDER BY id").all(assetId).map((r) => JSON.parse(String(r.body)) as WithdrawalIntent);
  }
  async reconcileRights(raw: unknown, key: string) {
    const input = assetRightsReconcileSchema.parse(raw); this.checkScope(input.scope); this.required(input.assetId);
    const operation = { operation: "rights_reconcile", input };
    const prior = this.prior<{ impacts: { exportId: string; eligibility: AssetEligibility }[]; intents: WithdrawalIntent[];
      scanned: number; snapshotMaxRow: number; nextCursor: string | null; scanFinished: boolean }>(key, operation); if (prior) return prior;
    // Include descendants: revoking a parent license must invalidate reuse of its derived assets.
    const maximum = Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS value FROM creator_asset_exports").get()?.value ?? 0);
    let after = 0; let snapshotMaxRow = maximum;
    if (input.cursor) {
      const cursor = this.db.prepare("SELECT asset_id,after_row,snapshot_max FROM creator_asset_scan_cursors WHERE id=?").get(input.cursor);
      if (!cursor || cursor.asset_id !== input.assetId) throw new AssetError("INVALID_RECONCILIATION_CURSOR", 400);
      after = Number(cursor.after_row); snapshotMaxRow = Number(cursor.snapshot_max);
    }
    const rows = this.db.prepare("SELECT rowid AS cursor,body FROM creator_asset_exports WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(after, snapshotMaxRow, input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const all = page.map((r) => JSON.parse(String(r.body)) as AssetExport);
    const nextCursor = hasMore ? randomUUID() : null;
    const affected = all.filter((exp) => this.lineage(this.required(exp.assetId, exp.version)).some((a) => a.submission.assetId === input.assetId));
    const impacts = await Promise.all(affected.map(async (exp) => ({ exportId: exp.id, eligibility: await this.eligibility({ scope: this.scope, use: exp.use }) })));
    return this.write(key, operation, () => {
      const intents: WithdrawalIntent[] = [];
      for (const impact of impacts.filter((item) => item.eligibility.state === "blocked")) {
        const exp = this.export(impact.exportId);
        for (const deployment of this.deployments(exp.assetId).filter((d) => d.exportId === exp.id && d.kind === "reuse" && d.state !== "removed")) {
          const existing = this.db.prepare("SELECT body FROM creator_asset_withdrawals WHERE deployment_id=? ORDER BY deployment_version DESC LIMIT 1").get(deployment.id);
          if (existing) {
            const intent = JSON.parse(String(existing.body)) as WithdrawalIntent;
            // A real reactivation after confirmation is a new withdrawal generation. Older source
            // receipts and the prior confirmed intent remain immutable and cannot satisfy this one.
            if (intent.state !== "confirmed" || deployment.state !== "active" || deployment.sourceVersion <= intent.deploymentSourceVersion) { intents.push(intent); continue; }
          }
          const intent: WithdrawalIntent = { id: randomUUID(), deploymentId: deployment.id, exportId: exp.id,
            deploymentSourceVersion: deployment.sourceVersion,
            assetId: exp.assetId, version: exp.version, owner: exp.use.kind === "paid_ad" ? "paid_media" : "content_reuse",
            state: "proposed", reasonCodes: impact.eligibility.reasonCodes, createdAt: this.clock(), reconciliationReceipts: [] };
          this.db.prepare("INSERT INTO creator_asset_withdrawals VALUES(?,?,?,?)").run(intent.id, deployment.id, intent.deploymentSourceVersion, JSON.stringify(intent)); intents.push(intent);
        }
      }
      // A checkpoint freezes the append-only export watermark. New exports belong to the next scan.
      // Consumers must traverse every page; an empty impact page is not an all-clear result.
      if (nextCursor) this.db.prepare("INSERT INTO creator_asset_scan_cursors VALUES(?,?,?,?)").run(nextCursor, input.assetId, Number(page.at(-1)!.cursor), snapshotMaxRow);
      return { impacts, intents, scanned: page.length, snapshotMaxRow, nextCursor, scanFinished: !hasMore };
    });
  }
  async reconcileWithdrawal(intentId: string, raw: unknown, key: string): Promise<WithdrawalIntent> {
    assetIdSchema.parse(intentId); const input = assetWithdrawalRequestSchema.parse(raw); this.checkScope(input.scope);
    const operation = { operation: "withdrawal_reconcile", intentId, input };
    const prior = this.prior<WithdrawalIntent>(key, operation); if (prior) return prior;
    const read = () => {
      const row = this.db.prepare("SELECT body FROM creator_asset_withdrawals WHERE id=?").get(intentId);
      if (!row) throw new AssetError("WITHDRAWAL_NOT_FOUND", 404);
      return JSON.parse(String(row.body)) as WithdrawalIntent;
    };
    const intent = read();
    const observed = await this.authority.verifyWithdrawal(intent, input.receiptRef, this.scope);
    if (!observed) throw new AssetError("WITHDRAWAL_AUTHORITY_UNAVAILABLE");
    const evidence = withdrawalEvidenceSchema.parse(observed);
    if (!sameAssetScope(evidence.scope, this.scope) || evidence.intentId !== intentId || evidence.deploymentId !== intent.deploymentId || evidence.deploymentSourceVersion !== intent.deploymentSourceVersion || digest(evidence.receiptRef) !== digest(input.receiptRef)) throw new AssetError("WITHDRAWAL_BINDING_MISMATCH", 403);
    if (Date.parse(evidence.observedAt) > Date.parse(this.clock())) throw new AssetError("WITHDRAWAL_OBSERVATION_INVALID");
    return this.write(key, operation, () => {
      const current = read(); const receiptKey = digest(evidence.receiptRef);
      const existing = this.db.prepare("SELECT intent_id,body FROM creator_asset_withdrawal_events WHERE receipt_key=?").get(receiptKey);
      if (existing) {
        if (existing.intent_id !== intentId || digest(JSON.parse(String(existing.body))) !== digest(evidence)) throw new AssetError("WITHDRAWAL_RECEIPT_CONFLICT");
        return current;
      }
      if (current.reconciliationReceipts.some((receipt) => receipt.attemptId === evidence.attemptId
        && receipt.sourceVersion === evidence.sourceVersion && receipt.outcome !== evidence.outcome))
        throw new AssetError("WITHDRAWAL_SOURCE_VERSION_CONFLICT");
      current.reconciliationReceipts.push(evidence);
      // Preserve every immutable receipt, but derive retry readiness from source ordering within
      // each native attempt. Another attempt's non-application cannot resolve an uncertain one.
      const attempts = new Map<string, typeof evidence>();
      for (const receipt of current.reconciliationReceipts) {
        const latest = attempts.get(receipt.attemptId);
        if (!latest || receipt.sourceVersion > latest.sourceVersion) attempts.set(receipt.attemptId, receipt);
      }
      if (current.state === "confirmed" || current.reconciliationReceipts.some((receipt) => receipt.outcome === "withdrawn")) current.state = "confirmed";
      else current.state = [...attempts.values()].some((receipt) => receipt.outcome === "uncertain") ? "uncertain" : "proposed";
      this.db.prepare("INSERT INTO creator_asset_withdrawal_events VALUES(?,?,?)").run(receiptKey, intentId, JSON.stringify(evidence));
      this.db.prepare("UPDATE creator_asset_withdrawals SET body=? WHERE id=?").run(JSON.stringify(current), intentId);
      return current;
    });
  }
}

// Re-export domain types used by trusted server adapters without coupling them to UI fixtures.
export type { AssetSubmission, StoredAsset, AssetUse, DeploymentRequest, AssetSourceReference };
