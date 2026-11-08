import { z } from "zod";
import type { ApprovalRegistry } from "../approvals/contract.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import type { ActionPrincipalAuthority, ActionAuthorityFence, LedgerSource } from "../actions/contract.ts";
import { settlementScopeSchema, settlementRef, settlementInstant, settlementRecordSchema, moneyFactSchema, settlementEconomicsSchema, settlementStateTotalsSchema } from "./contract.ts";

export const settlementSourceRequestSchema=z.object({scope:settlementScopeSchema,principal:z.object({principalRef:settlementRef,role:z.enum(["reader","reviewer"])}).strict(),
  viewKey:z.enum(["commissionLedger","settlementDetail","payableDetail"]),targetRef:settlementRef.nullable(),provider:z.enum(["all","collabs","tiktok","externalManual"]),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
  limit:z.number().int().min(1).max(100),cursor:settlementRef.nullable(),snapshot:z.object({ref:settlementRef,version:settlementRef}).strict().nullable()}).strict();
/** Existing J11/J12 source records only. This interface neither ingests entitlements nor executes payments. */
export const settlementSnapshotSchema = z.object({ scope: settlementScopeSchema, viewKey: z.enum(["commissionLedger", "settlementDetail", "payableDetail"]),
  request: settlementSourceRequestSchema, snapshotRef: settlementRef, principalRef: settlementRef, version: settlementRef, permissionVersion: settlementRef, observedAt: settlementInstant,
  sourceUpdatedAt: settlementInstant.nullable(), validUntil: settlementInstant, access: z.enum(["allowed", "denied"]),
  state: z.enum(["current", "partial", "stale"]), synthetic: z.boolean(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  records: z.array(settlementRecordSchema).max(100), total: z.number().int().nonnegative().safe().nullable(),
  offset: z.number().int().nonnegative().safe(), complete: z.boolean(), nextCursor: settlementRef.nullable(),
  /** Mutually exclusive balances for the whole exact filtered snapshot, never totals of this response page. */
  stateTotals:settlementStateTotalsSchema.nullable().default(null),
  economics: settlementEconomicsSchema.nullable().default(null),
  totals: z.object({ eligible: moneyFactSchema, accrued: moneyFactSchema, creatorPaid: moneyFactSchema, contribution: moneyFactSchema }).strict(),
  accountingPolicy: z.object({ state: z.enum(["verified", "unknown"]), reference: settlementRef.nullable() }).strict(),
  export: z.object({ sourceVersion: settlementRef, filters: z.object({ state: z.enum(["all", "pending", "earned", "reversed", "settled"]),
    startAt: settlementInstant, endAt: settlementInstant, timezone: z.string(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict() }).strict().nullable(),
}).strict();
export type SettlementSnapshot = z.infer<typeof settlementSnapshotSchema>;
export type SettlementPrincipal = { principalRef: string; role: "reader" | "reviewer" };
export type SettlementSourceRequest = z.infer<typeof settlementSourceRequestSchema>;
export type SettlementSource = {
  read(request: SettlementSourceRequest, options?: { signal: AbortSignal }): Promise<unknown>;
  /** Must synchronously inspect current backing access/membership/version; undefined is the only accepted success. */
  assertCurrent(snapshot: SettlementSnapshot, principal: SettlementPrincipal, now: number, request: SettlementSourceRequest): void;
};
/** Existing canonical services own the effects. Absence is held, never a new local payout or reconciliation engine. */
export type SettlementBindings = {
  source?: SettlementSource;
  authority?: { resolve: ActionPrincipalAuthority; assertCurrent: ActionAuthorityFence };
  permittedLinkOrigins?: readonly string[];
  ledger?: LedgerSource;
  matching?: { actionKind: "settlement.matchStatement"; registry: ApprovalRegistry; handler: DispatchHandler };
};
