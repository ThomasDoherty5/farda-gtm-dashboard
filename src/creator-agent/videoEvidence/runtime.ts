import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest, type ConfigBinding } from "../config.ts";
import type { CreatorEvidenceWriter } from "../creatorEvidenceWriter.ts";
import { J20_SAMPLING_POLICY_VERSION, J20_TAXONOMY_VERSION, VIDEO_EVIDENCE_SCHEMA_VERSION, type EvidencePacket } from "../evidence.ts";
import type { IntakeRepository } from "../intake/repository.ts";
import { RuntimeError, type RuntimeExecutor, type RuntimeRegistration, type RuntimeRegistry, type RuntimeStep } from "../jobs/runtimeSchema.ts";
import type { OperationsScope } from "../operations.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { AgentConflict, type AgentStore } from "../store.ts";
import { J20_COLLECTOR_REQUEST_VERSION, videoEvidenceReadSchema, type VideoEvidenceBinding, type VideoEvidenceRequest, type VideoEvidenceSnapshot } from "./contract.ts";
import { buildCollectedPacket } from "./packet.ts";

export const J20_EXECUTOR_VERSION = "j20-video-evidence.v1" as const;

function assertRegistration(registration: RuntimeRegistration | undefined, registry: RuntimeRegistry): asserts registration is RuntimeRegistration {
  // The runtime schema already requires J20 to run on its own daily calendar registration.
  if (!registration || registration.family !== "J20" || registration.definition.mode !== "observe" || registration.membership === "approved-manifest" ||
      !registration.apiBinding || registration.apiChannel === "model" || registration.cadence.kind !== "calendar") {
    throw new RuntimeError("J20_REGISTRATION_INVALID", 422);
  }
  const refs = [registration.executorRef, ...(registration.browserExecutorRef ? [registration.browserExecutorRef] : [])];
  if (refs.some(ref => registry.executors.has(ref)) || [...registry.registrations.values()].some(other => other.registrationRef !== registration.registrationRef &&
      (refs.includes(other.executorRef) || (other.browserExecutorRef !== null && refs.includes(other.browserExecutorRef))))) {
    throw new RuntimeError("J20_EXECUTOR_IN_USE", 409);
  }
}

/**
 * Binds the J20 collector to an existing compiled daily J20 registration. The executor reads the J01 intake J20 queue,
 * reads one bounded source page per step and writes only through the shared creator evidence writer. It never scores,
 * resolves claims, sends or bypasses source access; login and MFA become the runtime's owned takeover.
 */
export function bindVideoEvidence(deps: { registry: RuntimeRegistry; binding: VideoEvidenceBinding; intake: IntakeRepository; store: AgentStore;
  writer: CreatorEvidenceWriter; modelBinding(route: EvidencePacket["checkoutRoute"]): ConfigBinding | null; scope: OperationsScope; now?: () => number }) {
  const { binding, intake, store, writer } = deps;
  const { source } = binding;
  if (source.stage !== "source" && source.stage !== "synthetic-fixture") throw new RuntimeError("J20_COLLECTOR_STAGE_INVALID", 422);
  // The same guard as the reference test double: a synthetic collector never runs in a production process.
  if (source.stage === "synthetic-fixture" && process.env.NODE_ENV === "production") throw new RuntimeError("J20_SYNTHETIC_COLLECTOR_IN_PRODUCTION", 422);
  const registration = deps.registry.registrations.get(binding.registrationRef);
  assertRegistration(registration, deps.registry);
  const registrationHash = digest(registration);
  const now = deps.now ?? Date.now;
  const scope = { workspaceId: deps.scope.workspaceId, accountId: deps.scope.accountId, environment: "sandbox" as const };
  const collector = { version: source.collectorVersion, stage: source.stage };

  const executor: RuntimeExecutor = {
    mode: "observe",
    async execute(context): Promise<RuntimeStep> {
      if (digest(context.registration) !== registrationHash) throw new RuntimeError("J20_WINDOW_MISMATCH", 409);
      // loadInput: only a creator whose current verified J01 enrollment emitted J20 work is reviewed.
      const work = intake.reviewWork(context.subjectRef);
      if (!work) return { state: "held", reasonCode: "J20_NOT_QUEUED" };
      if (!work.briefRef) return { state: "held", reasonCode: "J20_BRIEF_UNBOUND" };
      const route = context.binding.route === "browser" ? "browser" as const : "api" as const;
      const request: VideoEvidenceRequest = { version: J20_COLLECTOR_REQUEST_VERSION, scope: { ...scope }, creatorId: work.creatorId,
        intakeRevision: work.revision, briefRef: work.briefRef, profiles: work.profiles, cursor: context.cursor, maxRecords: context.maxRecords,
        route, window: structuredClone(context.window), samplingPolicyVersion: J20_SAMPLING_POLICY_VERSION, taxonomyVersion: J20_TAXONOMY_VERSION };
      const channel = route === "browser" ? "browser" as const : registration.apiChannel;
      const response = await context.invoke(channel, () => boundedSourceRead(() => source.read(structuredClone(request))))
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      context.assertCurrent();
      if (!response.ok) {
        if (response.error instanceof RuntimeError && ![429, 503, 504].includes(response.error.status)) throw response.error;
        return { state: "retry", reasonCode: "SOURCE_READ_UNAVAILABLE", retryAfterMs: 1000 };
      }
      const read = videoEvidenceReadSchema.safeParse(response.value);
      if (!read.success) throw new RuntimeError("J20_SOURCE_RESPONSE_INVALID", 502);
      if (read.data.state === "takeover") return { state: "takeover", kind: read.data.kind, handoffRef: binding.handoffRef,
        ownerRef: registration.ownerRef, reasonCode: read.data.kind === "login" ? "SOURCE_LOGIN" : "SOURCE_MFA" };
      if (read.data.state === "denied") throw new RuntimeError("SOURCE_SCOPE_DENIED", 403);
      if (read.data.state === "unavailable") return { state: "retry", reasonCode: "SOURCE_READ_UNAVAILABLE", retryAfterMs: read.data.retryAfterMs };
      const snapshot = read.data.snapshot;
      const assertSnapshot = () => {
        const at = now();
        if (snapshot.requestDigest !== digest(request) || Date.parse(snapshot.observedAt) > at || Date.parse(snapshot.validUntil) <= at ||
            snapshot.posts.some(post => Date.parse(post.retrievedAt) > Date.parse(snapshot.observedAt)))
          throw new RuntimeError("J20_SOURCE_SNAPSHOT_STALE", 409);
        assertSynchronousVoid(() => source.assertCurrent(structuredClone(snapshot), structuredClone(request), at));
      };
      if (snapshot.brief.ref !== work.briefRef.ref || snapshot.brief.version !== work.briefRef.version) throw new RuntimeError("J20_BRIEF_MISMATCH", 502);
      if (snapshot.posts.length > context.maxRecords) throw new RuntimeError("RUNTIME_SOURCE_BOUND_EXCEEDED", 502);
      if (snapshot.nextCursor !== null && snapshot.nextCursor === context.cursor) throw new RuntimeError("RUNTIME_CURSOR_NOT_ADVANCING", 502);
      assertSnapshot();
      const prior = store.latest(work.creatorId);
      let built: ReturnType<typeof buildCollectedPacket>;
      try { built = buildCollectedPacket({ creatorId: work.creatorId, prior: prior?.packet ?? null, snapshot, collector, protect: writer.protect }); }
      catch { throw new RuntimeError("J20_SOURCE_RESPONSE_INVALID", 502); }
      let runId = prior?.runId ?? null;
      if (built.changed && (prior || snapshot.posts.length)) {
        const expectedVersion = prior?.revision ?? 0;
        try {
          const saved = await writer.write({ packet: built.packet, expectedVersion, configHash: deps.modelBinding(built.packet.checkoutRoute)?.hash ?? null },
            `j20:${digest({ creatorId: work.creatorId, expectedVersion, evidenceRevision: built.packet.evidenceRevision })}`,
            { origin: "collector", fence: () => { context.assertCurrent(); assertSnapshot(); context.assertCurrent(); } });
          runId = saved.runId;
        } catch (error) {
          // A concurrent reviewer or collector write moved the head: re-read the latest evidence on retry, never overwrite it.
          if (error instanceof AgentConflict && error.message === "VERSION_CONFLICT") return { state: "retry", reasonCode: "J20_EVIDENCE_HEAD_MOVED", retryAfterMs: 1000 };
          throw error;
        }
      }
      const evidenceRefs = runId && snapshot.posts.length ? [`j20-evidence:${runId}`] : [];
      const recordCount = snapshot.posts.length;
      return snapshot.nextCursor
        ? { state: "checkpoint", evidenceRefs, recordCount, nextCursor: snapshot.nextCursor, sourceReceiptRef: snapshot.receiptRef }
        : { state: "completed", evidenceRefs, recordCount, sourceReceiptRef: snapshot.receiptRef };
    },
  };
  const executors = new Map(deps.registry.executors).set(registration.executorRef, executor);
  if (registration.browserExecutorRef) executors.set(registration.browserExecutorRef, executor);
  return {
    registry: { registrations: deps.registry.registrations, executors } satisfies RuntimeRegistry,
    capability: { collector: source.stage, collectorVersion: source.collectorVersion, executorVersion: J20_EXECUTOR_VERSION,
      schemaVersion: VIDEO_EVIDENCE_SCHEMA_VERSION, samplingPolicyVersion: J20_SAMPLING_POLICY_VERSION, taxonomyVersion: J20_TAXONOMY_VERSION,
      writer: "creator-evidence-writer", queue: "intake-j20", scoring: "j02-only", dispatch: "notConnected" },
  };
}
export type BoundVideoEvidence = ReturnType<typeof bindVideoEvidence>;
export type { VideoEvidenceBinding, VideoEvidenceSnapshot };
