import {z} from "zod";
import {jobRunViewSchema,itemStateSchema} from "./schema.ts";
const runtimeInstant=z.string().datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)));
export const runtimeApiOperationSchema=z.enum(["install","fire","catchUp","work","continue","reconcile","takeover"]);
export type RuntimeApiOperation=z.infer<typeof runtimeApiOperationSchema>;
const count=z.number().int().nonnegative().safe(),alias=z.string().regex(/^(owner|evidence|usage)-[a-f0-9]{64}$/);
const token=z.string().regex(/^rt-(run|registration|item)-[A-Za-z0-9_-]+$/).max(1400);
export const runtimeUsageViewSchema=z.object({invocations:z.object({directApi:count,mcp:count,model:count,browser:count}).strict(),pendingInvocations:count,measuredRuntimeMs:z.number().finite().nonnegative(),ordinaryZapTasks:count.nullable(),mcpTasks:count.nullable(),modelTokens:count.nullable(),observedCostMinor:count.nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),costCoverage:z.enum(["unknown","partial"]),runtimeCost:z.literal("unknown"),receiptAliases:z.array(alias).max(1000),coverage:z.literal("instrumented-invocations-only")}).strict();
export const safeRuntimeRunSchema=z.object({kind:z.literal("registered-runtime-run"),source:z.literal("native-runtime"),environment:z.literal("sandbox"),runRef:token,registrationRef:token,registrationVersion:count,
  family:z.enum(["J19","J20","J08","registered-business"]),mode:z.enum(["observe","propose","executeApproved","reconcile"]),state:jobRunViewSchema.shape.state,control:jobRunViewSchema.shape.control,
  intendedAt:runtimeInstant,windowStart:runtimeInstant,windowEnd:runtimeInstant,observedAt:runtimeInstant,delayMs:count,sourceCoverage:z.enum(["complete","partial"]),sourceObservedAt:runtimeInstant,sourceFresh:z.boolean(),sourceReceiptAlias:alias,
  counts:jobRunViewSchema.shape.counts,hasContinuation:z.boolean(),executionCertainty:z.enum(["notApplied","applied","uncertain"]),blockers:z.array(z.string()).max(100),nextAction:z.string().max(300),
  items:z.array(z.object({itemRef:token,state:itemStateSchema,attempts:count,steps:count,dueAt:runtimeInstant,checkpointVersion:count,hasCursor:z.boolean(),retainedEvidenceRefs:count,result:z.enum(["none","observationRecorded","proposalRecorded","nativeReceiptRecorded"]),reasonCode:z.string().nullable()}).strict()).max(100),
  takeovers:z.array(z.object({itemRef:token,version:count,kind:z.enum(["login","mfa","captcha","uiDrift","termsChanged"]),ownerAlias:alias,resolved:z.boolean()}).strict()).max(500),usage:runtimeUsageViewSchema,
}).strict();
export type SafeRuntimeRun=z.infer<typeof safeRuntimeRunSchema>;
const cadenceSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("event")}).strict(),z.object({kind:z.literal("hourly"),timezone:z.string(),minute:count,startsAt:runtimeInstant}).strict(),
  z.object({kind:z.literal("calendar"),timezone:z.string(),localTime:z.string(),cadence:z.enum(["daily","weekdays","weekly-monday"]),startsAt:runtimeInstant}).strict(),
]);
export const safeRuntimeRegistrationSchema=z.object({kind:z.literal("registered-runtime"),source:z.literal("native-runtime"),environment:z.literal("sandbox"),registrationRef:token,version:count,family:safeRuntimeRunSchema.shape.family,mode:safeRuntimeRunSchema.shape.mode,ownerAlias:alias,cadence:cadenceSchema,observedAt:runtimeInstant,validUntil:runtimeInstant,
  cadenceStatus:z.object({kind:z.enum(["event","scheduled"]),nextPlannedAt:runtimeInstant.nullable(),oldestUnadmittedAt:runtimeInstant.nullable(),unadmittedInScannedRange:count,scannedSlots:count,scanComplete:z.boolean(),scanCursor:runtimeInstant.nullable()}).strict(),
  windows:z.array(z.object({runRef:token.nullable(),intendedAt:runtimeInstant}).strict()).max(25),coverage:z.object({returned:count,total:z.null(),partial:z.boolean()}).strict(),
}).strict();
export const runtimeApiAckSchema=z.object({kind:z.literal("runtime-command-ack"),operation:runtimeApiOperationSchema,state:z.enum(["registered","queued","running","completed","held","partial","paused","cancelled","uncertain"]),executionCertainty:z.enum(["notApplied","applied","uncertain"]),registrationRef:token.nullable(),runRefs:z.array(token).max(24),returned:count,nextCursor:runtimeInstant.nullable(),hasMore:z.boolean()}).strict();
export type RuntimeApiAck=z.infer<typeof runtimeApiAckSchema>;
