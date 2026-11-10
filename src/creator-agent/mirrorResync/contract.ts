import { z } from "zod";
import { reconciliationRowSchema, type GroupRef, type RecordStatus } from "../mirrorReconciliation/contract.ts";

const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ref = (max: number) => z.string().min(1).max(max).regex(refPattern).refine(v => !/^https?:/i.test(v), "Use a reference.");
const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));

/** One mirrored record: a reconciliation group plus the record key. */
export type RecordRef = GroupRef & { checkId: string; recordKey: string };

/** The fields the source owns and the mirror copies. A resync writes only these, and only those that differ. */
export type MirroredFields = { amountMinor: number; status?: RecordStatus };
export const MIRRORED_FIELDS = ["amountMinor", "status"] as const satisfies readonly (keyof MirroredFields)[];

/** A local, mirror-only value, such as an operator note. A resync never writes one. */
const localValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

/** A record as the reconciliation row schema types it, without the row-level read flag: identity plus mirrored fields. */
export const sourceRecordSchema = reconciliationRowSchema.omit({ read: true });
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

/**
 * What the injected authoritative source reader returns for one record. Only a `granted`, `complete` read with a version
 * and an observation time can back a resync; anything else is uncertain and refuses it.
 */
export const sourceReadSchema = z.discriminatedUnion("access", [
  z.object({ access: z.literal("granted"), complete: z.boolean(), record: sourceRecordSchema.nullable(), version: ref(120).nullable(),
    observedAt: instant }).strict(),
  z.object({ access: z.enum(["denied", "unknown"]), reason: ref(80) }).strict(),
]);
export type SourceRead = z.infer<typeof sourceReadSchema>;
export interface AuthoritativeSourceReader { read(ref: RecordRef): Promise<SourceRead> }

export const mirrorRowSchema = sourceRecordSchema.extend({ local: z.record(z.string().max(80), localValue) });
export type MirrorRow = z.infer<typeof mirrorRowSchema>;
export const mirrorReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), row: mirrorRowSchema, version: ref(120), observedAt: instant }).strict(),
  z.object({ state: z.literal("absent"), observedAt: instant }).strict(),
  z.object({ state: z.literal("failed"), reason: ref(80) }).strict(),
]);
export type MirrorRead = z.infer<typeof mirrorReadSchema>;

export type MirrorWriteRequest = {
  ref: RecordRef;
  /** Compare-and-set: the write applies only if the mirror row is still at this version. `null` creates a row only if none exists. */
  expectedVersion: string | null;
  /** Mirrored fields to set. Never local fields: the writer patches these fields and leaves every other field and its history alone. */
  set: Partial<MirroredFields>;
  /** Unique per attempt, so a provider that deduplicates by key cannot replay an earlier attempt's outcome. */
  writeKey: string;
  /**
   * The instant, on the service clock, after which the write must not apply. It is the start of the write plus the writer's
   * `maxWriteMs`. Until it has passed, plus the service's settle margin, a write with no acknowledgement may still land.
   */
  deadline: string;
  /** Aborts at `maxWriteMs` of wall time. A writer that cannot cancel the provider call must still honour `deadline`. */
  signal: AbortSignal;
};
export const mirrorWriteResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("applied"), version: ref(120) }).strict(),
  z.object({ state: z.literal("conflict"), currentVersion: ref(120).nullable() }).strict(),
  z.object({ state: z.literal("rejected"), reason: ref(80) }).strict(),
]);
export type MirrorWriteResult = z.infer<typeof mirrorWriteResultSchema>;

/** A write whose outcome is unknown: a timeout, or a lost acknowledgement after the provider may have applied it. */
export class MirrorWriteUncertainError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}

/**
 * The injected mirror writer. The real Zapier or Notion writer implements it; tests use `FakeMirrorWriter`. Any thrown
 * error from `write` is treated as uncertain, never as "not applied". `readBack` is a separate call so a real writer can
 * bypass any cache and read the row as the provider now holds it.
 *
 * `write` must be an atomic compare-and-set in the provider. Reading the version and then writing is not acceptable: a
 * late write from an earlier attempt could then overwrite a later one.
 */
export interface MirrorWriter {
  /** The longest a write can take to apply or fail, in milliseconds. The service refuses to start unless its lease is longer, with a margin. */
  readonly maxWriteMs: number;
  read(ref: RecordRef): Promise<MirrorRead>;
  write(request: MirrorWriteRequest): Promise<MirrorWriteResult>;
  readBack(ref: RecordRef): Promise<MirrorRead>;
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** A resync proposal needs an explicit operator intent. Nothing in this module proposes or applies one on its own. */
export const proposeResyncSchema = z.object({
  idempotencyKey: ref(120), checkId: ref(80), fingerprint: sha256,
  intent: z.object({ kind: z.literal("operator-resync"), operatorRef: ref(120), reason: z.string().trim().min(1).max(500) }).strict(),
}).strict();
export type ProposeResync = z.infer<typeof proposeResyncSchema>;
/** Applying is a second explicit step by the proposing operator, with a literal confirmation. */
export const applyResyncSchema = z.object({ idempotencyKey: ref(120), operatorRef: ref(120), confirm: z.literal(true) }).strict();
export const cancelResyncSchema = z.object({ idempotencyKey: ref(120), operatorRef: ref(120) }).strict();

/**
 * `proposed`, `refused`, `conflict` and `not_applied` may be applied (again): nothing is on the mirror from this proposal.
 * `applying` and `uncertain` may have written, so the next apply only reads back. The rest are final.
 */
export const RESYNC_STATES = ["proposed", "refused", "conflict", "not_applied", "applying", "uncertain", "verified", "already_matched",
  "mismatch", "cancelled"] as const;
export type ResyncState = (typeof RESYNC_STATES)[number];
export const RETRYABLE_STATES = ["proposed", "refused", "conflict", "not_applied"] as const satisfies readonly ResyncState[];
export const IN_FLIGHT_STATES = ["applying", "uncertain"] as const satisfies readonly ResyncState[];
export const FINAL_STATES = ["verified", "already_matched", "mismatch", "cancelled"] as const satisfies readonly ResyncState[];

/** Reason codes. The first two are the repair hold codes in `operationsControls.ts`, reused with the same meaning. */
export const REASONS = {
  ownershipHeld: "REPAIR_OWNERSHIP_HELD",
  reconciliationIncomplete: "RECONCILIATION_INCOMPLETE",
  findingNotOpen: "RESYNC_FINDING_NOT_OPEN",
  sourceAccess: "SOURCE_ACCESS_UNCERTAIN",
  sourceIncomplete: "SOURCE_READ_INCOMPLETE",
  sourceAbsent: "SOURCE_RECORD_ABSENT",
  sourceIdentity: "SOURCE_IDENTITY_MISMATCH",
  sourceStale: "SOURCE_STALE",
  sourceFreshness: "SOURCE_FRESHNESS_UNCERTAIN",
  sourceVersion: "SOURCE_VERSION_UNCERTAIN",
  sourceVersionChanged: "SOURCE_VERSION_CHANGED",
  mirrorRead: "MIRROR_READ_FAILED",
  mirrorIdentity: "MIRROR_IDENTITY_MISMATCH",
  mirrorVersionChanged: "MIRROR_VERSION_CHANGED",
  writeRejected: "WRITE_REJECTED",
  writeNotApplied: "WRITE_NOT_APPLIED",
  /** The mirror is unchanged and the write is unacknowledged, but its deadline plus the settle margin has not passed. */
  writeOutcomePending: "WRITE_OUTCOME_PENDING",
  readBackFailed: "READBACK_FAILED",
  readBackContradictsAck: "READBACK_CONTRADICTS_ACK",
  localFieldsChanged: "LOCAL_FIELDS_CHANGED",
  partialApply: "PARTIAL_APPLY",
  readBackMismatch: "READBACK_MISMATCH",
  mirrorRowRemoved: "MIRROR_ROW_REMOVED",
  verified: "RESYNC_VERIFIED",
  alreadyMatched: "ALREADY_MATCHED",
  cancelled: "RESYNC_CANCELLED",
  leaseLost: "RESYNC_LEASE_LOST",
} as const;

export class MirrorResyncError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
