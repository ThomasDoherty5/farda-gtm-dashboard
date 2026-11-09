import type { DatabaseSync } from "node:sqlite";
import { approvalScopeSchema, principalSchema, approvalRefSchema, type ApprovalPrincipal, type ApprovalScope } from "../approvals/contract.ts";
import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { invitationDraftSchema, invitationSaveSchema, invitationSaveReceiptSchema, type InvitationDraft, type InvitationSaveReceipt } from "./contract.ts";
import { RecruitmentError } from "./source.ts";

export type InvitationBasis = {
  provider: "social-cat" | "tiktok"; providerAccountRef: string; providerAccountVersion: string;
  sourceRef: string; sourceVersion: string; offerManifestHash: string;
  creatorRef: string; creatorId: string;
  productRef: string; productVersion: string; programRef: string; templateRef: string; templateVersion: string; claimsVersion: string;
};
export type StoredInvitationDraft = { ownerPrincipalRef: string; basis: InvitationBasis; draft: InvitationDraft };

/** Immutable app configuration revisions only. Offers, J04 and jobs retain their existing ownership. */
export class InvitationDraftRepository {
  private readonly db: DatabaseSync;
  private readonly scope: ApprovalScope;
  private readonly now: () => number;
  constructor(db: DatabaseSync, scope: ApprovalScope, now: () => number = Date.now) {
    this.db = db; this.scope = approvalScopeSchema.parse(structuredClone(scope)); this.now = now;
    const bound = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (bound?.workspace_id !== scope.workspaceId || bound?.account_id !== scope.accountId)
      throw new RecruitmentError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS recruitment_invitation_drafts (draft_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(draft_id,revision));
      CREATE TABLE IF NOT EXISTS recruitment_invitation_saves (request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,draft_id TEXT NOT NULL,principal_ref TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recruitment_invitation_approval_refs (payload_digest TEXT PRIMARY KEY,approval_ref TEXT NOT NULL,manifest_version INTEGER NOT NULL);`);
  }
  readStored(id: string, principal: ApprovalPrincipal, version?: string): StoredInvitationDraft | null {
    const revision = version === undefined ? null : /^invitation-v([1-9]\d*)$/.exec(version)?.[1];
    if (version !== undefined && (!revision || !Number.isSafeInteger(Number(revision)))) throw new RecruitmentError("RECRUITMENT_DRAFT_VERSION_INVALID",422);
    const row = revision === null
      ? this.db.prepare("SELECT body FROM recruitment_invitation_drafts WHERE draft_id=? ORDER BY revision DESC LIMIT 1").get(id)
      : this.db.prepare("SELECT body FROM recruitment_invitation_drafts WHERE draft_id=? AND revision=?").get(id, Number(revision));
    if (!row) return null;
    const value = JSON.parse(String(row.body)) as StoredInvitationDraft;
    if (value.ownerPrincipalRef !== principalSchema.parse(principal).principalRef) throw new RecruitmentError("RECRUITMENT_DRAFT_OWNER_DENIED", 403);
    invitationDraftSchema.parse(value.draft);
    if(value.draft.payloadDigest!==digest({scope:this.scope,terms:value.draft.terms,basis:value.basis}))throw new RecruitmentError("RECRUITMENT_DRAFT_INTEGRITY_INVALID");
    return value;
  }
  read(id: string, principal: ApprovalPrincipal): InvitationDraft | null { return this.readStored(id, principal)?.draft ?? null; }
  approvalBinding(payloadDigest: string): {approvalRef:string;manifestVersion:number} | null {
    const row=this.db.prepare("SELECT approval_ref,manifest_version FROM recruitment_invitation_approval_refs WHERE payload_digest=?").get(payloadDigest);
    if(!row)return null;
    const manifestVersion=Number(row.manifest_version);
    if(!Number.isSafeInteger(manifestVersion)||manifestVersion<1)throw new RecruitmentError("RECRUITMENT_PREVIEW_BINDING_INVALID");
    return {approvalRef:approvalRefSchema.parse(row.approval_ref),manifestVersion};
  }
  approvalRef(payloadDigest: string): string | null { return this.approvalBinding(payloadDigest)?.approvalRef??null; }
  /** Runs inside the existing J04 final transaction. This is immutable identity binding, not approval state. */
  bindApproval(payloadDigest: string, approvalRef: string, manifestVersion: number): void {
    const row=this.db.prepare("SELECT approval_ref,manifest_version FROM recruitment_invitation_approval_refs WHERE payload_digest=?").get(payloadDigest);
    if(row && (row.approval_ref!==approvalRef || row.manifest_version!==manifestVersion))
      throw new RecruitmentError("RECRUITMENT_PREVIEW_ALREADY_RECORDED");
    this.db.prepare("INSERT OR IGNORE INTO recruitment_invitation_approval_refs VALUES(?,?,?)").run(payloadDigest,approvalRef,manifestVersion);
  }
  private key(principal: ApprovalPrincipal, key: string) { return digest([this.scope, principalSchema.parse(principal).principalRef, approvalRefSchema.parse(key)]); }
  lookup(id: string, principal: ApprovalPrincipal, key: string): InvitationSaveReceipt | null {
    const row = this.db.prepare("SELECT * FROM recruitment_invitation_saves WHERE request_key=?").get(this.key(principal, key));
    if (!row) return null;
    if (row.draft_id !== id || row.principal_ref !== principal.principalRef) throw new RecruitmentError("IDEMPOTENCY_KEY_REUSED");
    const receipt=invitationSaveReceiptSchema.parse(JSON.parse(String(row.receipt)));
    if(receipt.payloadDigest!==row.request_hash||digest(receipt.scope)!==digest(this.scope)||receipt.resourceRef!==id||receipt.requestKey!==key)
      throw new RecruitmentError("RECRUITMENT_RECEIPT_INTEGRITY_INVALID");
    return receipt;
  }
  exact(input: unknown, principal: ApprovalPrincipal, key: string): InvitationSaveReceipt | null {
    const request = invitationSaveSchema.parse(input), result = this.lookup(request.draftId, principal, key);
    if (!result) return null;
    const row = this.db.prepare("SELECT request_hash FROM recruitment_invitation_saves WHERE request_key=?").get(this.key(principal, key));
    if (row?.request_hash !== digest(request)) throw new RecruitmentError("IDEMPOTENCY_KEY_REUSED");
    return result;
  }
  save(input: unknown, principal: ApprovalPrincipal, actorRef: string, key: string, basis: InvitationBasis, assertCurrent: () => void): InvitationSaveReceipt {
    const request = invitationSaveSchema.parse(structuredClone(input)), bound = structuredClone(basis);
    principal = principalSchema.parse(structuredClone(principal)); approvalRefSchema.parse(actorRef);
    const stamp = this.now(); if (!Number.isSafeInteger(stamp)) throw new RecruitmentError("INVALID_CLOCK", 500);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertSynchronousVoid(assertCurrent);
      const prior = this.exact(request, principal, key);
      if (prior) { this.db.exec("COMMIT"); return prior; }
      const current = this.readStored(request.draftId, principal);
      if ((current?.draft.version ?? null) !== request.expectedVersion)
        throw new RecruitmentError("STALE_VERSION", 409, "notApplied", current?.draft.version);
      const revision = current ? Number(current.draft.version.slice("invitation-v".length)) + 1 : 1;
      if (!Number.isSafeInteger(revision)) throw new RecruitmentError("RECRUITMENT_REVISION_LIMIT", 409);
      const draft = invitationDraftSchema.parse({ draftId: request.draftId, version: `invitation-v${revision}`, recordedAt: new Date(stamp).toISOString(), actorRef,
        terms: request.terms, payloadDigest: digest({ scope: this.scope, terms: request.terms, basis: bound }), sourceEffect: "none" });
      const receipt = invitationSaveReceiptSchema.parse({ resourceRef: request.draftId, version: draft.version, resource: draft, updatedAt: draft.recordedAt,
        scope:this.scope,expectedVersion:request.expectedVersion,actorRef,
        requestKey: key, payloadDigest: digest(request), sourceEffect: "none" });
      assertSynchronousVoid(assertCurrent);
      this.db.prepare("INSERT INTO recruitment_invitation_drafts VALUES(?,?,?)").run(request.draftId, revision, JSON.stringify({ ownerPrincipalRef: principal.principalRef, basis: bound, draft }));
      this.db.prepare("INSERT INTO recruitment_invitation_saves VALUES(?,?,?,?,?)").run(this.key(principal, key), digest(request), request.draftId, principal.principalRef, JSON.stringify(receipt));
      this.db.exec("COMMIT"); return receipt;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
