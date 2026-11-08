// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import { createActionService } from "./service.ts";
import { createActionReviewService } from "./review.ts";
import { reviewSourceFixture } from "./reviewFixtures.testkit.ts";
import { actionTestSecret as referenceKey } from "./fixtures.testkit.ts";
import { digest } from "../config.ts";
import { ActionServiceError } from "./contract.ts";
import { reviewLinkSchema, runAttemptOutcomeSchema } from "./reviewViews.ts";
import type { ApprovalReviewInput } from "./reviewSource.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";

const databases: ReturnType<typeof approvalFixture>["db"][] = [];
const principal = { principalRef: "synthetic:requester" };
async function setup() {
  const a = approvalFixture(); databases.push(a.db);
  const jobs = new JobRepository(a.db, { scope, now: () => a.state.now });
  const dispatch = new DispatchGuard({ db: a.db, jobs, scope, approvals: a.repo, handlers: new Map(), now: () => a.state.now });
  const service = createActionService({ scope, secret: referenceKey, approvals: a.repo, dispatch, registry: new Map(),
    authorize: a.sources.resolveActor, assertAuthority: a.sources.assertCurrent, now: () => a.state.now });
  const record = await a.requested(), base = await service.readApproval(record.manifest.approvalRef, principal);
  const actor = structuredClone(a.humans.get(principal.principalRef)!);
  const input: ApprovalReviewInput = { base, record, actor, assertCurrent: () => {
    const current = a.humans.get(actor.principalRef);
    if (!current?.active || digest(current) !== digest(actor)) throw new ActionServiceError("AUTHORITY_REQUIRED", 403);
    if (a.repo.readApproval(record.manifest.approvalRef)?.revision !== record.revision) throw new ActionServiceError("REVIEW_MANIFEST_CHANGED");
  } };
  const source = reviewSourceFixture(() => a.state.now);
  const review = createActionReviewService({ scope, referenceKey, source: source.source, permittedLinkOrigins: ["https://review.example.test"], now: () => a.state.now });
  return { ...a, input, source, review, service };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

describe("permission-bound operational review without new release authority", () => {
  it("projects only explicitly granted exact-version fields and permitted source links", async () => {
    const w = await setup(), result = await w.review.decorateApproval(w.input);
    expect(result.review).toMatchObject({ state: "complete", confersAuthority: false, context: { provider: { state: "visible" } }, links: { approval: { state: "available" } } });
    expect(result.review!.items[0]!.itemRef).toBe(result.items[0]!.itemRef);
    expect(JSON.stringify(result.review)).not.toContain("synthetic:provider-account");
    expect(result.current).toEqual(w.input.base.current); expect(result.appDecision.allowed).toBe(false);
  });
  it("keeps unavailable source and withheld/redacted material explicit rather than claiming an exact complete preview", async () => {
    const w = await setup();
    const absent = createActionReviewService({ scope, referenceKey, now: () => w.state.now });
    expect((await absent.decorateApproval(w.input)).review).toMatchObject({ state: "unavailable", items: [{ payload: { state: "unavailable", value: null } }] });
    w.source.state.withheld = true;
    expect((await w.review.decorateApproval(w.input)).review).toMatchObject({ state: "partial", items: [{ payload: { state: "unavailable", value: null } }] });
    w.source.state.withheld = false; w.source.state.redactPayload = true;
    expect((await w.review.decorateApproval(w.input)).review).toMatchObject({ state: "partial", items: [{ payload: { state: "redacted" } }] });
  });
  it.each(["real-person@example.test", "+1 (555) 123-4567", "access_token=secret-private-token"])("withholds accidental private display material: %s", async secret => {
    const w = await setup(); w.source.state.transform = value => { value.items[0]!.payload!.text = secret; return value; };
    const result = await w.review.decorateApproval(w.input);
    expect(result.review!.items[0]!.payload).toMatchObject({ state: "unavailable", value: null, reasonCode: "REVIEW_PRIVATE_MATERIAL_WITHHELD" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(["https://evil.example.test/", "https://user:password@review.example.test/", "https://review.example.test/?token=secret", "javascript:alert(1)"])("does not expose unsafe source link %s", async url => {
    const w = await setup(); w.source.state.transform = value => { value.links[0]!.url = url; return value; };
    expect((await w.review.decorateApproval(w.input)).review!.links.approval).toMatchObject({ state: "unavailable", url: null });
  });
  it("allows the exact permitted Slack thread identifier without treating its timestamp as a contact",async()=>{
    const w=await setup();w.source.state.transform=value=>{value.links[0]!.url="https://review.example.test/archives/C12345678/p1730912345123456?thread_ts=1730912345.123456&cid=C12345678";return value;};
    expect((await w.review.decorateApproval(w.input)).review!.links.approval.state).toBe("available");
  });
  it("rejects a mutated in-memory projection after the source await",async()=>{
    const w=await setup();w.source.state.afterRead=()=>{w.input.base.items[0]!.units=999;};
    await expect(w.review.decorateApproval(w.input)).rejects.toMatchObject({code:"REVIEW_MANIFEST_CHANGED"});
  });
  it.each(["actor", "account", "item", "manifest", "scope", "decision"])("rejects foreign %s binding before returning display values", async field => {
    const w = await setup(); w.source.state.transform = value => {
      if (field === "actor") value.binding.principalRef = "foreign-principal";
      if (field === "account") value.binding.providerAccountRef = "foreign-account";
      if (field === "item") value.items[0]!.targetVersion = "foreign-version";
      if (field === "manifest") value.binding.manifestVersion++;
      if (field === "scope") value.binding.scope = { ...scope, accountId: "foreign-account" };
      if (field === "decision") { value.binding.decisionReceiptRef = "foreign-decision"; value.binding.decisionReceiptHash = "a".repeat(64); }
      return value;
    };
    await expect(w.review.decorateApproval(w.input)).rejects.toMatchObject({ code: "REVIEW_SOURCE_BINDING_INVALID" });
  });
  it.each(["permission", "version", "actor", "lease"])("rechecks backing %s after the final source await", async change => {
    const w = await setup(); w.source.state.afterRead = () => {
      if (change === "permission") w.source.state.permitted = false;
      if (change === "version") w.source.state.version = "synthetic-review-v2";
      if (change === "actor") w.humans.get(principal.principalRef)!.active = false;
      if (change === "lease") w.state.now += 60_001;
    };
    await expect(w.review.decorateApproval(w.input)).rejects.toBeInstanceOf(Error);
  });
  it("rejects missing synchronous source authority and duplicate/foreign projected items", async () => {
    const w = await setup();
    const source = { read: w.source.source.read } as typeof w.source.source;
    await expect(createActionReviewService({ scope, referenceKey, source, now: () => w.state.now }).decorateApproval(w.input)).rejects.toMatchObject({ code: "REVIEW_SOURCE_AUTHORITY_UNAVAILABLE" });
    w.input.base.items.push(w.input.base.items[0]!);
    await expect(w.review.decorateApproval(w.input)).rejects.toMatchObject({ code: "REVIEW_MANIFEST_CHANGED" });
  });
  it.each(["source","record"])("rejects async %s assertions rather than returning protected fields before their denial",async owner=>{
    const w=await setup();
    if(owner==="source"){
      const backing=w.source.source.assertCurrent;
      w.source.source.assertCurrent=async(...args)=>{await Promise.resolve();backing(...args);};
      w.source.state.afterRead=()=>{w.source.state.permitted=false;};
    }else w.input.assertCurrent=async()=>{await Promise.resolve();throw new ActionServiceError("AUTHORITY_REQUIRED",403);};
    await expect(w.review.decorateApproval(w.input)).rejects.toMatchObject({code:"REVIEW_SOURCE_AUTHORITY_UNAVAILABLE",status:403});
    await Promise.resolve();
  });
  it("validates browser links and exact terminal attempt evidence independently", () => {
    expect(reviewLinkSchema.safeParse({ state: "available", url: "javascript:alert(1)", label: "Open" }).success).toBe(false);
    expect(runAttemptOutcomeSchema.safeParse({ state: "closedNotApplied", attemptNumber: null, receiptRef: null, observedAt: null }).success).toBe(false);
    expect(runAttemptOutcomeSchema.safeParse({ state: "open", attemptNumber: 1, receiptRef: null, observedAt: null }).success).toBe(true);
  });
  it("limits browser display lifetime to the named actor lease as well as source permission", async () => {
    const w=await setup(); w.input.actor.validUntil=new Date(w.state.now+1000).toISOString();
    w.humans.set(principal.principalRef,structuredClone(w.input.actor));
    expect((await w.review.decorateApproval(w.input)).review!.validUntil).toBe(w.input.actor.validUntil);
  });
});

describe("actual immutable approval version history", () => {
  it("paginates exact stored versions and keeps earlier payloads after restart", async () => {
    const w = await setup(), first = structuredClone(w.input.record);
    w.draft.payloadHash = digest("changed synthetic payload"); w.draft.items[0]!.payloadHash = w.draft.payloadHash;
    const next = await w.repo.preparePreview({ ...w.command, approvalRef: first.manifest.approvalRef, expectedVersion: 1 }, principal, "synthetic-next-version");
    const restarted = new ApprovalRepository(w.db, w.options), page = restarted.readHistory(first.manifest.approvalRef, { limit: 1 })!;
    expect(page).toMatchObject({ total: 2, latestVersion: 2, nextBeforeVersion: 2 });
    expect(page.records[0]!.manifest.manifestHash).toBe(next.manifest.manifestHash);
    const old = restarted.readHistory(first.manifest.approvalRef, { limit: 1, beforeVersion: page.nextBeforeVersion! })!;
    expect(old.records[0]!.manifest).toEqual(first.manifest); expect(old.nextBeforeVersion).toBeNull();
    expect(restarted.readApproval(first.manifest.approvalRef, 99)).toBeNull();
    expect(restarted.readHistory("foreign-missing")).toBeNull();
  });
  it("rejects invalid bounds, does not synthesize absent versions, and projects real historical decisions", async () => {
    const w = await setup(), event = w.event(w.input.record, "rejected", "synthetic:founder");
    const decided = await w.repo.observeDecision(event.locator, { ingressRef: "synthetic-ingress" });
    w.input.record = decided; w.input.base = await w.service.readApproval(decided.manifest.approvalRef, principal);
    w.input.assertCurrent = () => {};
    w.input.history = { ...w.repo.readHistory(decided.manifest.approvalRef)!, mode: "history" };
    const result = await w.review.decorateApproval(w.input);
    expect(result.history).toMatchObject({ mode: "history", totalVersions: 1, selectedVersion: 1, selectedDecisions: [{ decision: "rejected" }], confersAuthority: false });
    for (const limit of [0, 26, Infinity, 1.5]) expect(() => w.repo.readHistory(decided.manifest.approvalRef, { limit })).toThrow("INVALID_APPROVAL_HISTORY_WINDOW");
    expect(w.repo.readHistory(decided.manifest.approvalRef, { beforeVersion: 1 })!.records).toEqual([]);
  });
});

describe("exact run job facts with separately authoritative attempt proof",()=>{
  it("uses actual SQLite job state and treats a missing attempt projection as unknown without losing the receipt",async()=>{
    const a=approvalFixture();databases.push(a.db);
    a.draft.actionKind="synthetic-local-review";a.command.actionKind=a.draft.actionKind;a.draft.phase="other";a.draft.acquisitionTerms=null;a.draft.effects.sendsCreator=false;
    const record=await a.approved(),na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional local artifact has no provider, money or inventory effect."};
    const handler:DispatchHandler={idempotency:"source-enforced",sourceEffect:"localArtifact",policyVersion:a.policy.version,provider:na,
      resources:()=>({budget:na,stock:na,quota:na}),budgets:{maxItems:1,maxSteps:20,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},
      execute:async c=>({state:"applied",receipt:{receiptRef:"synthetic:exact-local-receipt",dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}}),
      reconcile:async()=>({state:"unknown",reasonCode:"SYNTHETIC_NO_READBACK"})};
    const jobs=new JobRepository(a.db,{scope,now:()=>a.state.now}),dispatch=new DispatchGuard({db:a.db,jobs,scope,approvals:a.repo,handlers:new Map([["synthetic-review-handler",handler]]),now:()=>a.state.now});
    const intent={approval:approvalDispatchBinding(record.manifest,record.manifest.items[0]!.itemRef),handlerRef:"synthetic-review-handler",payloadRef:record.manifest.draft.payloadRef};
    const handoff=await dispatch.handoff(intent,{...principal,idempotencyKey:"synthetic-review-handoff"});await dispatch.execute(handoff.runRef);
    const service=createActionService({scope,secret:referenceKey,approvals:a.repo,dispatch,registry:new Map([[a.draft.actionKind,{handlerRef:"synthetic-review-handler"}]]),authorize:a.sources.resolveActor,assertAuthority:a.sources.assertCurrent,now:()=>a.state.now});
    const base=await service.readRun(handoff.runRef,principal),run=dispatch.read(handoff.runRef),actor=a.humans.get(principal.principalRef)!;
    const fixture=reviewSourceFixture(()=>a.state.now),review=createActionReviewService({scope,referenceKey,source:fixture.source,now:()=>a.state.now});
    const input={base,record:a.repo.readApproval(record.manifest.approvalRef)!,dispatch:run,actor,assertCurrent:()=>{
      if(dispatch.read(handoff.runRef).revision!==run.revision)throw new ActionServiceError("REVIEW_RUN_CHANGED");
    }};
    const value=await review.decorateRun(input);
    expect(value.items[0]).toMatchObject({receiptRef:base.items[0]!.receiptRef,execution:{state:"completed",attempts:1,attemptOutcome:{state:"unknown"},recovery:{kind:"login"}}});
    const exact=await review.decorateRun({...input,attemptOutcomes:new Map([[run.dispatchKey,{state:"applied" as const,attemptNumber:1,receiptRef:"synthetic:attempt-proof",observedAt:a.at()}]])});
    expect(exact.items[0]!.execution!.attemptOutcome).toMatchObject({state:"applied",attemptNumber:1});
    expect(exact.items[0]!.execution!.attemptOutcome.receiptRef).toMatch(/^attempt-outcome-/);
    fixture.state.afterRead=()=>{dispatch.control(handoff.runRef,run.revision,"pause");};
    await expect(review.decorateRun(input)).rejects.toThrow("REVIEW_RUN_CHANGED");
  });
});
