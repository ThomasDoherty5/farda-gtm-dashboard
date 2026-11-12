import { evaluateTerms, routeCreatorReply } from "../../adapter/commissionPolicy.ts";
import { digest } from "../config.ts";
import { isTimezone, REMINDER_LEAD_DAYS, type ClosureEvidence, type ClosureReason, type FollowUpConfig, type FollowUpStep,
  type OutreachState, type PostingClockEvent, type TermsInput } from "./contract.ts";
import type { ReviewState } from "./reviewMachine.ts";
import { evaluatePaidReuse } from "./rightsGate.ts";

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

type Position = { kind: "voluntary" } | { kind: "invalid"; reasonCodes: string[] } |
  { kind: "dated"; offset: number; due: number; graceDays: number; dueVersion: string; localDay: string; timezone: string };
/**
 * Where today falls against the posting deadline, in the configured timezone. Anything missing or
 * conflicting is invalid; nothing is filled in from configuration.
 */
function postingPosition(event: PostingClockEvent | null, config: FollowUpConfig, now: number): Position {
  const invalid = (code: string): Position => ({ kind: "invalid", reasonCodes: [code] });
  if (!event) return invalid("POSTING_CLOCK_MISSING");
  if (event.posting === "voluntary") return { kind: "voluntary" };
  if (event.posting !== "committed") return invalid("POSTING_OBLIGATION_UNVERIFIED");
  if (event.dueDate === null) return invalid("POSTING_DEADLINE_MISSING");
  if (event.graceDays === null) return invalid("POSTING_GRACE_MISSING");
  if (event.timezone === null) return invalid("POSTING_TIMEZONE_MISSING");
  if (!isTimezone(event.timezone) || event.timezone !== config.timezone) return invalid("POSTING_TIMEZONE_CONFLICT");
  if (Date.parse(event.observedAt) > now) return invalid("POSTING_CLOCK_FROM_FUTURE");
  const timezone = config.timezone, today = localDay(now, timezone), due = dayNumber(event.dueDate);
  return { kind: "dated", offset: dayNumber(today) - due, due, graceDays: event.graceDays, timezone, localDay: today,
    dueVersion: dueVersionOf(event.dueDate, event.graceDays, timezone) };
}

export type ReminderDecision =
  | { kind: "refused"; reasonCodes: string[] }
  | { kind: "wait"; reasonCodes: string[]; dueVersion: string; localDay: string; timezone: string; opensOn: string }
  | { kind: "remind"; step: "due-minus-2" | "within-grace"; reasonCodes: string[]; dueVersion: string; localDay: string; timezone: string }
  | { kind: "escalate"; step: "past-grace"; suggestedClosure: "expired"; reminder: "post-grace" | null; reasonCodes: string[]; dueVersion: string; localDay: string; timezone: string }
  | { kind: "humanReview"; reasonCodes: string[] }
  | { kind: "notApplicable"; reasonCodes: string[]; suggestedClosure: ClosureReason | null };

export type ReminderInput = {
  event: PostingClockEvent | null;
  outreach: OutreachState;
  postedVerified: boolean;
  closure: ClosureReason | null;
  /** An earlier creator message that is in flight, unreconciled or in conflict. */
  priorSend: "none" | "inFlight" | "uncertain" | "conflict";
};
const PRIOR_SEND_HOLD = { inFlight: "PRIOR_SEND_IN_FLIGHT", uncertain: "PRIOR_SEND_UNCERTAIN", conflict: "OUTCOME_CONFLICT_OPEN" } as const;

/**
 * Pure reminder branching on the posting deadline in the configured timezone. Refuses to decide until a
 * reminder policy is configured. A missing or conflicting date, grace or timezone goes to human review.
 */
export function decideReminder(input: ReminderInput, config: FollowUpConfig, now: number): ReminderDecision {
  if (!config.reminderPolicy) return { kind: "refused", reasonCodes: ["REMINDER_POLICY_UNSET"] };
  if (!Number.isFinite(now)) return { kind: "humanReview", reasonCodes: ["CLOCK_INVALID"] };
  if (input.closure) return { kind: "notApplicable", reasonCodes: ["FOLLOW_UP_CLOSED"], suggestedClosure: null };
  if (input.postedVerified) return { kind: "notApplicable", reasonCodes: ["POSTED_VERIFIED"], suggestedClosure: "posted-verified" };
  const position = postingPosition(input.event, config, now);
  if (position.kind === "voluntary") return { kind: "notApplicable", reasonCodes: ["POSTING_VOLUNTARY"], suggestedClosure: null };
  if (position.kind === "invalid") return { kind: "humanReview", reasonCodes: position.reasonCodes };
  const { offset, due, graceDays, dueVersion, localDay: today, timezone } = position, base = { dueVersion, localDay: today, timezone };
  // Creator messages need clear outreach eligibility and no earlier send in flight, unreconciled or in conflict.
  const hold = input.outreach !== "clear" ? (input.outreach === "suppressed" ? "OUTREACH_SUPPRESSED" : "SUPPRESSION_UNVERIFIED")
    : input.priorSend !== "none" ? PRIOR_SEND_HOLD[input.priorSend] : null;
  if (offset > graceDays) {
    const reminder = config.reminderPolicy === "postGraceOnly" && !hold ? "post-grace" as const : null;
    return { kind: "escalate", step: "past-grace", suggestedClosure: "expired", reminder,
      reasonCodes: ["POSTING_GRACE_ELAPSED", ...(config.reminderPolicy === "postGraceOnly" && hold ? [hold] : [])], ...base };
  }
  if (config.reminderPolicy === "postGraceOnly")
    return { kind: "wait", reasonCodes: ["REMINDER_POLICY_POST_GRACE_ONLY"], opensOn: dayString(due + graceDays + 1), ...base };
  if (offset < -REMINDER_LEAD_DAYS) return { kind: "wait", reasonCodes: ["REMINDER_NOT_YET_DUE"], opensOn: dayString(due - REMINDER_LEAD_DAYS), ...base };
  if (hold) return { kind: "humanReview", reasonCodes: [hold] };
  return offset <= 0
    ? { kind: "remind", step: "due-minus-2", reasonCodes: ["POSTING_DUE_SOON"], ...base }
    : { kind: "remind", step: "within-grace", reasonCodes: ["POSTING_WITHIN_GRACE"], ...base };
}

/** A fee or other paid term is a terms mismatch for a person to review. Nothing is ever auto-accepted. */
export type TermsReview = { state: "termsMismatch" | "noMismatchFound"; queue: "humanReview" | "none"; autoAccept: false; reasonCodes: string[]; sourceRef: string };
export function reviewCreatorTerms(input: TermsInput): TermsReview {
  const codes = input.kind === "reply"
    ? routeCreatorReply(input.text, input.sourceRef).reasonCodes
    : (blockers => blockers.length ? ["TERMS_MISMATCH", ...blockers] : [])(evaluateTerms(input.terms).blockers.map(b => b.code as string));
  return codes.length
    ? { state: "termsMismatch", queue: "humanReview", autoAccept: false, reasonCodes: codes, sourceRef: input.sourceRef }
    : { state: "noMismatchFound", queue: "none", autoAccept: false, reasonCodes: [], sourceRef: input.sourceRef };
}

export type ClosureDecision = { state: "closable"; reason: ClosureReason; evidenceRef: string; reasonCodes: string[] } | { state: "refused"; reasonCodes: string[] };
const DEFINITE_UNAVAILABLE = ["missing", "expired", "revoked"];

/** Each reason needs its own evidence. Terms and rights are recomputed here rather than accepted as verdicts. */
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
      const position = postingPosition(evidence.event, context.config, context.now);
      if (position.kind !== "dated") return refuse(position.kind === "invalid" ? position.reasonCodes[0]! : "POSTING_VOLUNTARY");
      if (position.offset <= position.graceDays) return refuse("POSTING_GRACE_NOT_ELAPSED");
      return { state: "closable", reason: "expired", evidenceRef: evidence.event.sourceRef, reasonCodes: ["POSTING_GRACE_ELAPSED"] };
    }
    case "terms-mismatch": {
      const terms = reviewCreatorTerms(evidence.terms);
      if (terms.state !== "termsMismatch") return refuse("TERMS_MISMATCH_UNVERIFIED");
      return { state: "closable", reason: "terms-mismatch", evidenceRef: terms.sourceRef, reasonCodes: terms.reasonCodes };
    }
    case "rights-unavailable": {
      if (evidence.rights.use.kind !== "paid_ad") return refuse("PAID_REUSE_ONLY");
      const gate = evaluatePaidReuse(evidence.rights, context.now, context.config.rightsWarningDays);
      // Unknown or stale rights are not a definite unavailability.
      if (gate.paidReuse !== "blocked" || !DEFINITE_UNAVAILABLE.includes(gate.rightsStatus)) return refuse("RIGHTS_UNAVAILABILITY_UNVERIFIED");
      return { state: "closable", reason: "rights-unavailable", evidenceRef: evidence.sourceRef, reasonCodes: gate.reasonCodes };
    }
    case "declined":
    case "cancelled":
      return { state: "closable", reason: evidence.reason, evidenceRef: evidence.sourceRef, reasonCodes: [evidence.reason === "declined" ? "CREATOR_DECLINED" : "COLLABORATION_CANCELLED"] };
  }
}
