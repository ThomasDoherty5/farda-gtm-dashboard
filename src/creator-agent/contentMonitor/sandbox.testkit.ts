import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { evt } from "../funnelFixtures.testkit.ts";
import type { FunnelEvent } from "../funnelContract.ts";
import { intakeInputSchema, type SinkBinding, type SinkReceipt } from "../intake/contract.ts";
import type { CanonicalRecord } from "../intake/repository.ts";
import { createRuntimeTestkit, syntheticRuntimeRegistration } from "../jobs/runtime.testkit.ts";
import { RuntimeError, type RuntimeAuthority, type RuntimePreflight, type RuntimeRegistration, type RuntimeWindowPlan } from "../jobs/runtimeSchema.ts";
import type { AgentServerOptions } from "../server.ts";
import type { J08Metric, J08Page, J08Policy, J08ReadRequest, J08SourceReader } from "./contract.ts";

/**
 * J08-10 sandbox. Every creator, account, post, message, order and receipt here is fictional and synthetic; nothing contacts a
 * provider. Testkit files are excluded from the production image (`.dockerignore`), and the launcher binds no J08 source, so this
 * fixture cannot reach a production executor. The evidence stage is "synthetic" end to end.
 */
export const j08SandboxPolicy: J08Policy = {
  version: "synthetic-j08-policy-v1",
  // The ticket's initial implementation defaults (24h, 7d, 30d), carried as versioned sandbox configuration.
  checkpoints: { version: "ticket-initial-checkpoints-v1", hours: [24, 168, 720] },
  attributionRule: "reviewed-campaign-evidence.v1",
};
export const j08SandboxStart = "2026-11-06T00:00:00Z";
export function j08SandboxRegistration(overrides: Partial<RuntimeRegistration> = {}): RuntimeRegistration {
  const base = syntheticRuntimeRegistration();
  return syntheticRuntimeRegistration({ registrationRef: "synthetic-j08", family: "J08", membership: "enrolled-only",
    cadence: { kind: "hourly", timezone: "America/Los_Angeles", minute: 0, startsAt: j08SandboxStart },
    ownerRef: "owner:synthetic-j08", sourceRef: "source:synthetic-j08-content", sourceSchemaVersion: "j08-page.v1", outputSchemaVersion: "j08-output.v1",
    executorRef: "synthetic-j08-read.v1", browserBinding: null, browserExecutorRef: null, apiChannel: "directApi",
    apiBinding: { ...base.apiBinding!, action: "read-creator-content", routeRef: "route:synthetic-j08-api", requiredScopes: ["synthetic-read-content", "synthetic-read-inbox"] },
    definition: { ...base.definition, jobId: "synthetic-j08", ownerRef: "owner:synthetic-j08", eventType: "j08-hourly-window", policyVersion: j08SandboxPolicy.version,
      budgets: { maxItems: 10, maxSteps: 200, maxAttempts: 3, maxRunMs: 900_000, leaseMs: 60_000, maxConcurrency: 1, retryBaseMs: 10 } }, ...overrides });
}

type Creator = { key: string; candidate: string; recruitment: "social-cat" | "tiktok-shop"; campaigns: string[];
  profiles: { network: "instagram" | "tiktok"; accountId: string; sourceId: string; handle: string }[] };
/** Fictional watchlist: mixed Instagram/TikTok, a crosspost, concurrent campaigns, an inaccessible row and creator-wide codes. */
export const j08SandboxCreators: Creator[] = [
  { key: "a", candidate: "synthetic-candidate-a", recruitment: "social-cat", campaigns: ["campaign-spring"],
    profiles: [{ network: "instagram", accountId: "synthetic-ig-account-a", sourceId: "synthetic-ig-profile-a", handle: "synthetic.maker.a" }] },
  { key: "b", candidate: "synthetic-candidate-b", recruitment: "tiktok-shop", campaigns: ["campaign-spring"],
    profiles: [{ network: "instagram", accountId: "synthetic-ig-account-b", sourceId: "synthetic-ig-profile-b", handle: "synthetic.maker.b" },
      { network: "tiktok", accountId: "synthetic-tt-account-b", sourceId: "synthetic-tt-profile-b", handle: "synthetic.maker.b" }] },
  { key: "c", candidate: "synthetic-candidate-c", recruitment: "social-cat", campaigns: ["campaign-spring", "campaign-autumn"],
    profiles: [{ network: "instagram", accountId: "synthetic-ig-account-c", sourceId: "synthetic-ig-profile-c", handle: "synthetic.maker.c" }] },
  { key: "d", candidate: "synthetic-candidate-d", recruitment: "tiktok-shop", campaigns: ["campaign-spring"],
    profiles: [{ network: "tiktok", accountId: "synthetic-tt-account-d", sourceId: "synthetic-tt-profile-d", handle: "synthetic.maker.d" }] },
  { key: "e", candidate: "synthetic-candidate-e", recruitment: "social-cat", campaigns: ["campaign-autumn"],
    profiles: [{ network: "instagram", accountId: "synthetic-ig-account-e", sourceId: "synthetic-ig-profile-e", handle: "synthetic.maker.e" }] },
];

type PostSpec = { id: string; account: string; network: "instagram" | "tiktok"; ageHours: number; creative: string | null; url: string | null;
  evidence: J08Page["posts"][number]["fardaEvidence"]; counts: Partial<Record<J08Metric["metricKey"], number | null>> };
const ig = (id: string) => `https://www.instagram.com/reel/${id}/`, tt = (handle: string, id: string) => `https://www.tiktok.com/@${handle}/video/${id}`;
const reviewed = (kind: J08Page["posts"][number]["fardaEvidence"][number]["kind"], campaignId: string | null, receipt: string) => [{ kind, campaignId, reviewed: true, receiptRef: receipt }];
/** Native post fixtures. Instagram and TikTok views have different definitions, so a cross-network total is not comparable. */
export const j08SandboxPosts: PostSpec[] = [
  { id: "SYNTHA1", account: "synthetic-ig-account-a", network: "instagram", ageHours: 26, creative: "synthetic-creative-a1", url: ig("SYNTHA1"),
    evidence: reviewed("productLink", "campaign-spring", "synthetic-link-review-a1"), counts: { views: 1200, likes: 90, comments: 12, shares: 6 } },
  { id: "SYNTHA2", account: "synthetic-ig-account-a", network: "instagram", ageHours: 3, creative: "synthetic-creative-a2", url: ig("SYNTHA2"),
    evidence: reviewed("reviewedLink", "campaign-spring", "synthetic-link-review-a2"), counts: { views: 0, likes: 0, comments: 0, shares: 0 } },
  { id: "7300000000000000001", account: "synthetic-tt-account-b", network: "tiktok", ageHours: 192, creative: "synthetic-creative-b1",
    url: tt("synthetic.maker.b", "7300000000000000001"), evidence: reviewed("discountCode", "campaign-spring", "synthetic-code-review-b1"),
    counts: { views: 5000, likes: 300, comments: 20, shares: null } },
  { id: "7300000000000000002", account: "synthetic-tt-account-b", network: "tiktok", ageHours: 40, creative: null, url: null, evidence: [], counts: { views: 70 } },
  { id: "SYNTHB1", account: "synthetic-ig-account-b", network: "instagram", ageHours: 170, creative: "synthetic-creative-b1", url: ig("SYNTHB1"),
    evidence: reviewed("reviewedLink", "campaign-spring", "synthetic-link-review-b1-ig"), counts: { views: 800, likes: 40, comments: 4, shares: 2 } },
  { id: "SYNTHC1", account: "synthetic-ig-account-c", network: "instagram", ageHours: 5, creative: "synthetic-creative-c1", url: ig("SYNTHC1"),
    evidence: reviewed("brandMention", null, "synthetic-brand-review-c1"), counts: { views: 400, likes: 20, comments: 2, shares: 1 } },
  { id: "7300000000000000004", account: "synthetic-tt-account-d", network: "tiktok", ageHours: 30, creative: "synthetic-creative-d1",
    url: tt("synthetic.maker.d", "7300000000000000004"), evidence: reviewed("reviewedLink", "campaign-spring", "synthetic-link-review-d1"),
    counts: { views: 300, likes: 10, comments: 1, shares: 0 } },
  { id: "SYNTHE1", account: "synthetic-ig-account-e", network: "instagram", ageHours: 2, creative: "synthetic-creative-e1", url: ig("SYNTHE1"),
    evidence: reviewed("productLink", "campaign-autumn", "synthetic-link-review-e1"), counts: { views: 50, likes: 5, comments: 0, shares: 0 } },
];
const definitions = { instagram: "Synthetic Instagram plays (native lifetime counter)", tiktok: "Synthetic TikTok video views (native lifetime counter)" };
const missing = { shares: "SHARES_NOT_EXPOSED", saves: "SAVES_NOT_EXPOSED", reach: "REACH_NOT_AUTHORIZED" } as Record<string, string>;

/** Mutable synthetic world. Tests change it between hourly runs; the source reads only from it. */
export type J08SandboxWorld = { now: () => number; t0: number; reads: J08ReadRequest[]; failOnce: Set<string>; failed: Set<string>;
  login: Set<string>; access: Map<string, "denied" | "uiDrift" | "throttled" | "mfaRequired">; privatePosts: Set<string>; urlOverride: Map<string, string>; extraPosts: Map<string, PostSpec[]>; crossAccount: boolean; stage: "synthetic" | "source"; fixedReceipt: string | null; throwStatus: number | null };
export function createJ08SandboxWorld(now: () => number, t0: number): J08SandboxWorld {
  return { now, t0, reads: [], failOnce: new Set(["synthetic-tt-account-b:page-2"]), failed: new Set(), login: new Set(), access: new Map(), privatePosts: new Set(),
    urlOverride: new Map(), extraPosts: new Map(), crossAccount: false, stage: "synthetic", fixedReceipt: null, throwStatus: null };
}
/** Read-only synthetic source: it has no send, like, follow, accept, rate or approval capability. */
export function createJ08SandboxSource(world: J08SandboxWorld): J08SourceReader {
  return {
    async read(request) {
      world.reads.push(structuredClone(request));
      if (world.throwStatus !== null) throw Object.assign(new Error("Synthetic source rejection"), { status: world.throwStatus });
      const at = world.now(), observedAt = new Date(at).toISOString(), account = request.subject.profile.accountId;
      const base = { requestDigest: digest(request), evidenceStage: world.stage, method: "native-api" as const, observedAt, retryAfterMs: null, posts: [], inbox: [], nextCursor: null };
      const receipt = (suffix: string) => world.fixedReceipt ?? `synthetic-receipt:${digest([request, at, suffix]).slice(0, 32)}`;
      if (world.login.has(account)) return { ...base, receiptRef: receipt("login"), access: "loginRequired" };
      const limited = world.access.get(account);
      if (limited) return { ...base, receiptRef: receipt(limited), access: limited, retryAfterMs: limited === "throttled" ? 1000 : null };
      if (request.stage === "inbox") {
        const inbox = account === "synthetic-ig-account-a" ? [{ ref: { provider: "instagram", accountId: account, sourceId: "synthetic-message-a1", url: null },
          conversationId: "synthetic-conversation-a", at: new Date(world.t0 - 30 * 60_000).toISOString(), sourceUpdatedAt: null, kind: "reply", direction: "inbound",
          receiptRef: "synthetic-message-receipt-a1" }] : [];
        return { ...base, receiptRef: receipt("inbox"), access: "authorized", inbox };
      }
      const pageKey = request.cursor === "synthetic-page-2" ? `${account}:page-2` : `${account}:page-1`;
      if (world.failOnce.has(pageKey) && !world.failed.has(pageKey)) {
        world.failed.add(pageKey);
        return { ...base, receiptRef: receipt("unavailable"), access: "unavailable", retryAfterMs: 1000 };
      }
      const all = [...j08SandboxPosts, ...(world.extraPosts.get(account) ?? [])].filter(p => p.account === account);
      const split = account === "synthetic-tt-account-b";
      const chosen = split ? all.filter((_, i) => request.cursor === "synthetic-page-2" ? i === 1 : i === 0) : all;
      const posts = chosen.map(p => {
        const publishedAt = new Date(world.t0 - p.ageHours * 3600_000).toISOString(), hidden = world.privatePosts.has(p.id);
        return { ref: { provider: p.network, accountId: world.crossAccount ? "synthetic-other-account" : account, sourceId: p.id, url: world.urlOverride.get(p.id) ?? p.url },
          creativeRef: p.creative, publishedAt, sourceUpdatedAt: null, access: "authorized", visibility: hidden ? "private" : "public", context: "organic",
          fardaEvidence: p.evidence, metrics: hidden ? [] : (["views", "likes", "comments", "shares", "saves", "reach"] as const).map(metricKey => {
            const value = p.counts[metricKey] ?? null;
            return { metricKey, value, unit: "count", definition: metricKey === "views" ? definitions[p.network] : `Synthetic native ${metricKey}`, semantics: "cumulative",
              window: { start: publishedAt, end: observedAt }, missingReason: value === null ? missing[metricKey] ?? "METRIC_NOT_REPORTED" : null };
          }) };
      });
      return { ...base, receiptRef: receipt(pageKey), access: "authorized", posts, nextCursor: split && request.cursor === null ? "synthetic-page-2" : null };
    },
    assertCurrent(page, request) { if (page.requestDigest !== digest(request)) throw new RuntimeError("SYNTHETIC_SOURCE_CHANGED"); },
  };
}

type Plan = { items: { itemKey: string; subjectRef: string; evidenceRef: string | null; enrollmentRef: string }[]; coverage: "complete" | "partial";
  continuation: string | null; total: number | null };
/**
 * Synthetic runtime authority that freezes J08's own watchlist plan for each window. Activation, quota, takeover and current-state
 * fences reuse the shared runtime testkit. It never claims a live schedule: the trigger is the sandbox driver.
 */
export function createJ08SandboxRuntime(db: DatabaseSync, options: { now: () => number; plan: () => (input: { window: RuntimeWindowPlan["window"]; continuation: string | null }) => Plan }) {
  const registration = j08SandboxRegistration();
  const kit = createRuntimeTestkit(db, { registration, now: options.now });
  const issued = new Map<string, string>(), base = new Map<string, RuntimePreflight>(), enrollments = new Map<string, string>();
  const remember = <T extends { receiptRef: string }>(proof: T): T => { issued.set(proof.receiptRef, digest(proof)); return structuredClone(proof); };
  const lease = (receiptRef: string) => ({ scope: kit.options.scope, receiptRef, observedAt: new Date(options.now()).toISOString(), validUntil: new Date(options.now() + 60_000).toISOString() });
  const assertIssued = (proof: { receiptRef: string; validUntil: string }) => {
    if (kit.state.denied) throw new RuntimeError("SOURCE_SCOPE_DENIED", 403);
    if (!kit.state.active) throw new RuntimeError("RUNTIME_ACTIVATION_REVOKED");
    if (issued.get(proof.receiptRef) !== digest(proof) || Date.parse(proof.validUntil) <= options.now()) throw new RuntimeError("SYNTHETIC_SOURCE_PROOF_STALE");
  };
  const authority: RuntimeAuthority = {
    resolveActivation: r => kit.authority.resolveActivation(r),
    assertActivation: (proof, r, now) => kit.authority.assertActivation(proof, r, now),
    prepareWindow: async ({ registration: r, window, continuation }) => {
      if (kit.state.denied) throw new RuntimeError("SOURCE_SCOPE_DENIED", 403);
      if (!kit.state.active) throw new RuntimeError("RUNTIME_ACTIVATION_REVOKED");
      const plan = options.plan()({ window, continuation });
      for (const item of plan.items) enrollments.set(JSON.stringify([window.windowRef, item.subjectRef]), item.enrollmentRef);
      return remember({ ...lease(`receipt:synthetic-j08-window-${digest({ window, continuation, at: options.now() })}`), sourceVersion: kit.state.sourceVersion,
        registrationHash: digest(r), window, kind: "source" as const, ...plan });
    },
    assertWindow: proof => { assertIssued(proof); if (proof.sourceVersion !== kit.state.sourceVersion) throw new RuntimeError("SYNTHETIC_SOURCE_CHANGED"); },
    resolvePreflight: async request => {
      const proof = await kit.authority.resolvePreflight(request) as RuntimePreflight;
      const own = { ...proof, receiptRef: `receipt:synthetic-j08-preflight-${digest(proof.receiptRef)}`,
        enrollmentRef: enrollments.get(JSON.stringify([request.window.windowRef, request.item.subjectRef])) ?? null };
      base.set(own.receiptRef, proof);
      return remember(own);
    },
    assertCurrent: (proof, request, now) => { assertIssued(proof); kit.authority.assertCurrent(base.get(proof.receiptRef)!, request, now); },
    resolveTakeover: request => kit.authority.resolveTakeover(request),
    assertTakeover: (proof, now) => kit.authority.assertTakeover(proof, now),
  };
  return { kit, registration, authority };
}

/** Fictional J01 sinks returning applied receipts; nothing leaves the process. */
export function j08SandboxSink(name: string) {
  const records = new Map<string, SinkReceipt>();
  return {
    upsert: (key: string, _record: CanonicalRecord, binding: SinkBinding) => {
      const receipt: SinkReceipt = { ...binding, state: "applied", receiptRef: `${name}:${key}`, observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 3600_000).toISOString() };
      records.set(key, receipt); return receipt;
    },
    read: (key: string, binding: SinkBinding) => records.get(key) ?? { ...binding, state: "notApplied", terminal: true, receiptRef: `fence:${binding.attemptId}`, observedAt: new Date().toISOString() },
  };
}
/** Fictional J01 authority. `suppressed` holds canonical creator IDs that opted out; J01 evaluates it on every membership read. */
export const j08SandboxIntakeAuthority = (suppressed: Set<string> = new Set()): NonNullable<AgentServerOptions["intakeAuthority"]> => ({ route: () => "Ready",
  crosswalk: () => ({ version: "synthetic-map-v1", entries: [] }),
  suppression: () => ({ version: "synthetic-suppression-v1", entries: [...suppressed].map(creatorId => ({ subject: { kind: "creator" as const, creatorId },
    reason: "opt-out" as const, sourceRef: "synthetic-opt-out-receipt", effectiveAt: "2026-01-01T00:00:00.000Z" })) }),
  sinks: { "notion-creator-crm": j08SandboxSink("synthetic-notion"), "sheets-watchlist": j08SandboxSink("synthetic-sheets") } });

type Post = (path: string, body: unknown, token: string, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }>;
/** Seeds the fictional watchlist through the actual J01 intake route and returns creator key -> canonical creator ID. */
export async function seedJ08Intake(post: Post, scope: { workspaceId: string; accountId: string }, reviewerToken: string) {
  const ids = new Map<string, string>();
  for (const creator of j08SandboxCreators) for (const campaign of creator.campaigns) {
    const at = new Date().toISOString(), ref = { source: "notion", accountId: scope.accountId, sourceId: campaign, url: null, canonicalId: campaign,
      identityState: "resolved", provenanceRef: `synthetic-campaign-proof-${campaign}` };
    const input = intakeInputSchema.parse({ campaignRef: ref, briefRef: { ref: "synthetic-brief", version: "v1" }, recruitmentSource: creator.recruitment, trigger: "signup",
      eventId: `synthetic-j08-signup-${creator.key}-${campaign}`, sourceCandidate: { ...ref, source: creator.recruitment, accountId: "synthetic-recruit-account",
        sourceId: creator.candidate, canonicalId: null, identityState: "unresolved", provenanceRef: `synthetic-signup-${creator.key}` },
      profileRefs: creator.profiles.map(p => ({ source: p.network, accountId: p.accountId, sourceId: p.sourceId, url: null, canonicalId: null, identityState: "unresolved",
        provenanceRef: `synthetic-native-profile-${p.sourceId}`, handle: p.handle, sourceUpdatedAt: at })),
      occurredAt: at, observedAt: at, publishingNetworks: [...new Set(creator.profiles.map(p => p.network))], identityMapVersion: "synthetic-map-v1",
      suppressionVersion: "synthetic-suppression-v1", cursor: null });
    const key = `synthetic-j08-intake-${creator.key}-${campaign}`;
    const answer = await post("/v1/intake", { input, envelope: { jobId: "J01", jobVersion: "creator-intake.v1", mode: "observe", actor: { id: "synthetic-reviewer", role: "reviewer" },
      accountRef: { workspaceId: scope.workspaceId, accountId: scope.accountId }, policyVersion: "commission-only-v1", inputHash: digest(input), idempotencyKey: key,
      correlationId: `synthetic-j08-${creator.key}`, requestedAt: at, deadline: null, checkpoint: null } }, reviewerToken, { "Idempotency-Key": key });
    if (answer.status !== 200) throw new Error(`Synthetic intake failed: ${JSON.stringify(answer.body)}`);
    const record = (answer.body.data ?? answer.body) as { creatorRef?: { canonicalId?: string | null } };
    const creatorId = record.creatorRef?.canonicalId;
    if (!creatorId || ids.has(creator.key) && ids.get(creator.key) !== creatorId) throw new Error("Synthetic intake identity was not resolved to one creator.");
    ids.set(creator.key, creatorId);
  }
  return ids;
}

/** Fictional canonical order ledger rows: a post-level website order, a TikTok Shop order also imported into Shopify, and a creator-wide code. */
export function j08SandboxOrders(ids: Map<string, string>, scope: { accountId: string }, now: number): FunnelEvent[] {
  const ref = (source: string, id: string) => ({ source, accountId: scope.accountId, sourceId: id, canonicalId: id, identityState: "resolved" as const, provenanceRef: `synthetic:${source}:${id}`, url: null });
  const day = 86_400_000, order = (name: string, creator: string, campaign: string, opportunity: string, network: "instagram" | "tiktok", checkout: "website" | "tiktok-shop",
    orderId: string, postId: string | null, retainedMinor: number) => evt(name, "retainedOrder", opportunity, 5, {
    creatorRef: ref("notion", ids.get(creator)!), campaignCohortRef: ref("notion", campaign), sourceAccount: ref(checkout === "website" ? "shopify" : "tiktok-shop", "synthetic-checkout"),
    acquisitionRef: ref("social-cat", "synthetic-recruit-account"), network, checkout, cohortStart: new Date(now - 10 * day).toISOString(), maturationAt: new Date(now - day).toISOString(),
    occurredAt: new Date(now - 2 * day).toISOString(), observedAt: new Date(now - 2 * day + 60_000).toISOString(),
    evidenceRef: { provenanceRef: `synthetic-order-proof-${name}`, version: "1", method: "source read", access: "verified", url: null, definition: "synthetic retained order", unit: "order", window: "synthetic 7-day click window" },
    ingestIdentity: { nativeId: `synthetic-native-${name}`, fingerprint: null, sourceVersion: "1" },
    details: { orderId, ...(postId ? { postId } : {}), retainedMinor, currency: "USD", attributionVersion: "synthetic-attribution-v1", attributionWindow: "synthetic 7-day click window", blockers: [] } });
  return [
    order("order-a1", "a", "campaign-spring", "synthetic-opportunity-a", "instagram", "website", "synthetic-order-a1", "SYNTHA1", 4000),
    order("order-b1-tiktok", "b", "campaign-spring", "synthetic-opportunity-b", "tiktok", "tiktok-shop", "synthetic-order-b1", "7300000000000000001", 2500),
    order("order-b1-shopify-import", "b", "campaign-spring", "synthetic-opportunity-b", "tiktok", "website", "synthetic-order-b1", "7300000000000000001", 2500),
    order("order-e1-creator-code", "e", "campaign-autumn", "synthetic-opportunity-e", "instagram", "website", "synthetic-order-e1", null, 1800),
  ];
}
export async function ingestJ08Orders(post: Post, proofs: Map<string, string>, events: FunnelEvent[], now: number, reviewerToken: string) {
  for (const e of events) {
    const hash = digest(e); proofs.set(e.evidenceRef.provenanceRef, hash);
    const answer = await post("/v1/funnel/events", { event: e, jobId: "synthetic-order-sync", jobVersion: "v1", mode: "observe", actor: { id: "synthetic-order-sync", role: "observer" },
      accountRef: e.sourceAccount, policyVersion: e.policyOfferApprovalVersions.policy, inputHash: hash, idempotencyKey: e.eventId, correlationId: `synthetic-${e.eventId}`,
      requestedAt: new Date(now).toISOString(), deadline: null, checkpoint: null }, reviewerToken);
    if (answer.status !== 200) throw new Error(`Synthetic order ingest failed: ${JSON.stringify(answer.body)}`);
  }
}
