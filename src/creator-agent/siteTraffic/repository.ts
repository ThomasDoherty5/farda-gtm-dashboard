import type { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { approvalScopeSchema, type ApprovalScope } from "../approvals/contract.ts";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { trafficImportPrincipalSchema, trafficImportRequestSchema, trafficReportSchema, type TrafficDefinition, type TrafficImportPrincipal, type TrafficImportRequest, type TrafficPartition, type TrafficReport, type TrafficSegment, type TrafficAuthority } from "./contract.ts";
import { trafficImportReceiptSchema, type TrafficImportReceipt } from "./views.ts";
import { SiteTrafficError } from "./source.ts";

export const trafficSegmentKey = (segment: TrafficSegment): string => segment.kind === "all" ? "all" : segment.key;
export const trafficDefinitionKey = (definition: TrafficDefinition, provenance: TrafficAuthority["provenance"]): string => digest({ definition, provenance });
export type TrafficStoredRow = TrafficPartition["rows"][number] & { day: string; revision: number; coverage: "complete" | "partial"; observedThrough: string; sourceAsOf: string; importedAt: string; startAt: string; endAt: string };
export type TrafficStoredPartition = { partition: TrafficPartition; importedAt: string; rows: TrafficStoredRow[] };

/** One aggregate revision owner only. It stores no orders, clicks, events, customers or raw report body. */
export class SiteTrafficRepository {
  private readonly db: DatabaseSync;
  private readonly scope: ApprovalScope;
  private readonly referenceKey: string;
  constructor(db: DatabaseSync, scope: ApprovalScope, referenceKey: string) {
    this.db = db; this.scope = approvalScopeSchema.parse(scope); this.referenceKey = referenceKey;
    if (referenceKey.length < 32) throw new SiteTrafficError("TRAFFIC_REFERENCE_KEY_INVALID", 500);
    const binding = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (!binding || binding.workspace_id !== scope.workspaceId || binding.account_id !== scope.accountId) throw new SiteTrafficError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS site_traffic_definitions(account_ref TEXT NOT NULL,definition_ref TEXT NOT NULL,version TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account_ref,definition_ref,version));
      CREATE TABLE IF NOT EXISTS site_traffic_partition_revisions(definition_key TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(definition_key,day,revision));
      CREATE TABLE IF NOT EXISTS site_traffic_partitions(definition_key TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(definition_key,day));
      CREATE TABLE IF NOT EXISTS site_traffic_rows(definition_key TEXT NOT NULL,day TEXT NOT NULL,segment_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(definition_key,day,segment_key));
      CREATE TABLE IF NOT EXISTS site_traffic_imports(sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,definition_key TEXT NOT NULL,account_ref TEXT NOT NULL,stage TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }
  private key(input: TrafficImportRequest, principal: TrafficImportPrincipal): string { return digest([this.scope, principal.principalRef, principal.bindingRef, input.requestKey]); }
  assertDefinition(definition: TrafficDefinition): void {
    const row = this.db.prepare("SELECT hash FROM site_traffic_definitions WHERE account_ref=? AND definition_ref=? AND version=?").get(definition.sourceAccountRef, definition.definitionRef, definition.version);
    if (row && row.hash !== digest(definition)) throw new SiteTrafficError("TRAFFIC_DEFINITION_VERSION_REUSED");
  }
  lookup(input: TrafficImportRequest, principal: TrafficImportPrincipal): TrafficImportReceipt | null {
    trafficImportRequestSchema.parse(input); trafficImportPrincipalSchema.parse(principal);
    const row = this.db.prepare("SELECT request_hash,receipt FROM site_traffic_imports WHERE request_key=?").get(this.key(input, principal));
    if (!row) return null;
    if (row.request_hash !== digest(input)) throw new SiteTrafficError("TRAFFIC_IMPORT_KEY_REUSED");
    const receipt = trafficImportReceiptSchema.parse(JSON.parse(String(row.receipt)));
    if (receipt.requestKey !== input.requestKey || receipt.requestDigest !== digest(input) || receipt.definitionVersion !== input.expectedDefinitionVersion) throw new SiteTrafficError("TRAFFIC_RECEIPT_INTEGRITY_INVALID", 503);
    return receipt;
  }
  latest(definitionKey: string): TrafficImportReceipt | null {
    const row = this.db.prepare("SELECT receipt FROM site_traffic_imports WHERE definition_key=? ORDER BY sequence DESC LIMIT 1").get(definitionKey);
    return row ? trafficImportReceiptSchema.parse(JSON.parse(String(row.receipt))) : null;
  }
  firstActual(accountRef: string): TrafficImportReceipt | null {
    const row = this.db.prepare("SELECT receipt FROM site_traffic_imports WHERE account_ref=? AND stage='source' ORDER BY sequence LIMIT 1").get(accountRef);
    return row ? trafficImportReceiptSchema.parse(JSON.parse(String(row.receipt))) : null;
  }
  read(definitionKey: string, startDay: string, endDayExclusive: string): TrafficStoredPartition[] {
    const partitions = this.db.prepare(`SELECT r.body FROM site_traffic_partitions p JOIN site_traffic_partition_revisions r ON r.definition_key=p.definition_key AND r.day=p.day AND r.revision=p.revision
      WHERE p.definition_key=? AND p.day>=? AND p.day<? ORDER BY p.day`).all(definitionKey, startDay, endDayExclusive);
    return partitions.map(row => {
      const stored = JSON.parse(String(row.body)) as { partition: TrafficPartition; importedAt: string };
      const rows = this.db.prepare("SELECT body FROM site_traffic_rows WHERE definition_key=? AND day=? ORDER BY segment_key").all(definitionKey, stored.partition.day).map(item => JSON.parse(String(item.body)) as TrafficStoredRow);
      return { ...stored, rows };
    });
  }
  import(input: TrafficImportRequest, principal: TrafficImportPrincipal, report: TrafficReport, provenance: TrafficAuthority["provenance"], importedAt: string, assertCurrent: () => void): TrafficImportReceipt {
    input = trafficImportRequestSchema.parse(structuredClone(input)); principal = trafficImportPrincipalSchema.parse(structuredClone(principal)); report = trafficReportSchema.parse(structuredClone(report));
    const definitionKey = trafficDefinitionKey(report.definition, provenance), requestHash = digest(input), requestKey = this.key(input, principal);
    if (report.definition.version !== input.expectedDefinitionVersion) throw new SiteTrafficError("TRAFFIC_DEFINITION_CHANGED");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertSynchronousVoid(assertCurrent);
      const prior = this.lookup(input, principal);
      if (prior) { assertSynchronousVoid(assertCurrent); this.db.exec("COMMIT"); return prior; }
      this.assertDefinition(report.definition);
      this.db.prepare("INSERT OR IGNORE INTO site_traffic_definitions VALUES(?,?,?,?,?)").run(report.definition.sourceAccountRef, report.definition.definitionRef, report.definition.version, digest(report.definition), JSON.stringify(report.definition));
      let inserted = 0, replaced = 0, unchanged = 0, removed = 0;
      for (const partition of report.partitions) {
        const current = this.db.prepare("SELECT revision FROM site_traffic_partitions WHERE definition_key=? AND day=?").get(definitionKey, partition.day);
        const previous = this.db.prepare("SELECT hash FROM site_traffic_partition_revisions WHERE definition_key=? AND day=? AND revision=?").get(definitionKey, partition.day, partition.revision);
        if (previous && previous.hash !== digest(partition)) throw new SiteTrafficError("TRAFFIC_REVISION_CONFLICT");
        if (current && Number(current.revision) > partition.revision) throw new SiteTrafficError("TRAFFIC_OLDER_REVISION");
        if (previous) { unchanged += partition.rows.length; continue; }
        const existing = new Set(this.db.prepare("SELECT segment_key FROM site_traffic_rows WHERE definition_key=? AND day=?").all(definitionKey, partition.day).map(row => String(row.segment_key)));
        const provided = new Set(partition.rows.map(row => trafficSegmentKey(row.segment)));
        if (partition.replaceSegments) for (const segment of existing) if (!provided.has(segment)) {
          this.db.prepare("DELETE FROM site_traffic_rows WHERE definition_key=? AND day=? AND segment_key=?").run(definitionKey, partition.day, segment); removed++;
        }
        for (const row of partition.rows) {
          const segment = trafficSegmentKey(row.segment);
          if (existing.has(segment)) replaced++; else inserted++;
          const stored: TrafficStoredRow = { ...row, day: partition.day, revision: partition.revision, coverage: partition.coverage, observedThrough: partition.observedThrough, sourceAsOf: partition.sourceAsOf, importedAt, startAt: partition.startAt, endAt: partition.endAt };
          this.db.prepare("INSERT INTO site_traffic_rows VALUES(?,?,?,?) ON CONFLICT(definition_key,day,segment_key) DO UPDATE SET body=excluded.body").run(definitionKey, partition.day, segment, JSON.stringify(stored));
        }
        this.db.prepare("INSERT INTO site_traffic_partition_revisions VALUES(?,?,?,?,?)").run(definitionKey, partition.day, partition.revision, digest(partition), JSON.stringify({ partition, importedAt }));
        this.db.prepare("INSERT INTO site_traffic_partitions VALUES(?,?,?) ON CONFLICT(definition_key,day) DO UPDATE SET revision=excluded.revision").run(definitionKey, partition.day, partition.revision);
      }
      const receipt = trafficImportReceiptSchema.parse({ receiptRef: "traffic-import-" + createHmac("sha256", this.referenceKey).update(requestKey).digest("hex"), requestKey: input.requestKey, requestDigest: requestHash,
        definitionVersion: report.definition.version, reportDigest: digest(report), importedAt, sourceAsOf: report.partitions.map(partition => partition.sourceAsOf).sort((a, b) => Date.parse(a) - Date.parse(b))[0],
        evidenceStage: provenance.evidenceStage, synthetic: provenance.synthetic, inserted, replaced, unchanged, removed, sourceEffect: "localAggregate" });
      this.db.prepare("INSERT INTO site_traffic_imports(request_key,request_hash,definition_key,account_ref,stage,receipt) VALUES(?,?,?,?,?,?)").run(requestKey, requestHash, definitionKey, report.definition.sourceAccountRef, provenance.evidenceStage, JSON.stringify(receipt));
      // Caller token and every source version remain current in the same transaction; a rejection rolls back all rows and the receipt.
      assertSynchronousVoid(assertCurrent);
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
