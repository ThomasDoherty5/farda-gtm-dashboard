import { z } from "zod";

const instant = z.string().datetime();
const alias = z.string().regex(/^(binding|account|action|owner|job|run|event|receipt)-[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const coverage = z.object({ total: count, returned: count, partial: z.boolean() }).strict();
const common = { source: z.literal("saved-operations"), observedAt: instant };
export const bindingStateSchema = z.enum(["Documented", "Unverified", "Ready", "Blocked", "Unsupported", "Expired", "Missing evidence"]);
const sourceHealth = z.object({
  state: z.enum(["ready", "unverified", "blocked", "unsupported"]), checkedAt: instant.nullable(), mirrorUpdatedAt: instant.nullable(),
  permission: z.enum(["allowed", "denied", "unknown"]), session: z.enum(["authenticated", "expired", "mfa", "ui_changed", "unknown"]),
  coverage: z.enum(["complete", "partial", "unknown"]),
}).strict();
const binding = z.object({
  id: alias, provider: z.string(), account: alias, action: z.string(), owner: alias,
  mode: z.enum(["observe", "propose", "executeApproved", "reconcile"]), route: z.enum(["api", "mcp", "browser", "webhook", "manual"]),
  state: bindingStateSchema, revision: count, checkedAt: instant.nullable(), expiresAt: instant.nullable(),
  receipt: alias.nullable(), observedAt: instant.nullable(), sourceUpdatedAt: instant.nullable(),
  freshness: z.enum(["unknown", "current", "stale", "unavailable"]), lastSuccessAt: instant.nullable(), sourceHealth: sourceHealth.nullable(), blockers: z.array(z.string()),
}).strict();
export const savedBindingsSchema = z.object({ ...common, kind: z.literal("saved-bindings"), records: z.array(binding), coverage }).strict();
const savedJob = z.object({ id: alias, version: count, mode: z.enum(["observe", "propose"]), enabled: z.boolean(), paused: z.boolean() }).strict();
const savedRun = z.object({
  id: alias, job: alias, correlation: alias, version: count, mode: z.enum(["observe", "propose"]), observedAt: instant, state: z.string(),
  items: count, completed: count, blockers: z.array(z.string()), receipt: alias.nullable(), receiptCount: count,
}).strict();
export const savedRunsSchema = z.object({ ...common, kind: z.literal("saved-runs"), records: z.array(savedRun),
  coverage, jobs: z.array(savedJob), jobCoverage: coverage }).strict();
export type SavedBinding = z.infer<typeof binding>;
export type SavedBindings = z.infer<typeof savedBindingsSchema>;
export type SavedRuns = z.infer<typeof savedRunsSchema>;
