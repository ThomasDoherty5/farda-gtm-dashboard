/**
 * The registry the live adapter checks every read against (THO-283, front-end half).
 *
 * Each area file owns the schemas for its own view keys. This file only merges them and refuses a duplicate: two areas
 * claiming one view key would mean one of them is silently ignored. A view key that is not here has no schema, and
 * the live adapter does not trust an answer it cannot check.
 */
import { exportViewSchemas } from "../../creator-agent/actions/exportViews";
import { nativeCommissionLedgerSchema, nativeSettlementSchema, nativePayableSchema } from "./settlements";
import { z } from "zod";
import { analyticsViewSchemas } from "./analytics";
import { approvalActionSchemas, approvalViewSchemas } from "./approvals";
import { collaborationViewSchemas } from "./collaboration";
import { creatorsViewSchemas } from "./creators";
import { evidenceViewSchemas } from "./evidence";
import { financeViewSchemas } from "./finance";
import { lifecycleActionSchemas, lifecycleViewSchemas } from "./lifecycle";
import { monitorViewSchemas } from "./monitor";
import { opsActionSchemas, opsViewSchemas } from "./ops";
import { recruitmentViewSchemas } from "./recruitment";
import { scorecardsViewSchemas } from "./scorecards";
import { shippingHubViewSchemas } from "./shippingHub";
import { settingsActionSchemas, settingsViewSchemas } from "./settings";

export type ViewSchemas = Readonly<Record<string, z.ZodTypeAny>>;
export type ActionPayloadSchemas = Readonly<Record<string, { payload: z.ZodTypeAny }>>;

/** Merges area maps and throws on a repeated key, so a clash fails at import time and in the registry test. */
export function mergeSchemas<T>(label: string, parts: Readonly<Record<string, T>>[]): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const part of parts)
    for (const [key, schema] of Object.entries(part)) {
      if (key in out) throw new Error(`${label} "${key}" is registered by more than one area`);
      out[key] = schema;
    }
  return out;
}

export const viewSchemas: ViewSchemas = mergeSchemas<z.ZodTypeAny>("view key", [
  exportViewSchemas, analyticsViewSchemas, approvalViewSchemas, collaborationViewSchemas, creatorsViewSchemas, evidenceViewSchemas, {...financeViewSchemas,commissionLedger:z.union([nativeCommissionLedgerSchema,financeViewSchemas.commissionLedger]),settlementDetail:z.union([nativeSettlementSchema,financeViewSchemas.settlementDetail]),payableDetail:z.union([nativePayableSchema,financeViewSchemas.payableDetail])},
  lifecycleViewSchemas, monitorViewSchemas, opsViewSchemas, recruitmentViewSchemas, scorecardsViewSchemas, settingsViewSchemas, shippingHubViewSchemas,
]);

export const actionPayloadSchemas: ActionPayloadSchemas = mergeSchemas<{ payload: z.ZodTypeAny }>("action kind", [approvalActionSchemas, lifecycleActionSchemas, opsActionSchemas, settingsActionSchemas]);
