import { z } from "zod";
import { reference } from "../actions/contract.ts";
import { digest } from "../config.ts";
import {
  attributionTestSchema, instant, moneySchema, refSchema, storefrontRouteSchema, websiteCommerceSchema,
  type AttributionTest, type LinkCodeRef, type Money, type ProviderDefinitions, type StorefrontRoute, type WebsiteCommerce,
} from "./contract.ts";

/**
 * J10-07 and J10-08. A sandbox checkout matrix: every required case must pass on the actual storefront route before
 * activation. Ambiguous attribution is an exception with no creator revenue. Orders from native TikTok Shop checkout
 * that Shopify mirrors are excluded from website-affiliate entitlement, so the same sale is never entitled twice.
 */
export const MATRIX_CASES = ["linkOnly", "codeOnly", "conflicting", "untracked", "storefrontRoute", "refund"] as const;
export type MatrixCase = (typeof MATRIX_CASES)[number];

export const sandboxOrderSchema = z.object({
  case: z.enum(MATRIX_CASES),
  environment: z.literal("sandbox"),
  orderRef: refSchema,
  storefront: storefrontRouteSchema,
  salesChannel: z.enum(["online-store", "tiktok-shop-native-mirror", "other"]),
  identifiers: z.object({ linkRef: reference.nullable(), codeRef: reference.nullable() }).strict(),
  providerCredit: z.object({ state: z.enum(["credited", "notCredited", "unknown"]), relationshipSourceId: reference.nullable(),
    via: z.enum(["link", "code"]).nullable() }).strict()
    .refine(c => (c.state === "credited") === (c.relationshipSourceId !== null), "A credit names its relationship; no credit names none."),
  /** Provider-native amounts under `definitionsVersion`. Null is unknown, never zero. */
  amounts: z.object({ gross: moneySchema.nullable(), eligible: moneySchema.nullable(), holdUntil: instant.nullable() }).strict(),
  refund: z.discriminatedUnion("state", [
    z.object({ state: z.literal("none") }).strict(),
    z.object({ state: z.literal("applied"), refundOfOrderSourceId: reference, amount: moneySchema.nullable(), eligibleAfter: moneySchema.nullable() }).strict(),
    z.object({ state: z.literal("unknown"), unknownReason: z.string().min(1).max(200) }).strict(),
  ]),
  definitionsVersion: reference,
  sourceRef: reference,
  observedAt: instant,
}).strict();
export type SandboxOrder = z.infer<typeof sandboxOrderSchema>;

/** The other creator's identifiers the conflicting case uses. A second synthetic relationship, never a real one. */
export type MatrixContext = {
  relationshipSourceId: string; linkCodeRefs: LinkCodeRef[]; storefrontRoute: StorefrontRoute;
  precedence: "link-over-code" | "code-over-link" | "last-touch" | "unknown"; definitions: ProviderDefinitions | null;
};
export type RowResult = { orderSourceId: string; case: MatrixCase; state: "pass" | "fail" | "unknown" | "exception" | "excluded";
  reasonCodes: string[]; creatorEligibleRevenue: Money | null; test: AttributionTest | null };
export type MatrixResult = {
  matrixRef: string; overall: "passed" | "failed" | "exception" | "incomplete";
  cases: Record<MatrixCase, "pass" | "fail" | "unknown" | "exception" | "missing">;
  rows: RowResult[]; exceptions: RowResult[]; definitions: ProviderDefinitions | null; definitionsVersion: string | null;
  attributionTests: AttributionTest[]; websiteCommerce: WebsiteCommerce;
};

const sameRoute = (a: StorefrontRoute, b: StorefrontRoute) => a.checkoutOwner === b.checkoutOwner && a.storefrontType === b.storefrontType &&
  new URL(a.url).host === new URL(b.url).host;

function evaluateRow(order: SandboxOrder, ctx: MatrixContext): RowResult {
  const mineLink = ctx.linkCodeRefs.filter(r => r.kind === "link").map(r => r.ref.sourceId);
  const mineCode = ctx.linkCodeRefs.filter(r => r.kind === "code").map(r => r.ref.sourceId);
  const { linkRef, codeRef } = order.identifiers;
  const credit = order.providerCredit;
  const creditedToMe = credit.state === "credited" && credit.relationshipSourceId === ctx.relationshipSourceId;
  const result = (state: RowResult["state"], reasonCodes: string[], revenue = false): RowResult => ({ orderSourceId: order.orderRef.sourceId, case: order.case,
    state, reasonCodes, creatorEligibleRevenue: revenue && state === "pass" ? eligibleOf(order) : null,
    test: state === "pass" || state === "fail" ? attributionTestSchema.parse({ expectedProviderCredit: order.case !== "untracked",
      orderId: order.orderRef.sourceId, refundOfOrderId: order.refund.state === "applied" ? order.refund.refundOfOrderSourceId : order.orderRef.sourceId,
      refundApplied: order.refund.state === "applied", sourceRef: order.sourceRef }) : null });

  if (order.salesChannel === "tiktok-shop-native-mirror") return result("excluded", ["NATIVE_TIKTOK_MIRROR_EXCLUDED"]);
  if (order.salesChannel !== "online-store") return result("fail", ["SALES_CHANNEL_NOT_WEBSITE"]);
  if (!ctx.definitions || order.definitionsVersion !== ctx.definitions.version) return result("unknown", ["DEFINITIONS_VERSION_CHANGED"]);
  if (!sameRoute(order.storefront, ctx.storefrontRoute)) return result("fail", ["STOREFRONT_ROUTE_MISMATCH"]);
  if (credit.state === "unknown") return result(order.case === "conflicting" ? "exception" : "unknown", ["PROVIDER_CREDIT_UNKNOWN"]);

  const linkMine = linkRef !== null && mineLink.includes(linkRef), codeMine = codeRef !== null && mineCode.includes(codeRef);
  switch (order.case) {
    case "linkOnly":
      if (!linkMine || codeRef !== null) return result("fail", ["CASE_IDENTIFIERS_INVALID"]);
      return creditedToMe && credit.via === "link" ? result("pass", [], true) : result("fail", ["LINK_NOT_CREDITED"]);
    case "codeOnly":
      if (!codeMine || linkRef !== null) return result("fail", ["CASE_IDENTIFIERS_INVALID"]);
      return creditedToMe && credit.via === "code" ? result("pass", [], true) : result("fail", ["CODE_NOT_CREDITED"]);
    case "untracked":
      if (linkRef !== null || codeRef !== null) return result("fail", ["CASE_IDENTIFIERS_INVALID"]);
      return credit.state === "notCredited" ? result("pass", []) : result("fail", ["UNTRACKED_ORDER_CREDITED"]);
    case "conflicting": {
      // One identifier is this creator's and the other belongs to someone else. Only a documented, deterministic
      // precedence that the provider actually applied is a pass; anything else is an exception, never revenue.
      if (linkRef === null || codeRef === null || linkMine === codeMine) return result("fail", ["CASE_IDENTIFIERS_INVALID"]);
      const winner = ctx.precedence === "link-over-code" ? "link" : ctx.precedence === "code-over-link" ? "code" : null;
      if (!winner) return result("exception", ["ATTRIBUTION_PRECEDENCE_AMBIGUOUS"]);
      const expectMine = winner === "link" ? linkMine : codeMine;
      const applied = credit.via === winner && (expectMine ? creditedToMe : credit.state === "credited" && !creditedToMe);
      return applied ? result("pass", [], expectMine) : result("exception", ["ATTRIBUTION_CONFLICT_UNRESOLVED"]);
    }
    case "storefrontRoute":
      if (!linkMine && !codeMine) return result("fail", ["CASE_IDENTIFIERS_INVALID"]);
      return creditedToMe ? result("pass", [], true) : result("fail", ["STOREFRONT_ORDER_NOT_CREDITED"]);
    case "refund": {
      if (!linkMine && !codeMine) return result("fail", ["CASE_IDENTIFIERS_INVALID"]);
      if (order.refund.state === "unknown") return result("unknown", ["REFUND_REPRESENTATION_UNKNOWN"]);
      if (order.refund.state !== "applied" || order.refund.refundOfOrderSourceId !== order.orderRef.sourceId) return result("fail", ["REFUND_NOT_REPRESENTED"]);
      if (!creditedToMe) return result("fail", ["REFUND_ORDER_NOT_CREDITED"]);
      const { amount, eligibleAfter } = order.refund, eligible = order.amounts.eligible;
      if (!amount || !eligibleAfter || !eligible) return result("unknown", ["REFUND_AMOUNT_UNKNOWN"]);
      const consistent = amount.currency === eligible.currency && eligibleAfter.currency === eligible.currency &&
        eligibleAfter.minorUnits === Math.max(0, eligible.minorUnits - amount.minorUnits);
      return consistent ? result("pass", [], true) : result("fail", ["REFUND_ELIGIBLE_BASE_INCONSISTENT"]);
    }
  }
}
function eligibleOf(order: SandboxOrder): Money | null {
  if (order.refund.state === "applied") return order.refund.eligibleAfter;
  return order.refund.state === "unknown" ? null : order.amounts.eligible;
}

/**
 * Each case's state is its worst counted row: an exception outranks a failure, a failure outranks an unknown, and an
 * unknown outranks a pass. One passing order never hides another order that failed. Excluded mirrors are not counted.
 */
function caseState(rows: RowResult[]): MatrixResult["cases"][MatrixCase] {
  const counted = rows.filter(r => r.state !== "excluded");
  if (!counted.length) return "missing";
  for (const state of ["exception", "fail", "unknown"] as const) if (counted.some(r => r.state === state)) return state;
  return "pass";
}

export function evaluateAttributionMatrix(rawOrders: unknown, ctx: MatrixContext): MatrixResult {
  const orders = z.array(sandboxOrderSchema).min(1).max(100).parse(rawOrders);
  if (new Set(orders.map(o => o.orderRef.sourceId)).size !== orders.length) throw new Error("MATRIX_DUPLICATE_ORDER");
  const rows = orders.map(order => evaluateRow(order, ctx));
  const cases = Object.fromEntries(MATRIX_CASES.map(c => [c, caseState(rows.filter(r => r.case === c))])) as MatrixResult["cases"];
  const states = Object.values(cases);
  const overall = states.includes("exception") ? "exception" : states.includes("fail") ? "failed" : states.every(s => s === "pass") ? "passed" : "incomplete";
  const attributionTests = rows.flatMap(r => r.test ? [r.test] : []);
  const refundTest = rows.find(r => r.case === "refund" && r.state === "pass")?.test ?? null;
  const linkOrCode = ctx.linkCodeRefs.find(r => r.kind === "link") ?? ctx.linkCodeRefs[0];
  const websiteCommerce = websiteCommerceSchema.parse({ kind: "website", linkOrCodeRef: linkOrCode?.ref.sourceId ?? null,
    attributionPrecedence: ctx.precedence === "unknown" ? null : ctx.precedence, test: overall === "passed" ? refundTest : null });
  return { matrixRef: "affiliate-matrix-" + digest([ctx, orders]).slice(0, 32), overall, cases, rows, exceptions: rows.filter(r => r.state === "exception"),
    definitions: ctx.definitions, definitionsVersion: ctx.definitions?.version ?? null, attributionTests, websiteCommerce };
}
