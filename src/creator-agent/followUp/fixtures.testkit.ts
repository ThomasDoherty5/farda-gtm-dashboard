// Synthetic follow-up fixtures for tests only. No real creators, collaborations or provider identifiers.
import { createRequire } from "node:module";
import { defaultFollowUpConfig, type DeliveryEvidence, type PostingClockEvent } from "./contract.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const followUpScope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
export const followUpZone = "America/Los_Angeles";
/** No reminder policy: creator reminders are refused. */
export const unsetConfig = defaultFollowUpConfig(followUpZone);
export const followUpConfig = { ...unsetConfig, reminderPolicy: "preDue" as const };
export const postGraceConfig = { ...unsetConfig, reminderPolicy: "postGraceOnly" as const };
export const collaborationId = "synthetic-collaboration";

export function followUpDatabase(scope = followUpScope) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
  db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId, scope.accountId, scope.environment);
  return db;
}
/** Synthetic posting clock: due 2026-11-12 in Los Angeles with two grace days. */
export function clockEvent(overrides: Partial<PostingClockEvent> = {}): PostingClockEvent {
  return { origin: "synthetic", collaborationId, posting: "committed", dueDate: "2026-11-12", graceDays: 2, timezone: followUpZone,
    sourceRef: "synthetic-posting-clock-v1", observedAt: "2026-11-01T00:00:00.000Z", ...overrides };
}
export function deliveryEvidence(overrides: Partial<DeliveryEvidence> = {}): DeliveryEvidence {
  return { origin: "synthetic", collaborationId, deliverableRef: "synthetic-deliverable", contentVersion: "content-v2", sourceRef: "synthetic-delivery-v1",
    publication: { state: "published", nativeReceiptRef: "synthetic-publication-receipt", nativePostRef: "synthetic-post", confirmedSlot: null,
      publishedAt: "2026-11-11T18:00:00.000Z", observedAt: "2026-11-11T19:00:00.000Z", visibility: "visible" }, ...overrides };
}
/** Noon in Los Angeles on a November 2026 day (UTC-8). */
export const laNoon = (day: string) => Date.parse(`${day}T20:00:00.000Z`);
