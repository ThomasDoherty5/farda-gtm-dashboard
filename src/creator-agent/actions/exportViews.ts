import { z } from "zod";
import { exportPayloadSchema, exportReceiptSchema, reference } from "./contract.ts";

/** Original-request recovery reads the existing export job; it never starts or retries generation. */
export const ledgerExportRequestFilters = z.object({ requestKey: reference, expectedVersion: reference, payload: exportPayloadSchema }).strict();
export const ledgerExportArtifactFilters = z.object({ artifactRef: reference }).strict();
export const ledgerExportRequestViewSchema = z.object({
  kind: z.literal("native-ledger-export-request"), requestKey: reference,
  state: z.enum(["absent", "pending", "failed", "succeeded"]),
  receipt: exportReceiptSchema.nullable(),
  progress: z.object({ processedRows: z.number().int().nonnegative().nullable(), totalRows: z.number().int().nonnegative().nullable() }).strict(),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
}).strict().superRefine((value,ctx)=>{
  if((value.state==="succeeded") !== (value.receipt!==null))ctx.addIssue({code:"custom",message:"Only a confirmed artifact has an export receipt."});
  if(value.receipt && value.receipt.requestKey!==value.requestKey)ctx.addIssue({code:"custom",message:"Export recovery must name the original request."});
});
export const ledgerExportArtifactViewSchema = z.object({
  kind: z.literal("native-ledger-export-artifact"), receipt: exportReceiptSchema, body: z.string().max(16_100_000),
}).strict();
export const exportViewSchemas = { ledgerExportRequest: ledgerExportRequestViewSchema, ledgerExportArtifact: ledgerExportArtifactViewSchema };
export type LedgerExportRequestView = z.infer<typeof ledgerExportRequestViewSchema>;
export type LedgerExportArtifactView = z.infer<typeof ledgerExportArtifactViewSchema>;
