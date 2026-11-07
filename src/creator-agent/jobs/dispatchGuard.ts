import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import type { CapabilityLedger } from "../connections/ledger.ts";
import type { ApprovalScope, VerifiedApprovalProof } from "../approvals/contract.ts";
import { approvalRefSchema } from "../approvals/contract.ts";
import { JobRepository } from "./repository.ts";
import { dispatchIntentSchema, dispatchReadbackSchema, grantSchema, providerRequirementSchema, resourceRequirementsSchema, DispatchError, type DispatchIntent, type DispatchHandler, type DispatchRead, type DispatchReceipt, type DispatchApprovalAuthority, type ResourceAuthority, type ResourceGrant, type ResourceRequirements, type DispatchReadback, type DispatchContext, type DispatchWorker } from "./dispatchSchema.ts";
export type DispatchGuardOptions = {
    db: DatabaseSync;
    jobs: JobRepository;
    scope: ApprovalScope;
    approvals: DispatchApprovalAuthority;
    ledger?: Pick<CapabilityLedger, "requireReady">;
    resourceAuthority?: ResourceAuthority;
    handlers: ReadonlyMap<string, DispatchHandler>;
    now?: () => number;
};
type Stored = {
    intent: DispatchIntent;
    dispatchKey: string;
    handlerHash: string;
    runRef: string;
    receipt: DispatchReceipt | null;
};
type Preflight = {
    proof: VerifiedApprovalProof;
    grants: ResourceGrant[];
    requirements: ResourceRequirements;
    handler: DispatchHandler;
    providerBindingHash: string;
};
export class DispatchGuard {
    private options: DispatchGuardOptions;
    private db: DatabaseSync;
    private jobs: JobRepository;
    private now: () => number;
    constructor(options: DispatchGuardOptions) {
        this.options = options;
        this.db = options.db;
        this.jobs = options.jobs;
        this.now = options.now ?? Date.now;
        const scope = this.db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
        if (scope?.workspace_id !== options.scope.workspaceId || scope.account_id !== options.scope.accountId || options.scope.environment !== "sandbox")
            throw new DispatchError("DISPATCH_SCOPE_DENIED", 403);
        this.db.exec(`CREATE TABLE IF NOT EXISTS job_dispatch_intents(dispatch_key TEXT PRIMARY KEY,run_ref TEXT NOT NULL,intent TEXT NOT NULL,handler_hash TEXT NOT NULL,receipt TEXT);
 CREATE TABLE IF NOT EXISTS job_dispatch_requests(request_key TEXT PRIMARY KEY,body_hash TEXT NOT NULL,run_ref TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_dispatch_grants(grant_key TEXT PRIMARY KEY,dispatch_key TEXT NOT NULL,body_hash TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_dispatch_attempts(dispatch_key TEXT NOT NULL,attempt INTEGER NOT NULL,started_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(dispatch_key,attempt));
 CREATE TABLE IF NOT EXISTS job_dispatch_effect_fences(fence_key TEXT PRIMARY KEY,dispatch_key TEXT NOT NULL,basis TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_dispatch_controls(request_key TEXT PRIMARY KEY,body_hash TEXT NOT NULL,run_ref TEXT NOT NULL,receipt TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_dispatch_readbacks(dispatch_key TEXT NOT NULL,receipt_ref TEXT NOT NULL,body_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(dispatch_key,receipt_ref));`);
    }
    private handler(intent: DispatchIntent) {
        const handler = this.options.handlers.get(intent.handlerRef);
        if (!handler)
            throw new DispatchError("SOURCE_ACTION_UNSUPPORTED");
        if (handler.policyVersion !== intent.approval.policyVersion)
            throw new DispatchError("DISPATCH_POLICY_STALE");
        if (handler.idempotency !== "source-enforced")
            throw new DispatchError("DISPATCH_IDEMPOTENCY_UNSUPPORTED");
        if (intent.approval.phase === "mediaStageRelease" && (handler.sourceEffect !== "localArtifact" || handler.provider.state !== "notApplicable"))
            throw new DispatchError("MEDIA_STAGE_LOCAL_HANDLER_REQUIRED");
        if (intent.approval.phase === "mediaSafetyPause" && (handler.sourceEffect !== "providerApplied" || handler.provider.state !== "required"))
            throw new DispatchError("MEDIA_SAFETY_NATIVE_HANDLER_REQUIRED");
        providerRequirementSchema.parse(handler.provider);
        if (handler.provider.state === "required" && (handler.sourceEffect !== "providerApplied" || handler.provider.binding.mode !== "executeApproved" || digest({ workspaceId: handler.provider.binding.workspaceId, accountId: handler.provider.binding.accountId, environment: handler.provider.binding.environment }) !== digest(this.options.scope) || handler.provider.binding.providerAccountId !== intent.approval.providerAccountRef || handler.provider.binding.action !== intent.approval.actionKind))
            throw new DispatchError("DISPATCH_PROVIDER_BINDING_MISMATCH");
        if (handler.provider.state === "notApplicable" && (handler.sourceEffect !== "localArtifact" || handler.provider.policyVersion !== handler.policyVersion))
            throw new DispatchError("DISPATCH_PROVIDER_AUTHORITY_UNKNOWN");
        return handler;
    }
    private handlerHash(intent: DispatchIntent, handler = this.handler(intent)) { return digest({ policy: handler.policyVersion, idempotency: handler.idempotency, sourceEffect: handler.sourceEffect, provider: handler.provider, reconcileBinding: handler.reconcileBinding ?? null, resources: resourceRequirementsSchema.parse(handler.resources(intent)), budgets: handler.budgets }); }
    private storedAll(runRef: string): Stored[] { const rows = this.db.prepare("SELECT d.* FROM job_dispatch_intents d JOIN job_items i ON i.item_key=d.dispatch_key JOIN job_run_items r ON r.item_id=i.item_id WHERE r.run_id=? ORDER BY i.item_key").all(runRef); if (!rows.length)
        throw new DispatchError("DISPATCH_NOT_FOUND", 404); return rows.map(row => ({ intent: dispatchIntentSchema.parse(JSON.parse(String(row.intent))), dispatchKey: String(row.dispatch_key), handlerHash: String(row.handler_hash), runRef, receipt: row.receipt ? JSON.parse(String(row.receipt)) as DispatchReceipt : null })); }
    private stored(runRef: string, key?: string): Stored { const rows = this.storedAll(runRef); const result = key ? rows.find(s => s.dispatchKey === key) : rows[0]; if (!result)
        throw new DispatchError("DISPATCH_NOT_FOUND", 404); return result; }
    private revision(runRef: string) { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM job_transitions WHERE run_id=?").get(runRef)?.n ?? 0); }
    read(runRef: string, recoverExpired = true): DispatchRead { if (recoverExpired)
        this.jobs.recoverExpired(); const all = this.storedAll(runRef), s = all[0]!, run = this.jobs.getRun(runRef); const pending = run.items.some(item => item.state !== "completed" && Boolean(this.db.prepare("SELECT dispatch_started FROM job_items WHERE item_id=?").get(item.itemId)?.dispatch_started)); return { schemaVersion: "farda.dispatch.v1", runRef, revision: this.revision(runRef), intent: s.intent, dispatchKey: s.dispatchKey, run, items: all.map(({ intent, dispatchKey, receipt }) => ({ intent, dispatchKey, receipt })), receipt: all.length === 1 ? s.receipt : null, current: { state: run.state === "completed" ? "completed" : run.state === "reconcile" ? "uncertain" : run.state === "running" ? "running" : run.control === "cancelled" ? "cancelled" : run.state === "queued" ? "ready" : "held", reasonCodes: run.blockerCodes }, executionCertainty: pending ? "uncertain" : all.some(item => item.receipt) ? "applied" : "notApplied" }; }
    private capability(handler: DispatchHandler, reconcile = false) { if (handler.provider.state === "notApplicable")
        return; const binding = reconcile ? handler.reconcileBinding : handler.provider.binding; if (!binding)
        throw new DispatchError("SOURCE_RECONCILIATION_CAPABILITY_UNAVAILABLE"); if (reconcile && (binding.mode !== "reconcile" || binding.provider !== handler.provider.binding.provider || binding.providerAccountId !== handler.provider.binding.providerAccountId || binding.workspaceId !== this.options.scope.workspaceId || binding.accountId !== this.options.scope.accountId || binding.environment !== this.options.scope.environment))
        throw new DispatchError("DISPATCH_RECONCILIATION_BINDING_MISMATCH"); const ready = this.options.ledger?.requireReady(binding); if (!ready?.allowed || ready.state !== "Ready" || !ready.expiresAt || Date.parse(ready.expiresAt) <= this.now())
        throw new DispatchError(ready?.reasonCodes[0] ?? "SOURCE_CAPABILITY_UNAVAILABLE", ready?.state === "Denied" ? 403 : 409); }
    private validateGrants(s: Stored, requirements: ResourceRequirements, grants: ResourceGrant[]) {
        if (this.handler(s.intent).sourceEffect === "providerApplied" && requirements.quota.state !== "required")
            throw new DispatchError("DISPATCH_SHARED_QUOTA_REQUIRED");
        if (grants.length > 3)
            throw new DispatchError("DISPATCH_RESOURCE_PROOF_INVALID");
        for (const dimension of ["budget", "stock", "quota"] as const) {
            const need = requirements[dimension], matching = grants.filter(g => g.dimension === dimension);
            if (need.state === "notApplicable") {
                if (need.policyVersion !== s.intent.approval.policyVersion || matching.length)
                    throw new DispatchError("DISPATCH_RESOURCE_POLICY_MISMATCH");
                continue;
            }
            const grant = matching[0];
            if (matching.length !== 1 || !grant || digest(grant.scope) !== digest(this.options.scope) || grant.dispatchKey !== s.dispatchKey || grant.resourceRef !== need.resourceRef || grant.quantity !== need.quantity || grant.unit !== need.unit || grant.currency !== need.currency || Date.parse(grant.observedAt) > this.now() || Date.parse(grant.validUntil) <= this.now())
                throw new DispatchError(`DISPATCH_${dimension.toUpperCase()}_UNVERIFIED`);
            if (dimension === "quota") {
                const q = grant.quotaBasis;
                if (!q || q.allocatedTotal < grant.quantity || q.allocatedTotal > q.operatingLimit || BigInt(q.operatingLimit) * 5n > BigInt(q.publishedLimit) * 4n || Date.parse(q.windowStart) > this.now() || Date.parse(q.windowEnd) <= this.now() || Date.parse(grant.validUntil) > Date.parse(q.windowEnd))
                    throw new DispatchError("DISPATCH_SHARED_QUOTA_UNVERIFIED");
            }
            else if (grant.quotaBasis)
                throw new DispatchError("DISPATCH_RESOURCE_PROOF_INVALID");
        }
    }
    private assert(s: Stored, p: Preflight) { if (this.handlerHash(s.intent) !== s.handlerHash)
        throw new DispatchError("DISPATCH_HANDLER_CHANGED"); if (digest(p.proof.binding) !== digest(s.intent.approval))
        throw new DispatchError("DISPATCH_APPROVAL_BINDING_MISMATCH"); this.options.approvals.assertCurrentProof(p.proof, this.now()); this.capability(p.handler); this.validateGrants(s, p.requirements, p.grants); const budget = p.requirements.budget, stock = p.requirements.stock; if(p.proof.item.spendMinor>0&&budget.state!=="required")throw new DispatchError("DISPATCH_BUDGET_REQUIRED");if(p.proof.item.units>0&&stock.state!=="required")throw new DispatchError("DISPATCH_STOCK_REQUIRED"); if (budget.state === "required" && (budget.quantity !== p.proof.item.spendMinor || budget.currency !== p.proof.decisionReceipt.bounds.currency))
        throw new DispatchError("DISPATCH_ITEM_SPEND_BOUND"); if (stock.state === "required" && stock.quantity !== p.proof.item.units)
        throw new DispatchError("DISPATCH_ITEM_UNIT_BOUND"); if (p.grants.length)
        this.options.resourceAuthority!.assertCurrent(p.grants, { intent: s.intent, dispatchKey: s.dispatchKey, requirements: p.requirements }, this.now()); }
    private async preflight(s: Stored): Promise<Preflight> { try {
        return await this.preflightCurrent(s);
    }
    catch (error) {
        if (error instanceof DispatchError)
            throw error;
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : "SOURCE_UNAVAILABLE";
        throw new DispatchError(code, code === "SOURCE_SCOPE_DENIED" ? 403 : 503);
    } }
    private async preflightCurrent(s: Stored): Promise<Preflight> {
        const handler = this.handler(s.intent);
        if (this.handlerHash(s.intent, handler) !== s.handlerHash)
            throw new DispatchError("DISPATCH_HANDLER_CHANGED");
        const approval = await this.options.approvals.resolveCurrentProof(s.intent.approval);
        if (approval.state !== "verified")
            throw new DispatchError(approval.reasonCodes[0] ?? "DISPATCH_APPROVAL_HELD");
        const requirements = resourceRequirementsSchema.parse(handler.resources(s.intent));
        const requires = Object.values(requirements).some(r => r.state === "required");
        if (requires && !this.options.resourceAuthority)
            throw new DispatchError("DISPATCH_RESOURCE_AUTHORITY_UNAVAILABLE");
        const grants = requires ? (await this.options.resourceAuthority!.resolveGrants({ intent: s.intent, dispatchKey: s.dispatchKey, requirements })).map(g => grantSchema.parse(g)) : [];
        const p = { proof: approval.proof, grants, requirements, handler, providerBindingHash: digest(handler.provider) };
        this.assert(s, p);
        return p;
    }
    lookupHandoff(inputs: unknown[], request: {
        principalRef: string;
        idempotencyKey: string;
    }): DispatchRead | null { if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100)
        throw new DispatchError("DISPATCH_BATCH_BOUND"); approvalRefSchema.parse(request.principalRef); approvalRefSchema.parse(request.idempotencyKey); const intents = inputs.map(i => dispatchIntentSchema.parse(i)).sort((a, b) => a.approval.itemRef.localeCompare(b.approval.itemRef)); if (intents.some(i => digest(i.approval.scope) !== digest(this.options.scope)))
        throw new DispatchError("DISPATCH_SCOPE_DENIED", 403); const requestKey = digest({ scope: this.options.scope, actor: request.principalRef, key: request.idempotencyKey, action: intents[0]!.approval.actionKind }); const prior = this.db.prepare("SELECT * FROM job_dispatch_requests WHERE request_key=?").get(requestKey); if (!prior)
        return null; if (prior.body_hash !== digest(intents))
        throw new DispatchError("DISPATCH_IDEMPOTENCY_KEY_REUSED"); return this.read(String(prior.run_ref), false); }
    async handoff(input: unknown, request: {
        principalRef: string;
        idempotencyKey: string;
    }): Promise<DispatchRead> { return this.handoffBatch([input], request); }
    async handoffBatch(inputs: unknown[], request: {
        principalRef: string;
        idempotencyKey: string;
    }): Promise<DispatchRead> {
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100)
            throw new DispatchError("DISPATCH_BATCH_BOUND");
        const intents = inputs.map(i => dispatchIntentSchema.parse(i)).sort((a, b) => a.approval.itemRef.localeCompare(b.approval.itemRef));
        approvalRefSchema.parse(request.principalRef);
        approvalRefSchema.parse(request.idempotencyKey);
        const first = intents[0]!;
        const group = (i: DispatchIntent) => ({ scope: i.approval.scope, approvalRef: i.approval.approvalRef, manifestVersion: i.approval.manifestVersion, manifestHash: i.approval.manifestHash, actionKind: i.approval.actionKind, providerAccountRef: i.approval.providerAccountRef, policyVersion: i.approval.policyVersion, handlerRef: i.handlerRef, phase: i.approval.phase, termsVersion: i.approval.termsVersion, rightsVersion: i.approval.rightsVersion });
        if (intents.some(i => digest(i.approval.scope) !== digest(this.options.scope)))
            throw new DispatchError("DISPATCH_SCOPE_DENIED", 403);
        if (new Set(intents.map(i => i.approval.itemRef)).size !== intents.length || intents.some(i => digest(group(i)) !== digest(group(first))))
            throw new DispatchError("DISPATCH_MIXED_MANIFEST_OR_BINDING");
        const requestKey = digest({ scope: this.options.scope, actor: request.principalRef, key: request.idempotencyKey, action: first.approval.actionKind }), hash = digest(intents);
        const prior = this.db.prepare("SELECT * FROM job_dispatch_requests WHERE request_key=?").get(requestKey);
        if (prior) {
            if (prior.body_hash !== hash)
                throw new DispatchError("DISPATCH_IDEMPOTENCY_KEY_REUSED");
            return this.read(String(prior.run_ref));
        }
        const keyed = intents.map(intent => { const dispatchKey = `dispatch:${digest({ scope: this.options.scope, approvalRef: intent.approval.approvalRef, manifestHash: intent.approval.manifestHash, itemRef: intent.approval.itemRef, itemHash: intent.approval.itemHash, action: intent.approval.actionKind })}`; const existing = this.db.prepare("SELECT intent FROM job_dispatch_intents WHERE dispatch_key=?").get(dispatchKey); if (existing && digest(JSON.parse(String(existing.intent))) !== digest(intent))
            throw new DispatchError("DISPATCH_ITEM_REUSED"); return { intent, dispatchKey, handlerHash: this.handlerHash(intent) }; });
        const handler = this.handler(first), jobId = `approved:${digest(group(first))}`, eventId = `dispatch-batch:${digest(keyed.map(i => i.dispatchKey))}`;
        for (const item of keyed) {
            const old = this.db.prepare("SELECT run_ref FROM job_dispatch_intents WHERE dispatch_key=?").get(item.dispatchKey);
            if (old && this.jobs.getRun(String(old.run_ref)).eventId !== eventId)
                throw new DispatchError("DISPATCH_ITEM_ALREADY_IN_RUN");
        }
        this.jobs.register({ jobId, version: 1, ownerRef: first.approval.approvalRef, mode: "executeApproved", handler: "dispatch-approved.v1", eventType: "approved-manifest-item.v1", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-dispatch-result.v1", policyVersion: first.approval.policyVersion, modelVersion: null, offerVersion: null, capabilityBinding: handler.provider.state === "required" ? handler.provider.binding : null, budgets: handler.budgets }, 0);
        const run = this.jobs.ingest({ schemaVersion: "job-reference-batch.v1", jobId, jobVersion: 1, eventId, eventType: "approved-manifest-item.v1", eventAt: null, items: keyed.map(({ intent, dispatchKey }) => ({ itemKey: dispatchKey, subjectRef: intent.approval.itemRef, evidenceRef: intent.payloadRef })) }, `dispatch-ingress:${digest(eventId)}`, runId=>{ for (const item of keyed) {
            this.db.prepare("INSERT OR IGNORE INTO job_dispatch_intents VALUES(?,?,?,?,NULL)").run(item.dispatchKey, runId, JSON.stringify(item.intent), item.handlerHash);
            const current = this.stored(runId, item.dispatchKey);
            if (digest(current.intent) !== digest(item.intent) || current.handlerHash !== item.handlerHash)
                throw new DispatchError("DISPATCH_ITEM_REUSED");
        } this.db.prepare("INSERT OR IGNORE INTO job_dispatch_requests VALUES(?,?,?)").run(requestKey, hash, runId); const saved = this.db.prepare("SELECT body_hash FROM job_dispatch_requests WHERE request_key=?").get(requestKey); if (saved?.body_hash !== hash)
            throw new DispatchError("DISPATCH_IDEMPOTENCY_KEY_REUSED"); });
        return this.read(run.runId);
    }
    private consume(s: Stored, p: Preflight) { this.assert(s, p); for (const grant of p.grants) {
        const key = digest({ issuer: grant.issuerRef, grantRef: grant.grantRef, dimension: grant.dimension, scope: grant.scope });
        const prior = this.db.prepare("SELECT dispatch_key,body_hash FROM job_dispatch_grants WHERE grant_key=?").get(key);
        if (prior && prior.dispatch_key !== s.dispatchKey)
            throw new DispatchError("DISPATCH_GRANT_ALREADY_CLAIMED");
        const identity = { ...grant, observedAt: undefined, validUntil: undefined, allocationVersion: undefined, quotaBasis: undefined };
        const grantHash = digest(identity);
        if (prior && prior.body_hash !== grantHash)
            throw new DispatchError("DISPATCH_GRANT_IDENTITY_CHANGED");
        this.db.prepare("INSERT OR IGNORE INTO job_dispatch_grants VALUES(?,?,?,?)").run(key, s.dispatchKey, grantHash, JSON.stringify(grant));
    } }
    private fenceKey(s: Stored, p: Preflight) { return digest({ scope: this.options.scope, provider: p.handler.provider.state === "required" ? p.handler.provider.binding.provider : "localArtifact", account: s.intent.approval.providerAccountRef, action: s.intent.approval.actionKind, target: p.proof.item.targetRef }); }
    private attempt(s:Stored):{attemptRef:string;attemptNumber:number}{const row=this.db.prepare("SELECT attempt,body FROM job_dispatch_attempts WHERE dispatch_key=? ORDER BY attempt DESC LIMIT 1").get(s.dispatchKey);if(!row)throw new DispatchError("DISPATCH_ATTEMPT_UNVERIFIED",409,"uncertain");const body=JSON.parse(String(row.body)) as Record<string,unknown>;if(typeof body.attemptRef!=="string"||body.attemptNumber!==row.attempt||!Number.isSafeInteger(body.attemptNumber))throw new DispatchError("DISPATCH_ATTEMPT_UNVERIFIED",409,"uncertain");return{attemptRef:body.attemptRef,attemptNumber:Number(body.attemptNumber)};}
    private assertReadbackAttempt(s:Stored,result:Extract<DispatchReadback,{state:"notApplied"}>){const current=this.attempt(s);if(result.attemptRef!==current.attemptRef||result.attemptNumber!==current.attemptNumber)throw new DispatchError("DISPATCH_CLOSURE_ATTEMPT_MISMATCH",409,"uncertain");}
    private context(s: Stored, p: Preflight, claim: {
        item: {
            itemId: string;
        };
        leaseToken: string;
    }, worker?:DispatchWorker): DispatchContext {
        let retained = p;
        const assertCurrent = () => {worker?.assertCurrent();this.jobs.assertApprovedLease(claim.item.itemId,claim.leaseToken);this.assert(s,retained);};
        return { ...this.attempt(s),intent:structuredClone(s.intent),dispatchKey:s.dispatchKey,providerBindingHash:p.providerBindingHash,
            assertCurrent,
            resourceGrants:()=>{assertCurrent();return structuredClone(retained.grants);},
            approvalProof:()=>{assertCurrent();return structuredClone(retained.proof);},
            heartbeat:async()=>{worker?.assertCurrent();const fresh=await this.preflight(s);const until=this.jobs.heartbeatApproved(claim.item.itemId,claim.leaseToken,Math.min(Date.parse(fresh.proof.validUntil),...fresh.grants.map(g=>Date.parse(g.validUntil))),()=>{worker?.assertCurrent();this.assert(s,fresh);});retained=fresh;return until;}
        };
    }
    private checkReadback(s: Stored, handler: DispatchHandler, input: unknown): DispatchReadback { const result = dispatchReadbackSchema.parse(input); if (result.state === "unknown")
        return result; if(result.state==="notApplied")this.assertReadbackAttempt(s,result);const started = Number(this.db.prepare("SELECT MAX(started_at) AS at FROM job_dispatch_attempts WHERE dispatch_key=?").get(s.dispatchKey)?.at); const receipt = result.state === "applied" ? result.receipt : result; if (receipt.dispatchKey !== s.dispatchKey || receipt.payloadHash !== s.intent.approval.payloadHash || receipt.handlerRef !== s.intent.handlerRef || receipt.providerBindingHash !== digest(handler.provider) || (Date.parse(receipt.observedAt) > this.now() || Date.parse(receipt.observedAt) < started) || (result.state === "applied" && result.receipt.sourceEffect !== handler.sourceEffect))
        throw new DispatchError("DISPATCH_RECEIPT_BINDING_MISMATCH", 409, "uncertain"); return result; }
    private record(s: Stored, result: Extract<DispatchReadback, {
        state: "applied";
    }>) { const receipt = result.receipt; this.jobs.finishApproved(s.runRef, s.dispatchKey, { schemaVersion: "job-dispatch-result.v1", kind: "dispatch-receipt", receiptRef: receipt.receiptRef, requestKey: s.dispatchKey, payloadHash: receipt.payloadHash, sourceEffect: receipt.sourceEffect, observedAt: receipt.observedAt }, () => { const current = this.stored(s.runRef, s.dispatchKey); if (current.receipt && digest(current.receipt) !== digest(receipt))
        throw new DispatchError("DISPATCH_RECEIPT_CONFLICT", 409, "applied"); this.db.prepare("UPDATE job_dispatch_intents SET receipt=? WHERE dispatch_key=?").run(JSON.stringify(receipt), s.dispatchKey); this.db.prepare("DELETE FROM job_dispatch_effect_fences WHERE dispatch_key=?").run(s.dispatchKey); }); }
    async execute(runRef: string,worker?:DispatchWorker): Promise<DispatchRead> { if(worker)approvalRefSchema.parse(worker.workerRef);worker?.assertCurrent();for (const s of this.storedAll(runRef)) {
        await this.executeItem(s,worker);
    } return this.read(runRef); }
    private async executeItem(s: Stored,worker?:DispatchWorker): Promise<void> {
        const runRef = s.runRef, view = this.read(runRef), item = view.run.items.find(i => i.itemKey === s.dispatchKey)!;
        if (s.receipt || view.run.control !== "active" || ["leased", "completed", "reconcile", "cancelled", "failed"].includes(item.state))
            return;
        const p = await this.preflight(s);
        this.jobs.activateApproved(view.run.jobId, 1, p.proof.decisionReceipt.receiptRef, () => {worker?.assertCurrent();this.assert(s, p);});
        const claim = this.jobs.claimApproved(runRef, worker?.workerRef??"worker:approved-dispatch", s.dispatchKey, () => {worker?.assertCurrent();this.consume(s, p);});
        if (!claim)
            return;
        this.jobs.startApproved(claim.item.itemId, claim.leaseToken, () => { worker?.assertCurrent();this.assert(s, p); const fence = this.fenceKey(s, p); const prior = this.db.prepare("SELECT dispatch_key FROM job_dispatch_effect_fences WHERE fence_key=?").get(fence); if (prior && prior.dispatch_key !== s.dispatchKey)
            throw new DispatchError("DISPATCH_PRIOR_OUTCOME_UNCERTAIN"); this.db.prepare("INSERT OR IGNORE INTO job_dispatch_effect_fences VALUES(?,?,?)").run(fence, s.dispatchKey, JSON.stringify({ targetRef: p.proof.item.targetRef, providerBindingHash: p.providerBindingHash })); this.db.prepare("INSERT INTO job_dispatch_attempts VALUES(?,?,?,?)").run(s.dispatchKey, claim.item.attempts, this.now(), JSON.stringify({attemptRef:`dispatch-attempt:${digest({dispatchKey:s.dispatchKey,attemptNumber:claim.item.attempts})}`,attemptNumber:claim.item.attempts, approval: p.proof.verificationRef, grants: p.grants.map(g => g.grantRef), providerBindingHash: p.providerBindingHash })); });
        try {
            const result = this.checkReadback(s, p.handler, await p.handler.execute(this.context(s, p, claim,worker)));
            if (result.state === "applied")
                this.record(s, result);
            else
                this.jobs.finishApproved(runRef, s.dispatchKey, null, () => { }, result.state === "unknown" ? result.reasonCode : "DISPATCH_NOT_APPLIED_RECONCILE");
            this.capability(p.handler);worker?.assertCurrent();
        }
        catch (error) {
            if (this.jobs.getRun(runRef).items.find(i => i.itemKey === s.dispatchKey)?.state !== "completed")
                this.jobs.finishApproved(runRef, s.dispatchKey, null, () => { }, error instanceof DispatchError ? error.code : "SOURCE_OUTCOME_UNCERTAIN");
            if (error instanceof DispatchError)
                throw new DispatchError(error.code, error.status, this.stored(runRef, s.dispatchKey).receipt ? "applied" : "uncertain", error.retryAfterMs);
            throw new DispatchError("SOURCE_OUTCOME_UNCERTAIN", 503, this.stored(runRef, s.dispatchKey).receipt ? "applied" : "uncertain");
        }
    }
    async reconcile(runRef: string): Promise<DispatchRead> { try {
        return await this.reconcileCurrent(runRef);
    }
    catch (error) {
        if (error instanceof DispatchError)
            throw new DispatchError(error.code, error.status, this.read(runRef).executionCertainty, error.retryAfterMs);
        throw new DispatchError("SOURCE_RECONCILIATION_UNAVAILABLE", 503, this.read(runRef).executionCertainty);
    } }
    private async reconcileCurrent(runRef: string): Promise<DispatchRead> { for (const s of this.storedAll(runRef))
        await this.reconcileItem(s); return this.read(runRef); }
    private async reconcileItem(s: Stored): Promise<void> {
        const runRef = s.runRef;
        const view = this.read(runRef);
        const item = view.run.items.find(i => i.itemKey === s.dispatchKey)!;
        if (s.receipt || !this.db.prepare("SELECT dispatch_started FROM job_items WHERE item_id=?").get(item.itemId)?.dispatch_started)
            return;
        const handler = this.handler(s.intent);
        this.capability(handler, true);
        const dummy = { handler, providerBindingHash: digest(handler.provider) };
        const result = this.checkReadback(s, handler, await handler.reconcile({ ...this.attempt(s),intent: structuredClone(s.intent), dispatchKey: s.dispatchKey, providerBindingHash: dummy.providerBindingHash }));
        if (result.state === "applied")
            this.record(s, result);
        else if (result.state === "notApplied") {
            if (Date.parse(result.validUntil) <= this.now())
                throw new DispatchError("DISPATCH_READBACK_STALE", 409, "uncertain");
            if (this.jobs.getRun(runRef).items.find(i => i.itemKey === s.dispatchKey)?.state === "leased")
                return;
            this.jobs.closeApprovedAttempt(runRef, s.dispatchKey, result.attemptNumber, () => { this.assertReadbackAttempt(s,result);this.capability(handler, true); if (Date.parse(result.validUntil) <= this.now())
                throw new DispatchError("DISPATCH_READBACK_STALE", 409, "uncertain"); const old = this.db.prepare("SELECT body_hash FROM job_dispatch_readbacks WHERE dispatch_key=? AND receipt_ref=?").get(s.dispatchKey, result.receiptRef); if (old && old.body_hash !== digest(result))
                throw new DispatchError("DISPATCH_RECEIPT_REUSED", 409, "uncertain"); this.db.prepare("INSERT OR IGNORE INTO job_dispatch_readbacks VALUES(?,?,?,?)").run(s.dispatchKey, result.receiptRef, digest(result), JSON.stringify(result)); this.db.prepare("DELETE FROM job_dispatch_effect_fences WHERE dispatch_key=?").run(s.dispatchKey); });
        }
        this.capability(handler, true);
    }
    verifyOutcome(input: {
        approvalRef: string;
        manifestVersion: number;
        manifestHash: string;
        itemRef: string;
        runRef: string;
        outcomeRef: string;
    }): boolean { try {
        const found = this.storedAll(input.runRef).find(s => s.intent.approval.itemRef === input.itemRef);
        return Boolean(found?.receipt && found.receipt.receiptRef === input.outcomeRef && found.intent.approval.approvalRef === input.approvalRef && found.intent.approval.manifestVersion === input.manifestVersion && found.intent.approval.manifestHash === input.manifestHash && this.jobs.getRun(input.runRef).items.some(i => i.itemKey === found.dispatchKey && i.state === "completed" && i.result?.schemaVersion === "job-dispatch-result.v1" && i.result.receiptRef === input.outcomeRef));
    }
    catch {
        return false;
    } }
    lookupControl(runRef: string, expectedRevision: number, command: "pause" | "resume" | "cancel", request: {
        principalRef: string;
        idempotencyKey: string;
    }): DispatchRead | null { approvalRefSchema.parse(request.principalRef); approvalRefSchema.parse(request.idempotencyKey); const requestKey = digest({ scope: this.options.scope, actor: request.principalRef, key: request.idempotencyKey, operation: "dispatch-control" }); const old = this.db.prepare("SELECT * FROM job_dispatch_controls WHERE request_key=?").get(requestKey); if (!old)
        return null; if (old.body_hash !== digest({ runRef, expectedRevision, command }))
        throw new DispatchError("DISPATCH_IDEMPOTENCY_KEY_REUSED"); return { ...this.read(runRef, false), controlReceipt: JSON.parse(String(old.receipt)) as NonNullable<DispatchRead["controlReceipt"]> }; }
    control(runRef: string, expectedRevision: number, command: "pause" | "resume" | "cancel", request?: {
        principalRef: string;
        idempotencyKey: string;
    }): DispatchRead {
        this.stored(runRef);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
            throw new DispatchError("DISPATCH_VERSION_CONFLICT");
        if (request) {
            approvalRefSchema.parse(request.principalRef);
            approvalRefSchema.parse(request.idempotencyKey);
        }
        const requestKey = request ? digest({ scope: this.options.scope, actor: request.principalRef, key: request.idempotencyKey, operation: "dispatch-control" }) : null;
        const bodyHash = digest({ runRef, expectedRevision, command });
        const prior = () => requestKey ? this.db.prepare("SELECT * FROM job_dispatch_controls WHERE request_key=?").get(requestKey) : undefined;
        const validatePrior = () => { const old = prior(); if (old && old.body_hash !== bodyHash)
            throw new DispatchError("DISPATCH_IDEMPOTENCY_KEY_REUSED"); return old; };
        const existing = validatePrior();
        if (!existing)
            this.jobs.controlRun(runRef, command, () => { if (validatePrior())
                return false; if (expectedRevision !== this.revision(runRef))
                throw new DispatchError("DISPATCH_VERSION_CONFLICT"); }, () => { if (request && requestKey) {
                const receipt = { requestKey: request.idempotencyKey, principalRef: request.principalRef, command, expectedRevision, appliedRevision: this.revision(runRef) };
                this.db.prepare("INSERT INTO job_dispatch_controls VALUES(?,?,?,?)").run(requestKey, bodyHash, runRef, JSON.stringify(receipt));
            } });
        const saved = validatePrior();
        return { ...this.read(runRef), ...(saved ? { controlReceipt: JSON.parse(String(saved.receipt)) as NonNullable<DispatchRead["controlReceipt"]> } : {}) };
    }
}
