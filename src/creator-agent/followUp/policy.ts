import { evaluateTerms, routeCreatorReply, type UntrustedTerms } from "../../adapter/commissionPolicy.ts";
import { digest } from "../config.ts";
import { isTimezone, REMINDER_LEAD_DAYS, type ClosureReason, type DeliveryEvidence, type FollowUpConfig, type FollowUpStep,
  type OutreachState, type PostingClockEvent } from "./contract.ts";
import type { ReviewState } from "./reviewMachine.ts";
import type { RightsGateResult } from "./rightsGate.ts";

const DAY_MS = 86_400_000;

/** The calendar day at an instant in a timezone, as YYYY-MM-DD. */
export function localDay(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const field = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}
const dayNumber = (value: string) => Math.round(Date.parse(value + "T00:00:00Z") / DAY_MS);
const dayString = (value: number) => new Date(value * DAY_MS).toISOString().slice(0, 10);

/** A changed due date, grace or timezone is a new due-date version. The source revision alone is not. */
export function dueVersionOf(dueDate: string, graceDays: number, timezone: string): string {
  return "due1-" + digest([dueDate, graceDays, timezone]).slice(0, 40);
}
/** One reminder per collaboration, step and due-date version. */
export function dedupeKeyOf(collaborationId: string, step: FollowUpStep, dueVersion: string): string {
  return digest(["creator-follow-up", collaborationId, step, dueVersion]);
}

export type ReminderDecision =
  | { kind: "wait"; reasonCodes: string[]; dueVersion: string; localDay: string; timezone: string; opensOn: string }
  | { kind: "remind"; step: "due-minus-2" | "within-grace"; reasonCodes: string[]; dueVersion: string; localDay: string; timezone: string }
  | { kind: "escalate"; step: "past-grace"; suggestedClosure: "expired"; reasonCodes: string[]; dueVersion: string; localDay: string; timezone: string }
  | { kind: "humanReview"; reasonCodes: string[] }
  | { kind: "notApplicable"; reasonCodes: string[]; suggestedClosure: ClosureReason | null };

export type ReminderInput = {
  event: PostingClockEvent | null;
  outreach: OutreachState;
  postedVerified: boolean;
  closure: ClosureReason | null;
  /** A send to this collaboration whose outcome is not yet reconciled. */
  uncertainSend: boolean;
};

/**
 * Pure reminder branching on the posting deadline in the configured timezone. A missing or conflicting
 * date, grace or timezone goes to human review. Nothing here guesses a deadline.
 */
export function decideReminder(input: ReminderInput, config: FollowUpConfig, now: number): ReminderDecision {
  if (!Number.isFinite(now)) return { kind: "humanReview", reasonCodes: ["CLOCK_INVALID"] };
  if (input.closure) return { kind: "notApplicable", reasonCodes: ["FOLLOW_UP_CLOSED"], suggestedClosure: null };
  if (input.postedVerified) return { kind: "notApplicable", reasonCodes: ["POSTED_VERIFIED"], suggestedClosure: "posted-verified" };
  const event = input.event;
  if (!event) return { kind: "humanReview", reasonCodes: ["POSTING_CLOCK_MISSING"] };
  if (event.posting === "voluntary") return { kind: "notApplicable", reasonCodes: ["POSTING_VOLUNTARY"], suggestedClosure: null };
  if (event.posting !== "committed") return { kind: "humanReview", reasonCodes: ["POSTING_OBLIGATION_UNVERIFIED"] };
  if (event.dueDate === null) return { kind: "humanReview", reasonCodes: ["POSTING_DEADLINE_MISSING"] };
  if (event.graceDays === null) return { kind: "humanReview", reasonCodes: ["POSTING_GRACE_MISSING"] };
  if (event.timezone !== null && (!isTimezone(event.timezone) || event.timezone !== config.timezone))
    return { kind: "humanReview", reasonCodes: ["POSTING_TIMEZONE_CONFLICT"] };
  if (Date.parse(event.observedAt) > now) return { kind: "humanReview", reasonCodes: ["POSTING_CLOCK_FROM_FUTURE"] };
  const timezone = config.timezone, today = localDay(now, timezone), due = dayNumber(event.dueDate);
  const dueVersion = dueVersionOf(event.dueDate, event.graceDays, timezone);
  const offset = dayNumber(today) - due;
  const base = { dueVersion, localDay: today, timezone };
  if (offset < -REMINDER_LEAD_DAYS) return { kind: "wait", reasonCodes: ["REMINDER_NOT_YET_DUE"], opensOn: dayString(due - REMINDER_LEAD_DAYS), ...base };
  if (offset > event.graceDays) return { kind: "escalate", step: "past-grace", suggestedClosure: "expired", reasonCodes: ["POSTING_GRACE_ELAPSED"], ...base };
  // Creator messages need clear outreach eligibility and no unreconciled earlier send.
  if (input.outreach !== "clear") return { kind: "humanReview", reasonCodes: [input.outreach === "suppressed" ? "OUTREACH_SUPPRESSED" : "SUPPRESSION_UNVERIFIED"] };
  if (input.uncertainSend) return { kind: "humanReview", reasonCodes: ["PRIOR_SEND_UNCERTAIN"] };
  return offset <= 0
    ? { kind: "remind", step: "due-minus-2", reasonCodes: ["POSTING_DUE_SOON"], ...base }
    : { kind: "remind", step: "within-grace", reasonCodes: ["POSTING_WITHIN_GRACE"], ...base };
}

/** A fee or other paid term is a terms mismatch for a person to review. Nothing is ever auto-accepted. */
export type TermsReview = { state: "termsMismatch" | "noMismatchFound"; queue: "humanReview" | "none"; autoAccept: false; reasonCodes: string[]; sourceRef: string };
export function reviewCreatorTerms(input: { kind: "reply"; text: string; sourceRef: string } | { kind: "terms"; terms: UntrustedTerms; sourceRef: string }): TermsReview {
  if (input.kind === "reply") {
    const route = routeCreatorReply(input.text, input.sourceRef);
    return route.state === "termsMismatch"
      ? { state: "termsMismatch", queue: "humanReview", autoAccept: false, reasonCodes: route.reasonCodes, sourceRef: input.sourceRef }
      : { state: "noMismatchFound", queue: "none", autoAccept: false, reasonCodes: [], sourceRef: input.sourceRef };
  }
  const blockers = evaluateTerms(input.terms).blockers.map(b => b.code);
  return blockers.length
    ? { state: "termsMismatch", queue: "humanReview", autoAccept: false, reasonCodes: ["TERMS_MISMATCH", ...blockers], sourceRef: input.sourceRef }
    : { state: "noMismatchFound", queue: "none", autoAccept: false, reasonCodes: [], sourceRef: input.sourceRef };
}

/** Each closure reason requires its own evidence. */
export type ClosureEvidence =
  | { reason: "posted-verified"; delivery: DeliveryEvidence }
  | { reason: "declined"; sourceRef: string }
  | { reason: "expired"; event: PostingClockEvent }
  | { reason: "terms-mismatch"; terms: TermsReview }
  | { reason: "rights-unavailable"; rights: RightsGateResult; sourceRef: string }
  | { reason: "cancelled"; sourceRef: string };
export type ClosureDecision = { state: "closable"; reason: ClosureReason; evidenceRef: string; reasonCodes: string[] } | { state: "refused"; reasonCodes: string[] };

export function decideClosure(collaborationId: string, evidence: ClosureEvidence,
  context: { review: ReviewState | null; config: FollowUpConfig; now: number }): ClosureDecision {
  const refuse = (code: string): ClosureDecision => ({ state: "refused", reasonCodes: [code] });
  switch (evidence.reason) {
    case "posted-verified": {
      const d = evidence.delivery, p = d.publication;
      if (d.collaborationId !== collaborationId) return refuse("EVIDENCE_COLLABORATION_MISMATCH");
      if (p.state !== "published" || p.visibility !== "visible") return refuse("PUBLICATION_UNVERIFIED");
      // The posted content must be the exact version that was approved.
      const review = context.review;
      if (!review || review.deliverableRef !== d.deliverableRef || review.status !== "approved" || review.currentVersion !== d.contentVersion)
        return refuse("POSTED_VERSION_NOT_APPROVED");
      return { state: "closable", reason: "posted-verified", evidenceRef: p.nativeReceiptRef ?? d.sourceRef, reasonCodes: ["POSTED_VERIFIED"] };
    }
    case "expired": {
      if (evidence.event.collaborationId !== collaborationId) return refuse("EVIDENCE_COLLABORATION_MISMATCH");
      const decision = decideReminder({ event: evidence.event, outreach: "clear", postedVerified: false, closure: null, uncertainSend: false }, context.config, context.now);
      if (decision.kind !== "escalate") return refuse("POSTING_GRACE_NOT_ELAPSED");
      return { state: "closable", reason: "expired", evidenceRef: evidence.event.sourceRef, reasonCodes: ["POSTING_GRACE_ELAPSED"] };
    }
    case "terms-mismatch":
      if (evidence.terms.state !== "termsMismatch") return refuse("TERMS_MISMATCH_UNVERIFIED");
      return { state: "closable", reason: "terms-mismatch", evidenceRef: evidence.terms.sourceRef, reasonCodes: evidence.terms.reasonCodes };
    case "rights-unavailable":
      if (evidence.rights.paidReuse !== "blocked") return refuse("RIGHTS_AVAILABLE");
      return { state: "closable", reason: "rights-unavailable", evidenceRef: evidence.sourceRef, reasonCodes: evidence.rights.reasonCodes };
    case "declined":
    case "cancelled":
      return { state: "closable", reason: evidence.reason, evidenceRef: evidence.sourceRef, reasonCodes: [evidence.reason === "declined" ? "CREATOR_DECLINED" : "COLLABORATION_CANCELLED"] };
  }
}
