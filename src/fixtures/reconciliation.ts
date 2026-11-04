/**
 * Nightly reconciliation and conflict repair (FE13-05) — SYNTHETIC. Two systems that should agree are compared each night; a
 * disagreement becomes a conflict with a proposed repair. A repair is only ever requested here: the source owner applies it after
 * approval, and the audit trail is append-only. Nothing here reads or writes a real system.
 */
import { DEMO_NOW } from "./overview";

export type ReconciliationPair = { key: string; label: string; compared: number; matched: number; conflicts: number };
export type ConflictState = "open" | "repairRequested";
export type Conflict = {
  id: string;
  pair: string;
  record: string;
  field: string;
  left: { source: string; value: string };
  right: { source: string; value: string };
  detectedAt: string;
  state: ConflictState;
  /** Which system is authoritative, and what the repair would change. The repair never overwrites the authoritative side. */
  authority: string;
  proposal: string;
};
export type AuditEntry = { id: string; at: string; actor: string; action: string; subject: string; detail: string };

export type ReconciliationData = {
  datasetKey: "reconciliation-nightly-demo";
  version: string;
  run: { startedAt: string; finishedAt: string; state: "completed" | "partial" | "failed"; schedule: string };
  pairs: ReconciliationPair[];
  conflicts: Conflict[];
  audit: AuditEntry[];
};

const NIGHT = "2026-11-02T10:00:00.000Z";

export const seedReconciliation = (): ReconciliationData => ({
  datasetKey: "reconciliation-nightly-demo",
  version: "rec1",
  run: { startedAt: NIGHT, finishedAt: "2026-11-02T10:06:00.000Z", state: "completed", schedule: "Nightly · 02:00 PT · separate from daily sourcing and hourly monitoring" },
  pairs: [
    { key: "orders", label: "Shopify orders ↔ commission ledger", compared: 412, matched: 411, conflicts: 1 },
    { key: "stock", label: "Warehouse sheet ↔ stock movements", compared: 240, matched: 239, conflicts: 1 },
    { key: "creators", label: "Notion creator records ↔ app records", compared: 118, matched: 118, conflicts: 0 },
  ],
  conflicts: [
    {
      id: "CONF-001", pair: "orders", record: "TEST-SH-1031", field: "Refund amount",
      left: { source: "Shopify", value: "$12.00" }, right: { source: "Commission ledger", value: "$12.50" },
      detectedAt: NIGHT, state: "open", authority: "Shopify is authoritative for refunds",
      proposal: "Correct the ledger entry to $12.00 through a reversing adjustment. The paid receipt is not rewritten.",
    },
    {
      id: "CONF-002", pair: "stock", record: "Home H2 · on hand", field: "On-hand units",
      left: { source: "Warehouse sheet", value: "30" }, right: { source: "Stock movements", value: "28" },
      detectedAt: NIGHT, state: "open", authority: "Movements are authoritative for on-hand",
      proposal: "Ask the warehouse owner to record a correcting movement. The sheet is not edited from here.",
    },
  ],
  audit: [
    { id: "AUD-001", at: NIGHT, actor: "Nightly job", action: "Reconciliation completed", subject: "3 pairs", detail: "770 records compared, 768 matched, 2 conflicts" },
    { id: "AUD-002", at: NIGHT, actor: "Nightly job", action: "Conflict detected", subject: "CONF-001", detail: "Refund amount differs for TEST-SH-1031" },
    { id: "AUD-003", at: NIGHT, actor: "Nightly job", action: "Conflict detected", subject: "CONF-002", detail: "On-hand units differ for Home H2" },
  ],
});

export const RECONCILIATION_NOW = DEMO_NOW;
