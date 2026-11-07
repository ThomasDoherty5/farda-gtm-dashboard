import { z } from "zod";
import { trustedHumanSchema, type ApprovalPrincipal, type ApprovalSources } from "../approvals/contract.ts";

export const reference = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(v => !/^https?:/i.test(v));
export const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
export const scopeSchema = z.object({ workspaceId: reference, accountId: reference, environment: z.literal("sandbox") }).strict();
export type ActionScope = z.infer<typeof scopeSchema>;
export type ActionPrincipal = ApprovalPrincipal;
export const principalGrantSchema = trustedHumanSchema;
export type PrincipalGrant = z.infer<typeof principalGrantSchema>;
/** Root composes the same trusted directory used by J04; browser roles are never input. */
export type ActionPrincipalAuthority = NonNullable<ApprovalSources["resolveActor"]>;
export type ActionAuthorityFence = NonNullable<ApprovalSources["assertCurrent"]>;
export class ActionServiceError extends Error {
  readonly code: string; readonly status: number; readonly executionCertainty: "notApplied" | "applied" | "uncertain"; readonly currentVersion?: string;
  constructor(code: string, status = 409, executionCertainty: "notApplied" | "applied" | "uncertain" = "notApplied", currentVersion?: string) {
    super(code); this.code = code; this.status = status; this.executionCertainty = executionCertainty; this.currentVersion = currentVersion;
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const timezone = z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } });
const count = z.number().int().nonnegative().safe();
const currency = z.string().regex(/^[A-Z]{3}$/);
const amount = z.number().int().safe();
export const exportFiltersSchema = z.object({ state: z.enum(["all", "pending", "earned", "reversed", "settled"]),
  startAt: instant, endAt: instant, timezone, currency }).strict().refine(v => Date.parse(v.startAt) < Date.parse(v.endAt));
export const exportPayloadSchema = z.object({ filters: exportFiltersSchema, format: z.literal("csv") }).strict();
export type ExportPayload = z.infer<typeof exportPayloadSchema>;
export const ledgerRowSchema = z.object({ entitlementRef: reference, creatorRef: reference, sourceRef: reference, orderRef: reference,
  currency, eligibleMinor: amount, commissionMinor: amount, commissionRatePct: z.number().finite().min(0).max(100).nullable(),
  state: z.enum(["pending", "earned", "reversed", "settled"]), eventAt: instant, observedAt: instant, policyVersion: reference, ledgerRevision: reference }).strict();
export const ledgerSnapshotSchema = z.object({ scope: scopeSchema, snapshotRef: reference, version: reference,
  filters: exportFiltersSchema, asOf: instant, validUntil: instant, total: count.max(100_000), complete: z.literal(true),
  allowed: z.literal(true), permissionVersion: reference }).strict();
export type LedgerSnapshot = z.infer<typeof ledgerSnapshotSchema>;
export const ledgerPageSchema = z.object({ snapshotRef: reference, version: reference, offset: count, total: count.max(100_000),
  rows: z.array(ledgerRowSchema).max(500), nextCursor: reference.nullable() }).strict();
export type LedgerSource = {
  open(scope: ActionScope, principal: ActionPrincipal, filters: ExportPayload["filters"]): Promise<unknown>;
  page(snapshot: LedgerSnapshot, cursor: string | null): Promise<unknown>;
  current(snapshot: LedgerSnapshot, principal: ActionPrincipal): Promise<unknown>;
  /** Trusted synchronous proof fence, rechecked inside the artifact job's final transaction. */
  assertCurrent(snapshot: LedgerSnapshot, principal: ActionPrincipal, now: number): void;
};
export const exportReceiptSchema = z.object({ kind: z.literal("ledger-export"), artifactRef: reference, runRef: reference, requestKey: reference,
  principalRef: reference, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceVersion: reference,
  rowCount: count, byteLength: count, sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: instant, expiresAt: instant,
  asOf: instant, contentType: z.literal("text/csv;charset=utf-8"), confersRelease: z.literal(false) }).strict();
export type ExportReceipt = z.infer<typeof exportReceiptSchema>;

export const readinessPayloadSchema = z.object({ verdict: z.enum(["go", "revise", "hold"]),
  launchDate: date.nullable(), rationale: z.string().trim().min(1).max(2000), evidenceRefs: z.array(reference).min(1).max(50) }).strict();
export type ReadinessPayload = z.infer<typeof readinessPayloadSchema>;
export const readinessSnapshotSchema = z.object({ scope: scopeSchema, targetRef: reference, version: reference, observedAt: instant,
  validUntil: instant, writable: z.literal(true), launchDate: date.nullable(), launchDateApproved: z.boolean(),
  phase: z.enum(["review", "effective-l-minus-4"]), phaseVersion: reference, phaseAllowed: z.boolean(),
  gates: z.array(z.object({ id: reference, required: z.boolean(), state: z.enum(["pass", "fail", "unknown"]), evidenceRef: reference.nullable() }).strict()).min(1).max(100),
  evidenceRefs: z.array(reference).min(1).max(100), policyVersion: reference }).strict().superRefine((s, ctx) => {
    if (new Set(s.gates.map(g => g.id)).size !== s.gates.length) ctx.addIssue({ code: "custom", message: "Duplicate gate." });
    if (s.launchDateApproved && !s.launchDate) ctx.addIssue({ code: "custom", message: "Approved date is missing." });
  });
export type ReadinessSnapshot = z.infer<typeof readinessSnapshotSchema>;
export const readinessIntentSchema = z.object({ scope: scopeSchema, requestKey: reference, principalRef: reference, targetRef: reference,
  expectedVersion: reference, sourceBasis: z.string().regex(/^[a-f0-9]{64}$/), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  payload: readinessPayloadSchema, confersRelease: z.literal(false) }).strict();
export type ReadinessIntent = z.infer<typeof readinessIntentSchema>;
export const readinessReceiptSchema = readinessIntentSchema.extend({ kind: z.literal("launch-readiness-record"),
  receiptRef: reference, recordedVersion: reference, recordedAt: instant, provider: z.literal("notion") }).strict();
export type ReadinessReceipt = z.infer<typeof readinessReceiptSchema>;
export const readinessLookupSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("applied"), receipt: readinessReceiptSchema }).strict(),
  z.object({ state: z.literal("notApplied"), terminal: z.literal(true), intent: readinessIntentSchema, receiptRef: reference, observedAt: instant }).strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);
export type ReadinessSource = {
  idempotency: "source-enforced";
  read(scope: ActionScope, principal: ActionPrincipal, targetRef: string): Promise<unknown>;
  assertCurrent(snapshot: ReadinessSnapshot, principal: ActionPrincipal, now: number): void;
  write(intent: ReadinessIntent): Promise<unknown>;
  lookup(intent: ReadinessIntent): Promise<unknown>;
};
export const domainRequestSchema = z.object({ idempotencyKey: reference, expectedVersion: reference }).strict();
