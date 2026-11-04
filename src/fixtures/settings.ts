/**
 * Synthetic settings, automation and capability data (Figma 7:876, 7:1085, 14:637, 14:911, 66:641).
 * Every value is an example. Nothing here is a live provider, schedule or permission, and the demo adapter
 * is the only thing that serves it. Row states follow THO-305 FE13-02: setup required, validated, missing
 * permission, expired login or MFA, unsupported API, outage and unknown are separate states.
 */
import type { BadgeTone } from "@/components/Badge";

export type Chip = { label: string; tone: BadgeTone };

export const CONNECTION_KINDS = ["validated", "setupRequired", "missingPermission", "expiredLogin", "unsupportedApi", "outage", "unknown", "toChoose"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export type ConnectionRow = {
  id: string;
  system: string;
  kind: ConnectionKind;
  state: Chip;
  /** `known: false` is an unknown, never a zero or a recent success. */
  lastSuccess: { known: boolean; label: string };
  action: "openSource" | "openSetup" | "viewDecision";
  /** What the setup or source dialog says. It never offers a link, because the fixture has no verified URL. */
  detail: string;
  owner: string;
};

export type ConnectionsData = {
  systems: ConnectionRow[];
  freshness: { label: string; value: string; known: boolean }[];
  attention: Chip;
  freshnessNote: string;
  browser: { id: string; tool: string; workflow: string; status: Chip; kind: ConnectionKind; fallback: string }[];
  gates: { chip: string; tone: BadgeTone; title: string; note: string }[];
  observedLabel: string;
};

export const connectionsDemo: ConnectionsData = {
  systems: [
    { id: "notion", system: "Notion · creator records", kind: "validated", state: { label: "Connected", tone: "success" }, lastSuccess: { known: true, label: "3 min ago" }, action: "openSource", owner: "Creator desk", detail: "Creator records mirror. Credentials stay in Notion." },
    { id: "sheets", system: "Sheets · operations", kind: "validated", state: { label: "Connected", tone: "success" }, lastSuccess: { known: true, label: "3 min ago" }, action: "openSource", owner: "Fulfillment", detail: "Operations mirror. Credentials stay in Sheets." },
    { id: "quickbooks", system: "QuickBooks · official ledger", kind: "validated", state: { label: "Connected", tone: "success" }, lastSuccess: { known: true, label: "6:00 AM PT" }, action: "openSource", owner: "Finance / CPA", detail: "The official ledger. This app reads it and never writes to it." },
    { id: "shopify", system: "Shopify · orders & stock", kind: "validated", state: { label: "Connected", tone: "success" }, lastSuccess: { known: true, label: "3 min ago" }, action: "openSource", owner: "Fulfillment", detail: "Order and stock events. Credentials stay in Shopify." },
    { id: "shippo", system: "Shippo · shipment events", kind: "validated", state: { label: "Connected", tone: "success" }, lastSuccess: { known: true, label: "4 min ago" }, action: "openSource", owner: "Fulfillment", detail: "Shipment events. Credentials stay in Shippo." },
    { id: "intercom", system: "Intercom + Fin · support", kind: "setupRequired", state: { label: "Needs setup", tone: "warning" }, lastSuccess: { known: false, label: "Not yet tested" }, action: "openSetup", owner: "Support (needs assignment)", detail: "Support has never been tested. Setup needs an owner, a provider authorization and a test read. Opening setup does not connect anything." },
    { id: "email", system: "Email platform · consent", kind: "toChoose", state: { label: "To choose", tone: "neutral" }, lastSuccess: { known: false, label: "Not connected" }, action: "viewDecision", owner: "Not assigned", detail: "No email platform is chosen. Consent and sending stay off until one is chosen and verified." },
  ],
  freshness: [
    { label: "Orders", value: "3 minutes ago", known: true },
    { label: "Shipments", value: "4 minutes ago", known: true },
    { label: "Stock", value: "5 minutes ago", known: true },
    { label: "Support", value: "Setup required", known: false },
    { label: "Finance", value: "Today, 6:00 AM", known: true },
  ],
  attention: { label: "Attention required", tone: "warning" },
  freshnessNote: "A green connection does not prove the data is complete. Show stale or unknown when no successful receipt is available.",
  browser: [
    { id: "social-cat", tool: "Social Cat", workflow: "Pitch → brief → review → fee handoff", status: { label: "Setup required", tone: "warning" }, kind: "setupRequired", fallback: "Human in source" },
    { id: "tiktok-shop", tool: "TikTok Shop", workflow: "Creator outreach and replies", status: { label: "To validate", tone: "neutral" }, kind: "unknown", fallback: "Supported API / human" },
    { id: "other", tool: "Other source tools", workflow: "Approved source-owned edits", status: { label: "To validate", tone: "neutral" }, kind: "unknown", fallback: "Human in source" },
  ],
  gates: [
    { chip: "Permission missing", tone: "warning", title: "Social Cat automation", note: "Express provider authorization required for automated reads and writes" },
    { chip: "Setup unverified", tone: "warning", title: "Collabs tracking + billing", note: "Eligible merchant/creator, link/code test, activation and billing approval" },
    { chip: "Capability-specific", tone: "violet", title: "TikTok source actions", note: "Supported Open sample API where scoped; validated browser for other routes" },
  ],
  observedLabel: "Synthetic observations as of 2 Nov 2026, 10:00 AM PT. No provider was contacted.",
};

/** Team permissions (7:1085). */
export type TeamData = {
  matrix: { capability: string; founder: string; operator: string; viewer: string }[];
  owners: [string, string][];
  gaps: number;
  steps: { n: string; tone: BadgeTone; title: string; note: string }[];
  launch: [string, string][];
  /** Provider roles are not read by the demo. Application roles and provider authority stay separate. */
  sourceRoles: { source: string; providerRole: string }[];
};

export const teamDemo: TeamData = {
  matrix: [
    { capability: "View safe dashboards", founder: "Yes", operator: "Yes", viewer: "Yes" },
    { capability: "Request browser task", founder: "Yes", operator: "Yes", viewer: "No" },
    { capability: "Approve creator message", founder: "Yes", operator: "Assigned desk", viewer: "No" },
    { capability: "Approve Pay step", founder: "Yes", operator: "No", viewer: "No" },
    { capability: "Take over browser task", founder: "Yes", operator: "Assigned task", viewer: "No" },
    { capability: "Connect accounts / scopes", founder: "Yes", operator: "By source role", viewer: "No" },
    { capability: "Close accounting period", founder: "Source role", operator: "No", viewer: "No" },
  ],
  owners: [["Creator desk", "Assigned"], ["Fulfillment", "Per shipping home"], ["Finance / CPA", "Assigned"], ["Support", "Needs assignment"], ["Automation", "Needs assignment"]],
  gaps: 2,
  steps: [
    { n: "1", tone: "neutral", title: "Draft", note: "Agent proposes message or terms" },
    { n: "2", tone: "violet", title: "Human approval", note: "Named approver, revision, timestamp" },
    { n: "3", tone: "neutral", title: "Source execution", note: "Browser acts only on approved payload" },
    { n: "4", tone: "success", title: "Receipt", note: "Evidence and final source state recorded" },
  ],
  launch: [["Sample shipment gate", "L − 25 days"], ["Readiness test", "L − 7 days"], ["Founder review", "L − 4 days"], ["Media review", "L + 14 days"]],
  sourceRoles: [
    { source: "Notion", providerRole: "Not read" },
    { source: "Sheets", providerRole: "Not read" },
    { source: "QuickBooks", providerRole: "Not read" },
    { source: "Shopify", providerRole: "Not read" },
    { source: "Social Cat", providerRole: "Express authorization missing" },
    { source: "TikTok Shop", providerRole: "Not read" },
  ],
};

/** Automation runs (14:637). */
export const RUN_PLATFORMS = [
  { value: "all", label: "All platforms" },
  { value: "social-cat", label: "Social Cat" },
  { value: "tiktok", label: "TikTok" },
  { value: "zapier", label: "Zapier" },
] as const;
export const RUN_STATES = [
  { value: "all", label: "All states" },
  { value: "approval", label: "Approval required" },
  { value: "unknown", label: "Outcome unknown" },
  { value: "login", label: "Login required" },
  { value: "blocked", label: "Capability blocked" },
  { value: "succeeded", label: "Succeeded" },
  { value: "scheduled", label: "Scheduled" },
  { value: "canceled", label: "Canceled" },
] as const;

export type RunNext = { label: string; variant: "primary" | "secondary" | "ghost"; to?: string; dialog?: string };
export type AutomationRun = { id: string; name: string; executor: string; platform: string; state: string; chip: Chip; updated: string; assignedToMe: boolean; next: RunNext };

export type AutomationData = {
  kpis: { label: string; value: string; context: string }[];
  runs: AutomationRun[];
  contract: [string, string][];
  recovery: { state: string; next: string }[];
  /** Registered job types only. Request task never accepts a job type typed by the user. */
  jobTypes: { value: string; label: string; plan: string[] }[];
  accounts: { value: string; label: string }[];
  zaps: { id: string; name: string; trigger: string; state: Chip; provider: string; scheduleTo: string | null }[];
  reports: { name: string; timing: string; enablement: string }[];
};

export const automationDemo: AutomationData = {
  kpis: [
    { label: "Needs a decision", value: "08", context: "Pending exact-action approval" },
    { label: "Running", value: "03", context: "Source session active" },
    { label: "Needs attention", value: "02", context: "Login required · outcome unknown" },
    { label: "Confirmed today", value: "24", context: "Source receipts recorded" },
  ],
  runs: [
    { id: "RUN-SC-1042", name: "RUN-SC-1042 · brief", executor: "Social Cat browser", platform: "social-cat", state: "approval", chip: { label: "Approval required", tone: "warning" }, updated: "12m ago", assignedToMe: false, next: { label: "Review approval", variant: "secondary", to: "/approvals/demo-approval-042" } },
    { id: "RUN-SC-1039", name: "RUN-SC-1039 · pitch", executor: "Social Cat browser", platform: "social-cat", state: "unknown", chip: { label: "Outcome unknown", tone: "danger" }, updated: "16m ago", assignedToMe: true, next: { label: "Reconcile", variant: "primary", to: "/runs/demo-run-uncertain?tab=recovery" } },
    { id: "RUN-SC-1038", name: "RUN-SC-1038 · review", executor: "Social Cat browser", platform: "social-cat", state: "login", chip: { label: "Login required", tone: "warning" }, updated: "21m ago", assignedToMe: true, next: { label: "Take over", variant: "secondary", dialog: "takeover" } },
    { id: "RUN-TT-1021", name: "RUN-TT-1021 · invite", executor: "Route to validate", platform: "tiktok", state: "blocked", chip: { label: "Capability blocked", tone: "neutral" }, updated: "32m ago", assignedToMe: false, next: { label: "View connection", variant: "secondary", to: "/settings/connections" } },
    { id: "ZAP-05", name: "ZAP-05 · order mirror", executor: "Zapier", platform: "zapier", state: "succeeded", chip: { label: "Succeeded", tone: "success" }, updated: "3m ago", assignedToMe: false, next: { label: "View run", variant: "ghost", dialog: "trace" } },
    { id: "ZAP-12", name: "ZAP-12 · daily digest", executor: "Zapier", platform: "zapier", state: "scheduled", chip: { label: "Scheduled", tone: "violet" }, updated: "8:30am PT", assignedToMe: false, next: { label: "View schedule", variant: "ghost", to: "/automations/zap-12/schedule" } },
    { id: "RUN-SC-1029", name: "RUN-SC-1029 · brief", executor: "Social Cat browser", platform: "social-cat", state: "canceled", chip: { label: "Canceled", tone: "neutral" }, updated: "1h ago", assignedToMe: false, next: { label: "View history", variant: "ghost", dialog: "trace" } },
  ],
  contract: [
    ["Task source", "Zapier event + Notion queue"],
    ["Approved identity", "Creator + collaboration + action"],
    ["Payload", "Version + final content / amount"],
    ["Duplicate protection", "Unique action key + active lease"],
    ["Success proof", "Source receipt + write-back"],
  ],
  recovery: [
    { state: "Login / MFA", next: "User completes source sign-in" },
    { state: "Page changed", next: "Verify source and target control" },
    { state: "Outcome unknown", next: "Reconcile before a fresh attempt" },
    { state: "Approval changed", next: "Request a new decision" },
    { state: "Opted out / canceled", next: "Cancel pending contact actions" },
  ],
  jobTypes: [
    { value: "daily-sourcing", label: "Daily sourcing plan", plan: ["Read permitted source capacity", "Propose a finite set of prospects", "Wait for an exact-action approval"] },
    { value: "evidence-review", label: "Lifestyle evidence review", plan: ["Open the saved video evidence", "Prepare observations for review", "Wait for a reviewer's decision"] },
    { value: "hourly-check", label: "Hourly monitor check", plan: ["Read enrolled creators' posts", "Read inbox and status changes", "Record the source receipt"] },
  ],
  accounts: [
    { value: "social-cat", label: "Social Cat · demo account" },
    { value: "tiktok-shop", label: "TikTok Shop · demo account" },
  ],
  zaps: [
    { id: "zap-05", name: "ZAP-05 · order mirror", trigger: "On each paid order", state: { label: "Succeeded", tone: "success" }, provider: "Zapier · reference not verified", scheduleTo: null },
    { id: "zap-12", name: "ZAP-12 · daily digest", trigger: "Weekdays 8:30am PT", state: { label: "Paused", tone: "warning" }, provider: "Zapier · reference not verified", scheduleTo: "/automations/zap-12/schedule" },
  ],
  reports: [
    { name: "Daily exceptions digest", timing: "#ops-daily · weekdays 8:30am PT", enablement: "Paused; needs connection proof and owner approval" },
    { name: "Weekly snapshot", timing: "#ops-weekly · Monday 8:30am PT", enablement: "First Monday after L; frozen version + late correction" },
    { name: "Launch pulse", timing: "#launch-room · hourly 7am–11pm PT", enablement: "L through L+3; disabled until L is approved" },
    { name: "Live red alert", timing: "Lost/returned shipment or Zap error", enablement: "Post source event once; correlate error and run" },
  ],
};

/** Zap and report schedule (14:911). Dates and times are examples. */
export const CADENCES = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Every day" },
  { value: "weekly-monday", label: "Mondays" },
] as const;
export const TIMEZONES = ["America/Los_Angeles", "America/New_York", "UTC"] as const;
export type Cadence = (typeof CADENCES)[number]["value"];
export type ScheduleDraft = { cadence: Cadence; localTime: string; timezone: string; activeCohortOverride: boolean };

export type ScheduleData = {
  jobId: string;
  title: string;
  subtitle: string;
  steps: { n: string; tone: BadgeTone; title: string; note: string }[];
  draft: ScheduleDraft;
  draftVersion: string;
  destination: string;
  owner: string;
  state: "Paused" | "Enabled";
  digest: { count: string; groups: { heading: string; lines: string[] }[]; footnote: string };
  history: { run: string; result: string; receipt: string }[];
  historyNote: string;
  others: { report: string; timing: string; enablement: string }[];
};

export const DEMO_JOB_ID = "zap-12";

export const scheduleDemo: ScheduleData = {
  jobId: DEMO_JOB_ID,
  title: "A reliable daily handoff.",
  subtitle: "Zap 12 · daily exceptions digest · schedule, inputs, output and recovery.",
  steps: [
    { n: "1", tone: "violet", title: "Schedule trigger", note: "Weekdays at 8:30am · America/Los_Angeles" },
    { n: "2", tone: "neutral", title: "Read safe source aggregates", note: "Launch gates, creators, content, commerce, support and stock" },
    { n: "3", tone: "warning", title: "Validate data freshness", note: "Missing or stale input is shown explicitly; it is not zero" },
    { n: "4", tone: "neutral", title: "Build the message", note: "Omit empty sections; use the all-clear line if nothing is flagged" },
    { n: "5", tone: "neutral", title: "Post once to #ops-daily", note: "Dedupe by report type + date + destination" },
    { n: "6", tone: "success", title: "Save receipt and run result", note: "Slack message ID, source as-of times and last successful run" },
  ],
  draft: { cadence: "weekdays", localTime: "08:30", timezone: "America/Los_Angeles", activeCohortOverride: false },
  draftVersion: "v1",
  destination: "#ops-daily",
  owner: "Automation owner",
  state: "Paused",
  digest: {
    count: "3 exceptions",
    groups: [
      { heading: "Creator follow-ups · 2 due today", lines: ["@studio.rae · brief approval waiting 26h", "@dailywithjo · posting deadline in 2 days"] },
      { heading: "Stock · Home H2 below threshold", lines: ["18 available · threshold 20 · open source stock view"] },
    ],
    footnote: "No customer names, addresses, emails, health details or review text. A zero-exception run sends “No exceptions”.",
  },
  history: [
    { run: "29 Oct · sandbox", result: "Pass", receipt: "TEST-SLACK-009" },
    { run: "28 Oct · sandbox", result: "Input stale", receipt: "No post" },
    { run: "27 Oct · sandbox", result: "Connection error", receipt: "No post" },
  ],
  historyNote: "Failed input → fix the source and rerun read steps. Unknown Slack send → look up the report key and receipt before reposting. Live red events go to #ops-alerts or #ops-automation.",
  others: [
    { report: "Weekly snapshot", timing: "#ops-weekly · Monday 8:30am PT", enablement: "First Monday after L; frozen version + late correction" },
    { report: "Launch pulse", timing: "#launch-room · hourly 7am–11pm PT", enablement: "L through L+3; disabled until L is approved" },
    { report: "Live red alert", timing: "Lost/returned shipment or Zap error", enablement: "Post source event once; correlate error and run" },
  ],
};

/** Channel capabilities (66:641). */
export const CAPABILITY_TABS = ["capabilities", "access", "attribution", "exceptions"] as const;
export type CapabilityTab = (typeof CAPABILITY_TABS)[number];

export type CapabilityRow = {
  id: string;
  surface: string;
  route: string;
  evidence: string;
  kind: ConnectionKind;
  /** The Fallback / next step button. */
  action: { label: string; type: "record" | "plan" | "commitment" | "inspect"; plan: string[] };
  /** Capability states for the Inspect dialog. Nothing is permitted until verified. */
  capabilities: { action: string; state: "unverified" | "unsupported" | "denied" | "unknown"; note: string }[];
};

export type CapabilityData = {
  rows: CapabilityRow[];
  rowsNote: string;
  tests: { chip: string; title: string; note: string; expected: string }[];
  capacity: { label: string; value: string; context: string }[];
  capacityNote: string;
  footnote: string;
  accessEvidence: { source: string; action: string; state: string; observed: string }[];
  exceptions: { id: string; record: string; reason: string }[];
  /** Permission evidence recorded this session, by row. Recording it never changes a row's capability state. */
  recorded: Record<string, { reviewer: string; evidence: string; observedOn: string; version: string }>;
};

export const capabilityDemo: CapabilityData = {
  rows: [
    {
      id: "social-cat", surface: "Social Cat campaign + Inbox", route: "Approved native browser", evidence: "Express automation authorization missing", kind: "missingPermission",
      action: { label: "Record permission", type: "record", plan: [] },
      capabilities: [{ action: "Read invitations", state: "denied", note: "Express provider authorization is missing." }, { action: "Send an approved message", state: "denied", note: "Missing authorization is never bypassed by a browser." }],
    },
    {
      id: "collabs", surface: "Website attribution + commission", route: "Collabs native UI / export", evidence: "Merchant + creator eligibility unverified", kind: "unknown",
      action: { label: "Validate Collabs", type: "plan", plan: ["Confirm merchant and creator eligibility in Collabs", "Issue a test link or code and check attribution", "Record the evidence with its reviewer and time"] },
      capabilities: [{ action: "Read attribution export", state: "unverified", note: "No export has been observed." }],
    },
    {
      id: "settlement", surface: "Website automatic settlement", route: "Provider-owned billing + payout", evidence: "Billing authority and activation unverified", kind: "unknown",
      action: { label: "Review commitment", type: "commitment", plan: [] },
      capabilities: [{ action: "Activate billing", state: "unverified", note: "Billing authority has not been verified." }],
    },
    {
      id: "tiktok-invites", surface: "TikTok invitations / order reads", route: "Approved scoped API if available", evidence: "Partner scopes and live account unverified", kind: "unknown",
      action: { label: "Validate API / browser", type: "plan", plan: ["Check the partner scopes granted to this account", "Read one order with the scoped API", "If the API doesn't support it, ask an authorized owner for the browser route"] },
      capabilities: [{ action: "Read orders", state: "unverified", note: "Partner scopes are unverified." }, { action: "Send an invitation", state: "unsupported", note: "No supported API route is documented for this action." }],
    },
    {
      id: "tiktok-samples", surface: "TikTok sample decisions", route: "Open: validated API / other routes: browser", evidence: "Open PENDING approve/reject documented; seller scope and account unverified", kind: "unknown",
      action: { label: "Validate sample route", type: "plan", plan: ["Confirm seller scope for sample requests", "Read one pending request without deciding it", "Record which route can decide samples"] },
      capabilities: [{ action: "Approve or reject a sample", state: "unverified", note: "Documented for the open API. Seller scope is unverified." }],
    },
    {
      id: "shopify-flow", surface: "Shopify Flow / Zapier orchestration", route: "Plan-dependent supported route", evidence: "Flow HTTP and connector actions unverified", kind: "unknown",
      action: { label: "Inspect available actions", type: "inspect", plan: [] },
      capabilities: [{ action: "Flow HTTP request", state: "unverified", note: "Plan support is unverified." }, { action: "Connector actions", state: "unknown", note: "No connector has been listed." }],
    },
  ],
  rowsNote: "Social Cat automated access requires express provider authorization. A denied TikTok action goes to an authorized owner, not a browser bypass. Collabs uses validated native review/export routes.",
  tests: [
    { chip: "Not run", title: "Creator and account identity", note: "Resolve canonical CreatorID, profile account, provider program and payee", expected: "One canonical creator for the account and payee" },
    { chip: "Not run", title: "Link/code + checkout ownership", note: "Verify actual precedence, commission base, discount stacking and attribution window", expected: "Documented precedence matches observed orders" },
    { chip: "Not run", title: "Refund / reversal behavior", note: "Test partial and post-hold cases where documentation is incomplete", expected: "Commission reverses with the refund" },
    { chip: "Not run", title: "Creator activation + statement export", note: "Separate activation, merchant billing, creator payment and invoice match", expected: "Four separate states, each with evidence" },
    { chip: "Not run", title: "Provider quota + automation scope", note: "Capture quantity, unit, tier, reset, timestamp and authorization evidence", expected: "A quota record with unit, tier and reset" },
  ],
  capacity: [
    { label: "Social Cat invitations", value: "5,000 / mo", context: "Published Pro allowance · not live availability" },
    { label: "Social Cat collaborations", value: "30 / mo", context: "Different unit · actual used/remaining unverified" },
    { label: "TikTok native quota", value: "Read source", context: "Quantity + unit + tier + reset, not a hardcoded daily cap" },
    { label: "Inventory + commitments", value: "Own limits", context: "Reserved stock and approved financial bounds" },
  ],
  capacityNote: "Prioritize due work, preserve completed progress, pause when access expires and wait when the provider requests it. Refresh capacity before the next action.",
  footnote: "Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.",
  accessEvidence: [
    { source: "Social Cat", action: "Automated reads and writes", state: "Denied · authorization missing", observed: "Unknown" },
    { source: "TikTok Shop", action: "Order reads", state: "Unverified", observed: "Unknown" },
    { source: "Collabs", action: "Attribution export", state: "Unverified", observed: "Unknown" },
  ],
  exceptions: [],
  recorded: {},
};
