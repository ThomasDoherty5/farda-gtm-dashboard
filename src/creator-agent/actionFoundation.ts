import { createHash, timingSafeEqual } from "node:crypto";
import { createDailyDigestReporting, type DailyDigestConfig } from "./dailyDigest/service.ts";
import { createWeeklySnapshotReporting, type WeeklySnapshotConfig } from "./weeklySnapshots/service.ts";
import { createLaunchPulseReporting, type LaunchPulseConfig } from "./launchPulse/service.ts";
import { bindCreatorFeed, type CreatorFeedConfig } from "./creatorHandoff/source.ts";
import { bindAutomationFailureReporting, type AutomationFailureReportingBinding } from "./slackReporting/automationFailure.ts";
import { bindOperationalAlertReporting, type OperationalAlertReportBinding } from "./operationalAlerts/report.ts";
import type { OperationalAlertRepository } from "./operationalAlerts/repository.ts";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApprovalManifest } from "./approvals/contract.ts";
import type { CommercialProjection } from "./commercialPolicy/projection.ts";
import { ApprovalRepository, type ApprovalRepositoryOptions } from "./approvals/repository.ts";
import { approvalScopeSchema, approvalRefSchema, approvalInstantSchema, slackDecisionLocatorSchema } from "./approvals/contract.ts";
import { DispatchGuard, type DispatchGuardOptions } from "./jobs/dispatchGuard.ts";
import { DispatchError } from "./jobs/dispatchSchema.ts";
import type { JobRepository } from "./jobs/repository.ts";
import type { CapabilityLedger } from "./connections/ledger.ts";
import { createActionService, domainActionSchema, foundationActionSchema, type RegisteredAction } from "./actions/service.ts";
import { createActionDomainServices } from "./actions/domainServices.ts";
import type { LedgerSource, ReadinessSource, ActionScope } from "./actions/contract.ts";
import { createActionReviewService } from "./actions/review.ts";
import type { ActionReviewSource } from "./actions/reviewSource.ts";
import { createSlackReporting } from "./slackReporting/service.ts";
import { ReportError, reportLocatorSchema, reportReference, reportReadSchema, type ReportingSource, type ReportRead } from "./slackReporting/contract.ts";
import { ApiRequestLimits } from "./apiRequestLimits.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";

export const dispatchWorkerProofSchema = z.object({ scope: approvalScopeSchema, runRef: approvalRefSchema,
  workerRef: approvalRefSchema, authorityVersion: approvalRefSchema, observedAt: approvalInstantSchema,
  validUntil: approvalInstantSchema }).strict();
export type DispatchWorkerProof = z.infer<typeof dispatchWorkerProofSchema>;
/** Optional private bindings. No browser payload, shared reviewer credential or environment default grants these authorities. */
export type ActionFoundationBindings = {
  approvals?: Omit<ApprovalRepositoryOptions, "scope" | "now" | "verifyOutcome">;
  registry?: ReadonlyMap<string, RegisteredAction>;
  handlers?: DispatchGuardOptions["handlers"];
  resources?: DispatchGuardOptions["resourceAuthority"];
  ledger?: LedgerSource;
  readiness?: ReadinessSource;
  readinessTargetRef?: string;
  reviewSource?: ActionReviewSource;
  reviewLinkOrigins?: readonly string[];
  reporting?: {token:string;workerRef:string;source:ReportingSource;dailyDigest?:DailyDigestConfig;automationFailures?:AutomationFailureReportingBinding;weeklySnapshots?:WeeklySnapshotConfig;launchPulse?:LaunchPulseConfig;creatorFeed?:CreatorFeedConfig;
    assertCurrent(request:{scope:ActionScope;workerRef:string;operation:"accept"|"read"|"work"|"reconcile";reference:string},now:number):void};
  worker?: { token: string; workerRef: string;
    resolve: (scope: ActionScope, runRef: string) => Promise<unknown>;
    /** Synchronous current-authority fence, checked again in the existing job transaction. */
    assertCurrent: (proof: DispatchWorkerProof, now: number) => void };
  /** Authenticated transformed relay; the source reader independently verifies the exact native Slack event. */
  decisionRelay?: { token: string; ingressRef: string };
};

const equal = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const request = z.object({ runRef: approvalRefSchema }).strict();
export function assertMachineTokens(bindings: ActionFoundationBindings | undefined, readToken: string, reviewToken: string) {
  const tokens = [readToken, reviewToken];
  for (const machine of [bindings?.worker, bindings?.decisionRelay, bindings?.reporting]) {
    if (!machine) continue;
    if (machine.token.length < 32 || tokens.some(token => equal(token, machine.token))) throw new Error("Machine authority requires its own distinct server-only credential.");
    tokens.push(machine.token);
  }
  if (bindings?.worker) approvalRefSchema.parse(bindings.worker.workerRef);
  if (bindings?.reporting) { reportReference.parse(bindings.reporting.workerRef);
    if(typeof bindings.reporting.assertCurrent!=="function") throw new Error("Reporting requires a source-owned machine fence."); }
  if (bindings?.decisionRelay) {
    approvalRefSchema.parse(bindings.decisionRelay.ingressRef);
    if (!bindings.approvals?.sources?.readSlackDecision) throw new Error("Decision relay requires an independent native event reader.");
  }
}

/** One composition of J04, existing jobs, action contracts and domain owners, on the same scoped database. */
export function createActionFoundation(options: { db: DatabaseSync; scope: ActionScope; secret: string;
  jobs: JobRepository; ledger: CapabilityLedger; bindings?: ActionFoundationBindings;
  operationalAlerts?: { repository: OperationalAlertRepository; report: OperationalAlertReportBinding };
  commercialEligibility?: (manifest: ApprovalManifest) => ReadonlyMap<string, CommercialProjection>; now?: () => number }) {
  const { db, scope, secret, jobs, ledger } = options, bindings = options.bindings ?? {}, now = options.now ?? Date.now;
  const approvals: ApprovalRepository = new ApprovalRepository(db, { ...bindings.approvals, scope, now,
    verifyOutcome: outcome => dispatch.verifyOutcome(outcome) });
  const dispatch: DispatchGuard = new DispatchGuard({ db, scope, jobs, ledger, approvals, resourceAuthority: bindings.resources,
    handlers: bindings.handlers ?? new Map(), now });
  const domains = createActionDomainServices({ db, scope, secret, jobs, now, authorize: bindings.approvals?.sources?.resolveActor,
    assertAuthority: bindings.approvals?.sources?.assertCurrent,
    ledger: bindings.ledger, readiness: bindings.readiness });
  const service = createActionService({ scope, secret, approvals, dispatch, domains, registry: bindings.registry ?? new Map(),
    authorize: bindings.approvals?.sources?.resolveActor, assertAuthority: bindings.approvals?.sources?.assertCurrent,
    attemptOutcomes: runRef => dispatch.readAttemptOutcomes(runRef),
    executionRuns:(ref,version)=>dispatch.readApprovalRuns(ref,version),
    review: createActionReviewService({scope,referenceKey:secret,source:bindings.reviewSource,permittedLinkOrigins:bindings.reviewLinkOrigins,now}),
    commercialEligibility: options.commercialEligibility, now });
  const limits = new ApiRequestLimits(db, scope, now);
  const reportBinding = bindings.reporting;
  const alertConfig = options.operationalAlerts;
  const alertReports = reportBinding && alertConfig
    ? bindOperationalAlertReporting(alertConfig.repository, scope, alertConfig.report, reportBinding.source, now) : undefined;
  const baseSource = alertReports?.reportingSource ?? reportBinding?.source;
  const baseReportSource = reportBinding?.dailyDigest
    ? createDailyDigestReporting(db, scope, { ...reportBinding.dailyDigest,
      ...(alertReports ? { thresholds: alertReports.digestFor } : {}) }, baseSource!, now)
    : baseSource;
  const weeklySnapshots = reportBinding?.weeklySnapshots && baseReportSource
    ? createWeeklySnapshotReporting(db, scope, reportBinding.weeklySnapshots, baseReportSource, now) : undefined;
  const weeklyReportSource = weeklySnapshots?.reportingSource ?? baseReportSource;
  const pulseReportSource = reportBinding?.launchPulse && weeklyReportSource
    ? createLaunchPulseReporting(db, scope, reportBinding.launchPulse, weeklyReportSource, now) : weeklyReportSource;
  const creatorReportSource = pulseReportSource ? bindCreatorFeed(pulseReportSource, scope, reportBinding?.creatorFeed, now) : undefined;
  const reportSource = reportBinding?.automationFailures && creatorReportSource
    ? bindAutomationFailureReporting(creatorReportSource, scope, secret, reportBinding.automationFailures) : creatorReportSource;
  const reporting = reportBinding ? createSlackReporting({ db, scope, secret, jobs, source: reportSource, now }) : undefined;
  const reportAccept=z.object({locator:reportLocatorSchema,idempotencyKey:reportReference}).strict();
  const reportTarget=z.object({reportRef:reportReference}).strict();
  function authenticateReporting(authorization:string|undefined) {
    if(!bindings.reporting || !reporting) throw new ReportError("REPORTING_MACHINE_UNCONFIGURED",503,"uncertain");
    if(!authorization?.startsWith("Bearer ") || !equal(authorization.slice(7),bindings.reporting.token)) throw new ReportError("UNAUTHENTICATED",401,"uncertain");
  }
  function reportMachine(operation:"accept"|"read"|"work"|"reconcile", reference:string) {
    const configured=bindings.reporting!;
    const assertCurrent=()=>{try{
      // A void callback can still be async at runtime. A final authority fence
      // must finish synchronously before the same-database effect transaction.
      assertSynchronousVoid(()=>configured.assertCurrent({scope:structuredClone(scope),workerRef:configured.workerRef,operation,reference},now()));
    }
      catch{throw new ReportError("REPORT_MACHINE_AUTHORITY_INVALID",403,"uncertain");}};
    assertCurrent();const admission=limits.admit("report-machine:"+configured.workerRef,operation==="read"?"read":"write");
    if(!admission.admitted)throw new ReportError("RATE_LIMITED",429,"uncertain",admission.retryAfterMs);
    return {workerRef:configured.workerRef,assertCurrent};
  }
  function readOperationalAlertDeliveries(rawRef: string, authorization: string | undefined) {
    authenticateReporting(authorization);
    const runRef = reportReference.parse(rawRef);
    const reference = "threshold-run-" + createHash("sha256").update(runRef).digest("hex");
    const machine = reportMachine("read", reference);
    if (!alertReports) throw new ReportError("ALERT_REPORTING_UNCONFIGURED", 503);
    const deliveries = alertReports.deliveriesFor(runRef);
    machine.assertCurrent();
    return { deliveries };
  }
  async function executeReporting(operation:"accept"|"read"|"work"|"reconcile", raw:unknown, authorization:string|undefined) {
    authenticateReporting(authorization);
    const target=operation==="accept" ? reportAccept.parse(raw) : reportTarget.parse(raw);
    const reference="locator" in target ? "report-event-"+createHash("sha256").update(JSON.stringify(target.locator)).digest("hex") : target.reportRef;
    const machine=reportMachine(operation,reference);
    let result:ReportRead;
    if("locator" in target) result=await reporting!.accept(target.locator,target.idempotencyKey,machine);
    else result=operation==="read" ? await reporting!.read(target.reportRef,machine) : operation==="work" ? await reporting!.work(target.reportRef,machine) : await reporting!.reconcile(target.reportRef,machine);
    try{machine.assertCurrent();}catch{throw new ReportError("REPORT_MACHINE_AUTHORITY_INVALID",403,result.executionCertainty);}
    return reportReadSchema.parse(result);
  }

  function machineBearer(authorization: string | undefined, token: string) {
    return authorization?.startsWith("Bearer ") === true && equal(authorization.slice(7), token);
  }
  function authenticateMachine(kind: "worker" | "decisionRelay", authorization: string | undefined) {
    const configured = bindings[kind];
    if (!configured) throw new DispatchError(kind === "worker" ? "DISPATCH_WORKER_UNCONFIGURED" : "APPROVAL_INGRESS_UNCONFIGURED", 503, "uncertain");
    if (!machineBearer(authorization, configured.token)) throw new DispatchError("UNAUTHENTICATED", 401, "uncertain");
  }
  async function executeWorker(raw: unknown, authorization: string | undefined) {
    const worker = bindings.worker;
    if (!worker) throw new DispatchError("DISPATCH_WORKER_UNCONFIGURED", 503, "uncertain");
    if (!machineBearer(authorization, worker.token)) throw new DispatchError("UNAUTHENTICATED", 401, "uncertain");
    const input = request.parse(raw);
    const admission = limits.admit("machine-worker:" + worker.workerRef, "write");
    if (!admission.admitted) throw new DispatchError("RATE_LIMITED", 429, "uncertain", admission.retryAfterMs);
    let resolved: unknown;
    try { resolved = await worker.resolve(scope, input.runRef); }
    catch { throw new DispatchError("DISPATCH_WORKER_AUTHORITY_INVALID", 403, "uncertain"); }
    const parsed = dispatchWorkerProofSchema.safeParse(resolved);
    if (!parsed.success) throw new DispatchError("DISPATCH_WORKER_AUTHORITY_INVALID", 403, "uncertain");
    const proof = parsed.data;
    const assertCurrent = () => {
      const t = now();
      if (!Number.isSafeInteger(t) || proof.scope.workspaceId !== scope.workspaceId || proof.scope.accountId !== scope.accountId || proof.scope.environment !== scope.environment ||
        proof.runRef !== input.runRef || proof.workerRef !== worker.workerRef || Date.parse(proof.observedAt) > t || Date.parse(proof.validUntil) <= t ||
        Date.parse(proof.validUntil) - Date.parse(proof.observedAt) > 300_000 || Date.parse(proof.validUntil) <= Date.parse(proof.observedAt))
        throw new DispatchError("DISPATCH_WORKER_AUTHORITY_INVALID", 403, "uncertain");
      try { assertSynchronousVoid(()=>worker.assertCurrent(proof, t)); }
      catch { throw new DispatchError("DISPATCH_WORKER_AUTHORITY_INVALID", 403, "uncertain"); }
    };
    assertCurrent();
    const result = await dispatch.execute(input.runRef, { workerRef: worker.workerRef, assertCurrent });
    if (result.executionCertainty === "uncertain") throw new DispatchError("OUTCOME_UNCERTAIN", 502, "uncertain");
    // A failed/uncertain Linear link never repeats a native effect. Each outcome is verified against the existing job store.
    let linksVerified = true;
    for (const item of result.items) {
      if (!item.receipt) continue;
      try { const linked = await approvals.syncOutcomeLink({ approvalRef: item.intent.approval.approvalRef,
        manifestVersion: item.intent.approval.manifestVersion, manifestHash: item.intent.approval.manifestHash,
        itemRef: item.intent.approval.itemRef, runRef: result.runRef, outcomeRef: item.receipt.receiptRef });
        if (linked.outbox.some(box => box.kind === "outcome" && box.state !== "recorded")) linksVerified = false; }
      catch { linksVerified = false; }
    }
    // Outcome synchronization awaits independent source reads. A later loss of machine
    // authority clears the response without erasing or reclassifying the native effect.
    try { assertCurrent(); }
    catch (error) {
      if (error instanceof DispatchError) throw new DispatchError(error.code, error.status, result.executionCertainty, error.retryAfterMs);
      throw new DispatchError("DISPATCH_WORKER_AUTHORITY_INVALID",403,result.executionCertainty);
    }
    // Machine acknowledgment contains no source locators or private payloads. Provider receipts remain in the native job store.
    return { schemaVersion: "farda.dispatch-worker.v1", runRef: result.runRef, state: result.current.state,
      executionCertainty: result.executionCertainty, receiptCount: result.items.filter(item => item.receipt !== null).length,
      providerRejectedCount: result.items.filter(item=>item.receipt?.providerOutcome?.state==="rejected").length,
      outcomeLinksVerified: linksVerified };
  }
  async function observeDecision(raw: unknown, authorization: string | undefined) {
    const relay = bindings.decisionRelay;
    if (!relay) throw new DispatchError("APPROVAL_INGRESS_UNCONFIGURED", 503, "uncertain");
    if (!machineBearer(authorization, relay.token)) throw new DispatchError("UNAUTHENTICATED", 401, "uncertain");
    const locator = slackDecisionLocatorSchema.parse(raw);
    const admission = limits.admit("machine-relay:" + relay.ingressRef, "write");
    if (!admission.admitted) throw new DispatchError("RATE_LIMITED", 429, "uncertain", admission.retryAfterMs);
    const result = await approvals.observeDecision(locator, { ingressRef: relay.ingressRef });
    if (result.outbox.some(box => box.kind === "decision" && (box.state === "uncertain" || box.state === "attempted")))
      throw new DispatchError("OUTCOME_UNCERTAIN", 502, "uncertain");
    return { schemaVersion: "farda.decision-observation.v1", approvalRef: result.manifest.approvalRef,
      state: result.current.state, sourceEffect: "none", executionCertainty: "applied", approvedIsSent: false };
  }
  async function execute(raw: unknown, principalRef: string) {
    const principal = { principalRef };
    const domain = domainActionSchema.safeParse(raw);
    if (domain.success) return service.executeDomain(domain.data, principal);
    return service.execute(foundationActionSchema.parse(raw), principal);
  }
  async function readReadiness(principalRef: string) {
    if (!bindings.readinessTargetRef) throw new DispatchError("READINESS_SOURCE_UNCONFIGURED", 503);
    return domains.readReadiness(bindings.readinessTargetRef, { principalRef });
  }
  return { approvals, dispatch, service, domains, limits, execute, readReadiness, authenticateMachine, executeWorker, observeDecision,
    authenticateReporting, executeReporting, readOperationalAlertDeliveries, reporting, weeklySnapshots };
}
