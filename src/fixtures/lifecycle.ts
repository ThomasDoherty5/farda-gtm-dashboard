/**
 * Synthetic customer-lifecycle data (Figma 5:289, 5:404, 11:372, 11:498, 11:624, 11:750, 11:852).
 * Every figure is an illustrative aggregate: no contact record, consent record, send or provider exists behind it.
 * Percentages are derived from the counts at render time and never stored, so they can't drift from them.
 */
import type { BadgeTone } from "@/components/Badge";

export const FLOW_KEYS = ["setup", "early-access", "abandoned-checkout", "review-request"] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];

/** Customer lifecycle (5:289). */
export type LifecycleData = {
  context: { badge: string; text: string };
  metrics: { label: string; value: number; context: string; definition: string }[];
  flows: { key: FlowKey; name: string; entryExit: string; gate: string; state: string }[];
  activation: { paired: number; weekOne: number };
  returnsAwaitingInspection: number;
  closeLoop: string;
  closeLoopNote: string;
  sources: string;
};

export const lifecycleDemo: LifecycleData = {
  context: { badge: "Setup required", text: "Email platform selection is open · all figures below are illustrative aggregates" },
  metrics: [
    { label: "Consented early access", value: 428, context: "Channel consent checked at send time", definition: "Subscribers whose current email consent the provider confirms at send time. An aggregate count; no contact record is copied here." },
    { label: "Recovered checkouts", value: 24, context: "Attributed by the email platform", definition: "Checkouts that completed after a recovery reminder, as attributed by the email platform. The dashboard doesn't attribute them itself." },
    { label: "Paired devices", value: 86, context: "Anonymous activation count", definition: "Devices paired, counted anonymously. Pairing doesn't prove data ingestion or any health outcome." },
    { label: "Reviews received", value: 19, context: "Aggregate review outcome", definition: "Reviews received after a review request: platform, rating and source date only, with no review text." },
  ],
  flows: [
    { key: "early-access", name: "Early access", entryExit: "Opt in → welcome → launch notice → exit", gate: "Active email consent; exit on opt-out", state: "Setup required" },
    { key: "abandoned-checkout", name: "Abandoned cart", entryExit: "Checkout started → delay → reminder → exit", gate: "Exit on purchase, opt-out or suppression", state: "Setup required" },
    { key: "setup", name: "Setup help", entryExit: "Order delivered → delay → setup help → exit", gate: "Current consent; one send per eligible order", state: "View flow →" },
    { key: "review-request", name: "Review request", entryExit: "Delivered + delay → request → review or exit", gate: "Suppress unresolved issues and opt-outs", state: "Setup required" },
  ],
  activation: { paired: 86, weekOne: 64 },
  returnsAwaitingInspection: 2,
  closeLoop: "Support opened → assigned → resolved → outcome confirmed. Returns continue through received → inspected → refund or replacement confirmed.",
  closeLoopNote: "Review requests pause for unresolved issues. Retention beyond the four specified flows is a proposed scope extension.",
  sources: "Sources: THO-174, THO-189, THO-197, THO-198 · proposed suppression and return closure requirements are called out in the handoff.",
};

/** One email flow's configuration (5:404, 11:372, 11:498, 11:624). */
export type FlowStep = { n: string; title: string; note: string; kind: string; hold?: boolean };

export type EmailFlowData = {
  key: FlowKey;
  title: string;
  subtitle: string;
  context: { badge: string; text: string };
  steps: FlowStep[];
  /** Setup help only (5:404). */
  neverSendWhen: string[];
  nextOutcomes: [string, string][];
  eligibilityNote: string;
  changes: { action: string; review: string; result: string }[];
  /** The other three flows (11:372, 11:498, 11:624). */
  entryEvent: { value: string; help: string };
  timing: { value: string; help: string };
  template: { value: string; help: string };
  /** The versioned draft. Saving it never enables or publishes the flow. */
  draft: { timing: string; template: string };
  draftVersion: string;
  /** Synthetic template content for the preview. It can't be sent. */
  preview: { subject: string; body: string[] };
  tests: { title: string; result: string }[];
  footnote: string;
};

const STOP_POLICIES = ["Recheck consent before send", "Stop on opt-out or suppression", "Prevent duplicate enrollment"] as const;
export const mandatoryPolicies = STOP_POLICIES;

const tests = [
  { title: "Eligible test", result: "Sends once" },
  { title: "Unsubscribed test", result: "Suppressed" },
  { title: "Duplicate event", result: "Ignored" },
  { title: "Provider outage", result: "Held for review" },
];
const draftContext = { badge: "Configuration draft", text: "Provider not selected · editable design state · no live flow enabled" };
const draftFootnote = "Design data only · THO-174 and THO-189 · draft settings do not change the email provider.";

export const emailFlows: Record<FlowKey, EmailFlowData> = {
  setup: {
    key: "setup",
    title: "Setup help, with a clean exit.",
    subtitle: "A single eligible message after delivery, followed by anonymous activation measurement.",
    context: { badge: "Flow paused", text: "Provider setup pending · proposed execution model · sample configuration" },
    steps: [
      { n: "01", title: "Order delivered", note: "Zapier receives an authoritative delivery event; dedupe by order.", kind: "Trigger" },
      { n: "02", title: "Wait 24 hours", note: "Sample timing; final owner-approved timing remains configurable.", kind: "Delay" },
      { n: "03", title: "Check current eligibility", note: "Provider checks consent, suppression, prior send and refund state.", kind: "Gate" },
      { n: "04", title: "Send the approved setup template", note: "The email provider sends; browser agent configures and audits.", kind: "Action" },
      { n: "05", title: "Observe delivery outcome", note: "Delivered, bounced, unsubscribed or failed; no contact data copied.", kind: "Result" },
      { n: "06", title: "Exit and measure setup", note: "Aggregate anonymous paired / active-week-one counts only.", kind: "Exit" },
    ],
    neverSendWhen: ["Consent is missing or withdrawn", "Contact is suppressed or bounced", "The order was refunded or canceled", "This flow already sent for the order", "Required data is stale or unavailable"],
    nextOutcomes: [["Eligible", "Queue once"], ["Suppressed", "Skip + record reason"], ["Missing data", "Hold + notify owner"], ["Provider error", "Review before retry"]],
    eligibilityNote: "Consent is rechecked immediately before send. Each customer communication stays in the owning provider.",
    changes: [
      { action: "Edit timing or template", review: "Owner reviews a new version before enabling", result: "Versioned configuration; existing runs retain their version" },
      { action: "Pause flow", review: "Stops new enrollments and unsent scheduled work", result: "Paused badge and queue counts" },
      { action: "Enable flow", review: "Provider connected; consent checks and sandbox run pass", result: "Enabled with owner and activation timestamp" },
      { action: "Recover failure", review: "Check provider message result and deduplication key", result: "Confirmed outcome, or held for manual resolution" },
    ],
    entryEvent: { value: "Order delivered", help: "Owned by the selected email provider" },
    timing: { value: "24 hours after delivery", help: "Sample timing; owner approval required" },
    template: { value: "Setup help", help: "Versioned and approved before enabling" },
    draft: { timing: "24 hours after delivery", template: "Setup help" },
    draftVersion: "v1",
    preview: { subject: "Getting started with your device", body: ["Hi {{first_name}},", "Your order {{order_number}} was delivered. Here is a short guide to pairing your device.", "You're receiving this because you chose to hear from us. Unsubscribe any time."] },
    tests: [],
    footnote: "Timing and suppression refinements are design proposals. No live automation or provider configuration has been changed.",
  },
  "early-access": {
    key: "early-access",
    title: "A welcome that leads to launch.",
    subtitle: "Confirm consent, send a welcome, and wait for an approved launch date.",
    context: draftContext,
    steps: [
      { n: "01", title: "Confirm channel consent", note: "The provider verifies the current email permission and source.", kind: "Gate" },
      { n: "02", title: "Send the welcome once", note: "Use the approved template and dedupe this subscriber enrollment.", kind: "Action" },
      { n: "03", title: "Wait for the approved launch date", note: "L is not set. Launch notices remain paused until founder sign-off.", kind: "Hold", hold: true },
      { n: "04", title: "Recheck consent and suppression", note: "Exit for opt-out, bounce, deletion, purchase or ineligible audience.", kind: "Gate" },
      { n: "05", title: "Send launch-day early access", note: "Zapier schedules the approved segment in the provider.", kind: "Action" },
      { n: "06", title: "Exit and attribute", note: "Track aggregate eligible, delivered, click and purchase outcomes.", kind: "Exit" },
    ],
    neverSendWhen: [],
    nextOutcomes: [],
    eligibilityNote: "",
    changes: [],
    entryEvent: { value: "Confirmed email subscription", help: "Owned by the selected email provider" },
    timing: { value: "Welcome: on opt-in", help: "Launch notice waits for L to be approved" },
    template: { value: "Welcome + early-access invitation", help: "Versioned and approved before enabling" },
    draft: { timing: "Welcome: on opt-in", template: "Welcome + early-access invitation" },
    draftVersion: "v1",
    preview: { subject: "Welcome to Farda early access", body: ["Hi {{first_name}},", "Thanks for joining early access. We'll tell you when launch day is confirmed.", "You can unsubscribe any time: {{unsubscribe_link}}"] },
    tests,
    footnote: draftFootnote,
  },
  "abandoned-checkout": {
    key: "abandoned-checkout",
    title: "Recover intent, without over-sending.",
    subtitle: "An unfinished checkout enters only while its consent and purchase state remain eligible.",
    context: draftContext,
    steps: [
      { n: "01", title: "Receive checkout event", note: "Use the provider-owned checkout ID; do not copy customer details.", kind: "Trigger" },
      { n: "02", title: "Wait the configured delay", note: "The demo uses 4 hours. A completed purchase cancels pending work.", kind: "Delay" },
      { n: "03", title: "Reconcile purchase and permission", note: "Check conversion, consent, suppression and previous reminder.", kind: "Gate" },
      { n: "04", title: "Send one approved reminder", note: "Browser agent may configure the flow; provider performs email delivery.", kind: "Action" },
      { n: "05", title: "Observe delivery or suppression", note: "Record aggregate delivered, bounced, suppressed and failed counts.", kind: "Result" },
      { n: "06", title: "Exit on purchase or stop condition", note: "A completed purchase must not receive another recovery message.", kind: "Exit" },
    ],
    neverSendWhen: [],
    nextOutcomes: [],
    eligibilityNote: "",
    changes: [],
    entryEvent: { value: "Eligible checkout abandoned", help: "Owned by the selected email provider" },
    timing: { value: "4 hours after checkout", help: "Proposed delay; owner approval required" },
    template: { value: "One checkout reminder", help: "Versioned and approved before enabling" },
    draft: { timing: "4 hours after checkout", template: "One checkout reminder" },
    draftVersion: "v1",
    preview: { subject: "You left something in your cart", body: ["Hi {{first_name}},", "Your checkout {{checkout_id}} is still open. This is the only reminder we'll send.", "Unsubscribe any time: {{unsubscribe_link}}"] },
    tests,
    footnote: draftFootnote,
  },
  "review-request": {
    key: "review-request",
    title: "Ask after the product arrives.",
    subtitle: "A review request around 14 days after delivery, with unresolved issues held for follow-up.",
    context: draftContext,
    steps: [
      { n: "01", title: "Confirm delivery", note: "Use the authoritative delivered event and source order ID.", kind: "Trigger" },
      { n: "02", title: "Wait approximately 14 days", note: "Timing follows THO-189; no assumed date before delivery.", kind: "Delay" },
      { n: "03", title: "Check eligibility and service status", note: "Hold unresolved support or returns; exclude suppressed contacts.", kind: "Gate" },
      { n: "04", title: "Send the neutral review request", note: "No promised outcome, incentive requirement or rating steering.", kind: "Action" },
      { n: "05", title: "Record aggregate review outcomes", note: "Import platform, review ID, rating and source date; no review text.", kind: "Result" },
      { n: "06", title: "Close or route service follow-up", note: "An unresolved issue goes to Support; do not manipulate the rating.", kind: "Exit" },
    ],
    neverSendWhen: [],
    nextOutcomes: [],
    eligibilityNote: "",
    changes: [],
    entryEvent: { value: "Confirmed order delivery", help: "Owned by the selected email provider" },
    timing: { value: "14 days after delivery", help: "Source requirement: approximately 14 days" },
    template: { value: "Neutral product review request", help: "Versioned and approved before enabling" },
    draft: { timing: "14 days after delivery", template: "Neutral product review request" },
    draftVersion: "v1",
    preview: { subject: "How is your device working out?", body: ["Hi {{first_name}},", "If you have a moment, we'd value your honest review of order {{order_number}}.", "If something isn't right, reply and our support team will help. Unsubscribe any time: {{unsubscribe_link}}"] },
    tests,
    footnote: draftFootnote,
  },
};

/** The timings an owner may choose from. A draft outside the list is refused, so source text never sets a delay. */
export const TIMING_OPTIONS: Record<FlowKey, string[]> = {
  setup: ["24 hours after delivery", "48 hours after delivery"],
  "early-access": ["Welcome: on opt-in"],
  "abandoned-checkout": ["1 hour after checkout", "4 hours after checkout", "24 hours after checkout"],
  "review-request": ["14 days after delivery"],
};

/** Consent and audience eligibility (11:750). Categories are mutually exclusive, and unknown is never counted as opted in. */
export type ConsentData = {
  context: { badge: string; text: string };
  total: number;
  eligible: number;
  withdrawn: number;
  suppressed: number;
  unknown: number;
  exclusions: { reason: string; action: string; recovery: string }[];
  footnote: string;
};

export const consentDemo: ConsentData = {
  context: { badge: "Demo cohort", text: "1,000 source records · illustrative provider snapshot · no contact records copied" },
  total: 1000,
  eligible: 740,
  withdrawn: 130,
  suppressed: 60,
  unknown: 70,
  exclusions: [
    { reason: "Consent withdrawn", action: "Cancel every queued marketing send", recovery: "Only a new valid opt-in can re-enroll" },
    { reason: "Suppressed or bounced", action: "Respect provider suppression immediately", recovery: "Correct the source record and verify eligibility" },
    { reason: "Purchase completed", action: "Stop checkout reminders", recovery: "Continue only into the relevant consented flow" },
    { reason: "Support / return unresolved", action: "Hold review request; keep case linked", recovery: "Re-evaluate after the source case closes" },
    { reason: "Provider disconnected", action: "Hold all execution; show last known snapshot", recovery: "Reconnect and reconcile before releasing queue" },
  ],
  footnote: "Proposed unified eligibility UI · aggregate statuses depend on the selected provider capabilities.",
};

/** Activation and retention (11:852). */
export type ActivationData = {
  context: { badge: string; text: string };
  cohort: { delivered: number; paired: number; weekOne: number; pairingFailureEvents: number };
  horizons: { day: number; label: string; state: "Defined" | "Proposed" }[];
  retentionNote: string;
  reactivationNote: string;
  footnote: string;
};

export const activationDemo: ActivationData = {
  context: { badge: "Live export blocked", text: "Engineering export specification and health-data review are still pending" },
  cohort: { delivered: 100, paired: 86, weekOne: 64, pairingFailureEvents: 6 },
  horizons: [
    { day: 7, label: "First-use activation", state: "Defined" },
    { day: 30, label: "Continued use cohort", state: "Proposed" },
    { day: 60, label: "Dormant cohort recovery", state: "Proposed" },
    { day: 90, label: "Sustained use review", state: "Proposed" },
  ],
  retentionNote: "Proposed scope. Define meaningful aggregate retention with Product & Engineering before adding measurements or messages.",
  reactivationNote: "Any reactivation flow requires current consent, suppression, purpose and stop rules. Subscriptions and replenishment are not assumed for this hardware product.",
  footnote: "THO-197 data scope is pending approval. Figures above are design examples, not measured Farda activation.",
};

export const toneForHorizon = (state: "Defined" | "Proposed"): BadgeTone => (state === "Defined" ? "violet" : "neutral");
