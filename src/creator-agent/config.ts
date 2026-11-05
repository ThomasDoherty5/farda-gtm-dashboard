import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Approved baseline files and private overrides both require an immutable, pinned numeric binding. */
const criterion = z.object({ id: z.string().min(1), label: z.string().min(1), weight: z.number().finite().positive().max(100) }).strict();
export const modelConfigSchema = z.object({
  modelId: z.enum(["WEBSITE-AFFILIATE-v3", "TIKTOK-SHOP-AFFILIATE-v3"]),
  version: z.string().min(1),
  approvalRef: z.string().min(1),
  baselineUri: z.string().min(1),
  criteria: z.array(criterion).min(2),
  routineCriterionId: z.string().min(1),
  demoCriterionId: z.string().min(1),
  arithmetic: z.literal("weight*rating/5;round-complete-total;no-rescaling"),
  decisionRules: z.object({ invitationMinScore: z.number().finite().min(0).max(100).nullable(), activationMinScore: z.number().finite().min(0).max(100), minCoveragePct: z.number().finite().min(0).max(100) }).strict().nullable().optional(),
  bands: z.array(z.object({ id: z.string().min(1), min: z.number().finite().min(0).max(100) }).strict()).min(1),
}).strict().superRefine((c, ctx) => {
  const ids = c.criteria.map((x) => x.id);
  if (new Set(ids).size !== ids.length || !ids.includes(c.routineCriterionId) || !ids.includes(c.demoCriterionId) || c.routineCriterionId === c.demoCriterionId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Distinct criterion IDs and both critical bindings are required" });
  if (Math.abs(c.criteria.reduce((s, x) => s + x.weight, 0) - 100) > 1e-9)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Bound percentage weights must total 100" });
  if (new Set(c.bands.map((b) => b.min)).size !== c.bands.length || !c.bands.some((b) => b.min === 0))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Bands need distinct floors including zero" });
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const numericDigest = (c: ModelConfig) => digest({ modelId: c.modelId, criteria: c.criteria.map(({ id, weight }) => ({ id, weight })), routineCriterionId: c.routineCriterionId, demoCriterionId: c.demoCriterionId, arithmetic: c.arithmetic, bands: c.bands, decisionRules: c.decisionRules ?? null });
export type ConfigBinding = { current: ModelConfig; baseline: ModelConfig; hash: string; baselineHash: string; numericHash: string };

export function bindConfig(raw: unknown, baselineRaw: unknown, expectedBaselineHash: string): ConfigBinding {
  const current = modelConfigSchema.parse(raw);
  const baseline = modelConfigSchema.parse(baselineRaw);
  const baselineHash = digest(baseline);
  if (!/^[a-f0-9]{64}$/.test(expectedBaselineHash) || baselineHash !== expectedBaselineHash) throw new Error("BASELINE_HASH_MISMATCH");
  if (numericDigest(current) !== numericDigest(baseline)) throw new Error("NUMERIC_CONFIGURATION_CHANGED");
  return { current, baseline, hash: digest(current), baselineHash, numericHash: numericDigest(current) };
}

/** Private config/approval records are supplied at deployment, never borrowed from historical fixtures. */
export function loadBindings(path: string | undefined): ConfigBinding[] {
  if (!path) return [];
  const input = z.array(z.object({ current: z.unknown(), baseline: z.unknown(), expectedBaselineHash: z.string() }).strict()).parse(JSON.parse(readFileSync(path, "utf8")));
  const bindings = input.map((x) => bindConfig(x.current, x.baseline, x.expectedBaselineHash));
  if (new Set(bindings.map((b) => b.current.modelId)).size !== bindings.length) throw new Error("DUPLICATE_MODEL_BINDING");
  return bindings;
}

/** First owner-approved launch baselines. Explicit overrides still go through the same immutable validator. */
export function loadApprovedBindings(): ConfigBinding[] {
  return ["website-affiliate-v3.2026-11-04.json", "tiktok-shop-affiliate-v3.2026-11-04.json"]
    .flatMap((name) => loadBindings(fileURLToPath(new URL(`./configurations/${name}`, import.meta.url))));
}
