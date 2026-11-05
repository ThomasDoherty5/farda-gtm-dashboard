import { z } from "zod";

export const CAPABILITY_SCHEMA_VERSION = "farda.capabilities.v1" as const;
export const MAX_VERIFICATION_AGE_MS = 15 * 60_000;
const safeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine((value) => !/^https?:/i.test(value), "Use an opaque ID, not a URL.");
const instant = z.string().datetime({ offset: true });
const reasonCode = z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/);
const reference = (prefix: string) => z.string().max(200).regex(new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9._/-]*$`));
export const receiptRefSchema = reference("receipt");
export const capabilityStateSchema = z.enum(["Ready", "Unverified", "Unsupported", "Denied"]);
export const capabilityScopeSchema = z.object({ workspaceId: safeId, accountId: safeId, environment: z.enum(["sandbox", "production"]) }).strict();

/** Exact server binding. References identify private stores; they never contain credentials or URLs. */
export const expectedBindingSchema = capabilityScopeSchema.extend({
  provider: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/),
  providerAccountId: safeId,
  action: safeId,
  mode: z.enum(["observe", "propose", "executeApproved", "reconcile"]),
  route: z.enum(["api", "mcp", "browser", "webhook", "manual"]),
  routeRef: reference("route"),
  authorizationScopeVersion: safeId,
  toolVersion: safeId,
  requiredScopes: z.array(safeId).max(50).refine((values) => new Set(values).size === values.length, "Scopes must be unique."),
  connectionRef: reference("connection").nullable(),
  secretRef: reference("secretref").nullable(),
}).strict();
export type ExpectedBinding = z.infer<typeof expectedBindingSchema>;
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

export const costBasisSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown"), reasonCode }).strict(),
  z.object({ state: z.literal("known"), unit: z.enum(["task", "request", "run"]), amountMinor: z.number().int().nonnegative().safe(), currency: z.string().regex(/^[A-Z]{3}$/), sourceRef: reference("source") }).strict(),
]);
export const registrationSchema = z.object({ binding: expectedBindingSchema, ownerRef: reference("owner"), costBasis: costBasisSchema }).strict();
export type CapabilityRegistration = z.infer<typeof registrationSchema>;

const connectionHealthSchema = z.enum(["Unknown", "Authenticated", "Expired", "Denied"]);
const sourceFreshnessSchema = z.object({ state: z.enum(["unknown", "current", "stale", "unavailable"]), observedAt: instant.nullable(), sourceUpdatedAt: instant.nullable(), sourceRef: reference("source").nullable() }).strict();
const businessEligibilitySchema = z.object({ state: z.enum(["notEvaluated", "eligible", "held", "ineligible"]), reasonCodes: z.array(reasonCode).max(30), sourceRef: reference("source").nullable() }).strict();
export const unknownSourceFreshness = () => ({ state: "unknown" as const, observedAt: null, sourceUpdatedAt: null, sourceRef: null });
export const unknownBusinessEligibility = () => ({ state: "notEvaluated" as const, reasonCodes: ["BUSINESS_ELIGIBILITY_NOT_EVALUATED"], sourceRef: null });

/** Only a configured server verifier may resolve this proof. An HTTP Ready flag is never accepted. */
export const verificationReceiptSchema = z.object({
  receiptRef: receiptRefSchema,
  binding: expectedBindingSchema,
  outcome: capabilityStateSchema,
  checkedAt: instant,
  expiresAt: instant.nullable(),
  verifiedScopes: z.array(safeId).max(50).refine((values) => new Set(values).size === values.length, "Scopes must be unique."),
  connectionHealth: connectionHealthSchema,
  sourceFreshness: sourceFreshnessSchema,
  businessEligibility: businessEligibilitySchema,
  reasonCodes: z.array(reasonCode).max(30),
}).strict();
export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;
export type ReceiptResolver = (receiptRef: string) => VerificationReceipt | null | Promise<VerificationReceipt | null>;

export const capabilityRecordSchema = z.object({
  schemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
  capabilityId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().safe(),
  registration: registrationSchema,
  observedState: capabilityStateSchema,
  checkedAt: instant.nullable(), expiresAt: instant.nullable(), receiptRef: receiptRefSchema.nullable(),
  recordedAt: instant, revokedAt: instant.nullable(),
  verifiedScopes: z.array(safeId).max(50),
  connectionHealth: connectionHealthSchema,
  sourceFreshness: sourceFreshnessSchema,
  businessEligibility: businessEligibilitySchema,
  reasonCodes: z.array(reasonCode).min(1).max(30),
}).strict();
export type CapabilityRecord = z.infer<typeof capabilityRecordSchema>;

/** Read projection omits even private credential/connection references. */
export const capabilityViewSchema = capabilityRecordSchema.omit({ registration: true }).extend({
  registration: registrationSchema.omit({ binding: true }).extend({
    binding: expectedBindingSchema.omit({ secretRef: true, connectionRef: true }),
    hasCredentialReference: z.boolean(), hasConnectionReference: z.boolean(),
  }).strict(),
  state: capabilityStateSchema, fresh: z.boolean(),
  recovery: z.enum(["none", "configureRoute", "reverify", "reviewPermission"]),
}).strict();
export type CapabilityView = z.infer<typeof capabilityViewSchema>;

export type CapabilityReadiness = {
  allowed: boolean;
  state: z.infer<typeof capabilityStateSchema>;
  reasonCodes: string[];
  capabilityId: string | null;
  revision: number | null;
  checkedAt: string | null;
  expiresAt: string | null;
  receiptRef: string | null;
  ownerRef?: string | null;
  recovery?: "none" | "configureRoute" | "reverify" | "reviewPermission";
};
