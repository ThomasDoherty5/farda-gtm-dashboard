import { z } from "zod";
import { operationsTimezoneSchema } from "../../adapter/viewSchemas/nativeOperations.ts";

/** Operations read models (THO-301) served at the authenticated `/v1/read` boundary. Read only: no shipping, return or reveal action runs here. */
export const operationsReadViewKeys = ["operationsOverview", "orderDetail", "orderCustomer", "shippingException", "returnDetail",
  "fulfillmentAnalytics", "operationsShipping", "opsHealth"] as const;
export type OperationsReadViewKey = (typeof operationsReadViewKeys)[number];
export const isOperationsReadViewKey = (value: string): value is OperationsReadViewKey => (operationsReadViewKeys as readonly string[]).includes(value);

const ref = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/**
 * Exact filters per view, matching what each THO-301 screen sends through `useView`. D-11: `scenario` and `fixture` are
 * demo-only and are refused here, so a demo selector can never pick what the service answers. No view accepts a free-form query.
 */
const scopeFilters={home:z.enum(["all","H1","H2","H3"]).optional(),startAt:z.string().datetime({offset:true}).optional(),endAt:z.string().datetime({offset:true}).optional(),timezone:operationsTimezoneSchema.optional()};
const validWindow=(value:{startAt?:string;endAt?:string;timezone?:string})=>(value.startAt===undefined&&value.endAt===undefined&&value.timezone===undefined)||Boolean(value.startAt&&value.endAt&&value.timezone&&Date.parse(value.startAt)<Date.parse(value.endAt));
export const operationsReadFilters = {
  operationsOverview: z.object(scopeFilters).strict().refine(validWindow,"A period needs exact start, end and timezone."),
  operationsShipping: z.object(scopeFilters).strict().refine(validWindow,"A period needs exact start, end and timezone."),
  opsHealth: z.object({}).strict(),
  fulfillmentAnalytics: z.object({ ...scopeFilters,days: z.union([z.literal(7), z.literal(14)]) }).strict().refine(validWindow,"A period needs exact start, end and timezone."),
  orderDetail: z.object({ orderId: ref }).strict(),
  orderCustomer: z.object({ orderId: ref }).strict(),
  shippingException: z.object({ shipmentId: ref, exceptionId: ref }).strict(),
  returnDetail: z.object({ returnId: ref }).strict(),
} satisfies Record<OperationsReadViewKey, z.ZodTypeAny>;

/** Detail views name one record. An absent record inside the verified scope is RECORD_NOT_FOUND (Q-02), never an empty success. */
export const operationsDetailViews: ReadonlySet<OperationsReadViewKey> = new Set(["orderDetail", "orderCustomer", "shippingException", "returnDetail"]);

const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

/**
 * What an injected server-only source reader must return for one view. The reader is never supplied by a browser request.
 * `record: null` is the source's own statement that nothing exists for this address; it is not used for an unread source.
 */
export const operationsSnapshotSchema = z.object({
  scope: z.object({ workspaceId: z.string().min(1), accountId: z.string().min(1), environment: z.literal("sandbox") }).strict(),
  viewKey: z.enum(operationsReadViewKeys),
  version: ref,
  principalRef: ref,
  permissionVersion: ref,
  observedAt: instant,
  validUntil: instant,
  coverage: z.object({ state: z.enum(["complete", "partial"]), expectedCount: count.nullable(), observedCount: count.nullable(),
    reasonCodes: z.array(reasonCode).max(20) }).strict(),
  record: z.unknown().refine(value => value !== undefined, "A record or an explicit null is required."),
}).strict().superRefine((s, ctx) => {
  if (Date.parse(s.validUntil) <= Date.parse(s.observedAt)) ctx.addIssue({ code: "custom", message: "Invalid source lease." });
  const { state, expectedCount, observedCount, reasonCodes } = s.coverage;
  if (expectedCount !== null && observedCount !== null && observedCount > expectedCount) ctx.addIssue({ code: "custom", message: "Observed exceeds expected." });
  if (state === "complete" && (expectedCount === null || observedCount !== expectedCount)) ctx.addIssue({ code: "custom", message: "Complete coverage needs equal known counts." });
  if (state === "partial" && reasonCodes.length === 0) ctx.addIssue({ code: "custom", message: "Partial coverage needs a reason." });
  // "Nothing exists" is only a complete answer when the source counted zero expected rows; otherwise it is unknown, not empty.
  if (s.record === null && state === "complete" && expectedCount !== 0) ctx.addIssue({ code: "custom", message: "An empty record needs a counted zero." });
});
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>;
