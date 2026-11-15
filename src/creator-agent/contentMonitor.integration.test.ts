// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { FunnelRepository } from "./funnelStore.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { runtimeSyntheticScope as scope } from "./jobs/runtime.testkit.ts";
import { runtimeApiAckSchema } from "./jobs/runtimeViews.ts";
import { nativeContentSchema, nativePostSchema, nativeRunSchema, nativeWatchlistSchema } from "./monitor/contract.ts";
import { reportEventSchema } from "./slackReporting/contract.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
import { createJ08SandboxRuntime, createJ08SandboxSource, createJ08SandboxWorld, ingestJ08Orders, j08SandboxOrders, j08SandboxPolicy, j08SandboxServerOptions,
  seedJ08Intake } from "./contentMonitor/sandbox.testkit.ts";
import type { J08Policy } from "./contentMonitor/contract.ts";

const machineToken = "synthetic-j08-runtime-worker-credential-0000";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
/** Past hourly slots on the real clock: J08 never runs ahead of the order ledger's own clock. */
const slot = (hoursAgo: number) => new Date((Math.floor(Date.now() / 3600_000) - hoursAgo) * 3600_000).toISOString();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const count = (app: ReturnType<typeof createAgentServer>, table: string) => Number(app.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

/** Actual agent service, real SQLite, real J01 intake, order ledger, J14 provider health and runtime routes, and the J08 sandbox source. */
async function sandbox(options: { failOnce?: boolean; maxItems?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "farda-j08-")), databasePath = join(directory, "agent.sqlite");
  const store = new AgentStore(databasePath, scope);
  const world = createJ08SandboxWorld(Date.now, Date.now());
  if (options.failOnce === false) world.failOnce.clear();
  let policy: J08Policy = structuredClone(j08SandboxPolicy);
  const suppressed = new Set<string>(), proofs = new Map<string, string>();
  const runtime = createJ08SandboxRuntime(store.database, { now: Date.now, maxItems: options.maxItems });
  await runtime.initialize();
  // No test holder: the server composes the J08 plan into the injected authority itself.
  const start = async () => {
    const server = createAgentServer(j08SandboxServerOptions({ databasePath, scope, readToken: reader, reviewToken: reviewer, machineToken, runtime, world, suppressed, proofs,
      policy: () => policy }));
    await new Promise<void>((resolve, reject) => { server.server.once("error", reject); server.server.listen(0, "127.0.0.1", resolve); });
    const address = server.server.address(); if (!address || typeof address === "string") throw new Error("Missing local test address");
    return { server, origin: `http://127.0.0.1:${address.port}` };
  };
  let { server: app, origin } = await start();
  closes.push(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  /** A process restart: the in-memory binding is discarded; only the shared SQLite file survives. */
  const restart = async () => { await app.close(); ({ server: app, origin } = await start()); };
  async function post(path: string, body: unknown, token = machineToken, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const ids = await seedJ08Intake(post, scope, reviewer);
  await ingestJ08Orders(post, proofs, j08SandboxOrders(ids, scope, Date.now()), Date.now(), reviewer);
  // J14 owns source health: its configured target must observe the J08 source before the runtime treats the binding as ready.
  const healthCheck = (eventId: string) => app.providerHealth.check({ capabilityId: app.contentMonitor!.capabilityId, eventId }, eventId);
  const observations = () => count(app, "health_observations");
  expect((await healthCheck("synthetic-initial-health")).health).toMatchObject({ state: "ready" });
  const machine = (operation: string, input: unknown) => post("/v1/runtime/machine", { operation, input });
  const fire = async (hoursAgo: number, trigger = `synthetic-hourly-${hoursAgo}`) => {
    const answer = await machine("fire", { registrationRef: runtime.registration.registrationRef, registrationVersion: 1, intendedAt: slot(hoursAgo), triggerEventRef: trigger });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return runtimeApiAckSchema.parse(answer.body).runRefs[0]!;
  };
  const recheck = async (trigger: string) => {
    const answer = await machine("fire", { registrationRef: runtime.manual.registrationRef, registrationVersion: 1, intendedAt: new Date(Date.now() - 1000).toISOString(), triggerEventRef: trigger });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return runtimeApiAckSchema.parse(answer.body).runRefs[0]!;
  };
  // The hourly driver's next pass drains the durable J14 outbox; `rawWork` omits it to model a crash or an unanswered pass.
  const rawWork = (runRef: string, maxItems = 10) => machine("work", { runRef, maxItems });
  const work = async (runRef: string, maxItems = 10) => { const answer = await rawWork(runRef, maxItems); await app.contentMonitor!.drainRoutes(); return answer; };
  const read = (viewKey: string, filters: Record<string, unknown> = {}) => post("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-j08-read",
    requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" }, viewKey, filters, period: null, sort: [],
    page: { limit: 100, cursor: null } }, reader);
  const latest = () => app.contentMonitor!.windows()[0]!.windowRef;
  const out = (windowRef = latest()) => app.contentMonitor!.output(windowRef);
  return { get app() { return app; }, get origin() { return origin; }, world, runtime, ids, suppressed, post, fire, recheck, work, rawWork, read, latest, out, machine, healthCheck,
    observations, restart, setPolicy: (next: J08Policy) => { policy = next; } };
}
type Sandbox = Awaited<ReturnType<typeof sandbox>>;
const content = async (s: Sandbox, filters: Record<string, unknown> = {}) => {
  const answer = await s.read("contentMonitor", filters);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return nativeContentSchema.parse(answer.body.data);
};
const hourly = async (s: Sandbox) => nativeRunSchema.parse((await s.read("hourlyRun", { runId: (await content(s)).latestRunRef })).body.data);
const sum = (c: { unchanged: number; newContent: number; inaccessible: number; deferred: number; failed: number }) => c.unchanged + c.newContent + c.inaccessible + c.deferred + c.failed;

// Each case drives the real HTTP service, SQLite, intake, order ledger, J14 and runtime; allow for shared CI runners.
describe("J08 hourly content and Inbox monitoring through the registered runtime (fixture stage, synthetic data)", { timeout: 30_000 }, () => {
  it("J08-10: runs a mixed Instagram/TikTok/Inbox sandbox with resume, unchanged counters, an ambiguous brand match and an inaccessible row", async () => {
    const s = await sandbox();
    const run1 = await s.fire(2);
    const w1 = await s.work(run1); expect(w1.status, JSON.stringify(w1.body)).toBe(200);
    // Interrupted: one TikTok page failed after its first page was confirmed. The window cannot claim no new content or all clear.
    let coverage = s.out().freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 5, deferred: 1, inaccessible: 0, failed: 0, complete: false, noNewContent: null, allClear: null });
    expect(sum(coverage)).toBe(coverage.snapshotCount);
    const confirmed = () => s.out().metricSnapshots.filter(m => m.contentRef.sourceId === "7300000000000000001");
    const beforeResume = confirmed();
    expect(beforeResume.length).toBeGreaterThan(0);
    expect(await hourly(s)).toMatchObject({ complete: false, counts: { deferred: 1, failed: 0, inaccessible: 0 } });
    // Resume from the runtime checkpoint: the confirmed first page is neither re-read nor duplicated.
    await pause(150);
    await s.work(run1);
    expect(s.world.reads.filter(r => r.subject.profile.accountId === "synthetic-tt-account-b" && r.stage === "posts" && r.cursor === null)).toHaveLength(1);
    expect(confirmed()).toEqual(beforeResume);
    coverage = s.out().freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 6, newContent: 6, deferred: 0, complete: true, noNewContent: false, allClear: true });
    expect(coverage.lastSourceSuccess).toBe([...s.out().rows.map(r => r.lastSuccessAt!)].sort()[0]);
    const watch = nativeWatchlistSchema.parse((await s.read("watchlist")).body.data);
    expect(watch).toMatchObject({ sourceState: "current", total: 6, active: 6, pending: 0, excluded: 0 });

    // Reproducible four-metric output. Instagram and TikTok view definitions differ, so the cross-network total stays unknown.
    const all = await content(s);
    expect(all).toMatchObject({ sourceState: "current", synthetic: true, total: 6, views: null, rate: null, orders: null, net: null });
    const a1 = all.posts.find(p => p.originalUrl?.includes("SYNTHA1"))!;
    const springInstagram = await content(s, { network: "instagram", campaign: a1.campaign });
    // All three posts' 168h attribution windows have matured: one order on A1, proven zero on A2 and the crosspost.
    expect(springInstagram).toMatchObject({ total: 3, views: 2000, orders: 1, net: { minorUnits: 4000, currency: "USD" },
      metricBasis: { definition: "Synthetic Instagram plays (native lifetime counter)", semantics: "cumulative", context: "organic" } });
    expect(springInstagram.rate).toBeCloseTo(7.7, 5);
    const tiktok = await content(s, { network: "tiktok" });
    expect(tiktok).toMatchObject({ total: 2, views: 5300, rate: null, orders: null, net: null });
    const b1 = tiktok.posts.find(p => p.originalUrl?.includes("7300000000000000001"))!;
    const b1Detail = nativePostSchema.parse((await s.read("postPerformance", { postId: b1.id })).body.data);
    // A TikTok Shop order imported into Shopify counts once; its post-less Shopify refund inherits the order's post.
    expect(b1Detail.post.attribution).toMatchObject({ level: "post", orders: 1, net: { minorUnits: 2000, currency: "USD" }, complete: true });
    // 192h is outside the 168h checkpoint tolerance: a labeled late observation that fills no checkpoint.
    expect(b1Detail.post.checkpointHours).toBeNull();
    expect(b1Detail.history.find(h => h.checkpoint)?.checkpoint).toMatchObject({ hours: 168, state: "late", version: "ticket-initial-checkpoints-v1" });
    expect(b1Detail.history.find(h => h.checkpoint)!.checkpoint!.actualAgeHours).toBeGreaterThan(180);
    const a2 = all.posts.find(p => p.originalUrl?.includes("SYNTHA2"))!;
    expect(a2).toMatchObject({ checkpointHours: 168, attribution: { level: "post", orders: 0, complete: true }, measurement: { views: 0, likes: 0 } });
    const d1 = all.posts.find(p => p.originalUrl?.includes("7300000000000000004"))!;
    // A 24-hour-old post with no order evidence is unknown, never a fabricated zero.
    expect(d1).toMatchObject({ checkpointHours: 24, attribution: null, creative: null });
    const crosspost = all.posts.find(p => p.originalUrl?.includes("SYNTHB1"))!;
    expect(crosspost.creative).toBe(b1.creative);
    expect(crosspost.id).not.toBe(b1.id);
    // Contracted creatives come from the ledger's verified publication records, counted once across the crosspost; D1 has none.
    expect(s.out().creatives).toEqual({ distinct: 4, mapped: 5, unmapped: 1 });
    expect(s.out().provenance.find(p => p.contentRef.sourceId === "7300000000000000004")).toMatchObject({ creative: null, unmappedReason: "NO_LEDGER_PUBLICATION_RECORD" });
    expect(all.posts.find(p => p.originalUrl?.includes("SYNTHE1"))!.attribution).toMatchObject({ level: "creator", orders: 1, net: { minorUnits: 1800, currency: "USD" } });
    // The ambiguous brand-only match and the unrelated post never enter Farda activity metrics.
    expect(all.posts.some(p => p.originalUrl?.includes("SYNTHC1"))).toBe(false);
    const queue = s.out().nextActionQueue;
    expect(queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "J09", reason: "ATTRIBUTION_BRAND_ONLY_CONCURRENT_CAMPAIGNS", itemRef: expect.objectContaining({ sourceId: "SYNTHC1" }) }),
      expect.objectContaining({ owner: "J09", reason: "INBOX_REPLY_REVIEW", itemRef: expect.objectContaining({ sourceId: "synthetic-message-a1" }) }),
    ]));

    // Next hour: unchanged counters, a confirmed private post and a denied row.
    s.world.access.set("synthetic-tt-account-d", "denied");
    s.world.privatePosts.add("SYNTHA2");
    const [metricsBefore, contentBefore, proposalsBefore] = [count(s.app, "content_monitor_metrics"), count(s.app, "content_monitor_content"), count(s.app, "content_monitor_proposals")];
    const run2 = await s.fire(1);
    await s.work(run2);
    coverage = s.out().freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 5, unchanged: 5, newContent: 0, inaccessible: 1, deferred: 0, failed: 0, complete: false, noNewContent: null, allClear: null });
    // m8: a denied row is held, not re-read, by later work calls in the same run.
    const deniedReads = () => s.world.reads.filter(r => r.subject.profile.accountId === "synthetic-tt-account-d").length;
    const readsBefore = deniedReads();
    await s.work(run2);
    await s.work(run2);
    expect(deniedReads()).toBe(readsBefore);
    expect(count(s.app, "content_monitor_metrics")).toBe(metricsBefore);
    expect(count(s.app, "content_monitor_content")).toBe(contentBefore);
    // Proposals are immutable per-window output: only the new private status adds one.
    expect(count(s.app, "content_monitor_proposals")).toBe(proposalsBefore + 1);
    expect(s.out().nextActionQueue).toEqual(expect.arrayContaining([expect.objectContaining({ owner: "J09", reason: "CONTENT_PRIVATE" }),
      expect.objectContaining({ owner: "J14", reason: "SOURCE_DENIED", route: "J14_OBSERVED" })]));
    const run = await hourly(s);
    expect(run).toMatchObject({ complete: false, counts: { changed: 0, unchanged: 5, inaccessible: 1, failed: 0, deferred: 0 }, schedule: "disabled", nextRun: null });
    const denied = run.checks.find(c => c.state === "inaccessible")!;
    // Source freshness: the failed read's time and the last source success are separate source watermarks.
    expect(denied.access).toBe("denied");
    expect(Date.parse(denied.lastSuccessAt!)).toBeLessThan(Date.parse(denied.at!));
    const after = await content(s);
    expect(after.sourceState).toBe("partial");
    const dAfter = after.posts.find(p => p.originalUrl?.includes("7300000000000000004"))!;
    expect(dAfter).toMatchObject({ visibility: "inaccessible", access: "denied", measurement: { views: 300 } });
    const dDetail = nativePostSchema.parse((await s.read("postPerformance", { postId: dAfter.id })).body.data);
    expect(dDetail.publicationHistory.some(h => h.state === "public")).toBe(true);
    expect(after.posts.find(p => p.originalUrl?.includes("SYNTHA2"))).toMatchObject({ visibility: "private", access: "authorized", measurement: { views: 0, likes: 0 } });
    // n8: unchanged counters advance their confirmation time, visible as data on the post's latest measurement.
    const a1After = after.posts.find(p => p.originalUrl?.includes("SYNTHA1"))!.measurement!;
    expect(Date.parse(a1After.confirmedThrough!)).toBeGreaterThan(Date.parse(a1After.at));
    const trace = s.app.contentMonitor!.trace(s.latest(), "synthetic-j08-trace-key-000000000000"), text = JSON.stringify(trace);
    for (const raw of ["synthetic-tt-account-d", "7300000000000000004", "SYNTHA2", s.ids.get("d")!]) expect(text).not.toContain(raw);
    expect(trace).toMatchObject({ evidenceStage: "synthetic", freshnessCoverage: { snapshotCount: 6, inaccessible: 1 } });
    // The earlier complete window keeps its own result; a later condition is not back-dated into it.
    expect(s.app.contentMonitor!.output(s.app.contentMonitor!.windows()[1]!.windowRef).freshnessCoverage).toMatchObject({ complete: true });
    // Every browser response stays aliased: no raw account, post, profile, message or canonical creator ID.
    const browser = JSON.stringify([all, after, run, b1Detail, dDetail, (await s.read("watchlist")).body], (key, value) => key === "originalUrl" ? null : value);
    for (const raw of ["synthetic-ig-account-a", "synthetic-tt-account-b", "synthetic-ig-profile-a", "SYNTHA1", "7300000000000000001", "synthetic-message-a1",
      "synthetic-conversation-a", ...s.ids.values()]) expect(browser).not.toContain(raw);
  });

  it("B1: composes the J08 plan into the injected runtime authority and refuses a substituted membership", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(1));
    const watch = s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_watchlists").get()!.n;
    expect(watch).toBe(1);
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 6, complete: true });
    s.runtime.state.ignoreMembership = true;
    const answer = await s.machine("fire", { registrationRef: s.runtime.registration.registrationRef, registrationVersion: 1, intendedAt: slot(0), triggerEventRef: "synthetic-substitute" });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(s.app.store.database.prepare("SELECT COUNT(*) AS n FROM job_runtime_pages WHERE json_extract(plan,'$.window.intendedAt')=?").get(slot(0))!.n).toBe(0);
    // n7: a refused admission freezes nothing, so a later suppression is honoured when the window is finally admitted.
    expect(count(s.app, "content_monitor_watchlists")).toBe(1);
    s.suppressed.add(s.ids.get("a")!);
    s.runtime.state.ignoreMembership = false;
    await s.work(await s.fire(0, "synthetic-after-refusal"));
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 5, complete: true });
  });

  it("B2: a multi-page window freezes one watchlist, defers unadmitted rows and completes across pages", async () => {
    const s = await sandbox({ failOnce: false, maxItems: 4 });
    const first = await s.fire(1);
    await s.work(first);
    let coverage = s.out().freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 4, deferred: 2, complete: false, noNewContent: null, allClear: null });
    expect(s.out().rows.filter(r => r.state === "notAdmitted")).toHaveLength(2);
    const next = await s.machine("continue", { runRef: first });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    await s.work(runtimeApiAckSchema.parse(next.body).runRefs[0]!);
    coverage = s.out().freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 6, newContent: 6, complete: true, allClear: true });
    expect((await hourly(s))).toMatchObject({ snapshotSize: 6, complete: true, counts: { changed: 6 } });
  });

  it("N3: a denied row completes with an explicit inaccessible outcome, so later pages of the window are still read", async () => {
    const s = await sandbox({ failOnce: false, maxItems: 4 });
    const first = await s.fire(1);
    const pageOne = s.app.contentMonitor!.coverage(s.latest()).rows.filter(r => r.runRef);
    s.world.access.set(s.app.contentMonitor!.subject(pageOne[0]!.subjectRef)!.accountId, "denied");
    await s.work(first);
    const next = await s.machine("continue", { runRef: first });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    await s.work(runtimeApiAckSchema.parse(next.body).runRefs[0]!);
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 6, scanned: 5, inaccessible: 1, deferred: 0, complete: false, allClear: null });
    expect(s.out().rows.find(r => r.category === "inaccessible")).toMatchObject({ state: "completed", reason: "SOURCE_DENIED" });
    // The runtime's own step evidence carries the denial, so runtime views never read it as a plain success.
    const steps = s.app.store.database.prepare("SELECT body FROM job_runtime_steps").all().map(r => JSON.parse(String(r.body)) as { step: { evidenceRefs?: string[] } });
    expect(steps.filter(b => b.step.evidenceRefs?.includes("j08-inaccessible:SOURCE_DENIED"))).toHaveLength(1);
    // Before page two is admitted, its rows are deferred and say why.
    const later = await sandbox({ failOnce: false, maxItems: 4 });
    await later.work(await later.fire(1), 2);
    expect(later.out().rows.filter(r => r.state === "notAdmitted").every(r => r.reason === "J08_PRIOR_PAGE_INCOMPLETE")).toBe(true);
  });

  it("N1: J14 routing is a durable outbox that survives a restart before routing and retries a failed call, reaching J14 once", async () => {
    const s = await sandbox({ failOnce: false });
    s.world.access.set("synthetic-tt-account-d", "denied");
    // J14 cannot be reached while the failure is recorded, and the process then dies before any later pass.
    const before = s.app, original = before.providerHealth.check;
    before.providerHealth.check = async () => { throw new Error("synthetic J14 outage"); };
    const run = await s.fire(1);
    await s.rawWork(run);
    expect(s.observations()).toBe(1);
    expect(s.out().nextActionQueue.filter(a => a.owner === "J14")).toEqual([expect.objectContaining({ reason: "SOURCE_DENIED", route: null })]);
    before.providerHealth.check = original;
    // Restart: the failure row is already persisted, so the next pass on a fresh process routes it exactly once.
    await s.restart();
    await s.rawWork(run);
    expect(s.observations()).toBe(2);
    expect(s.out().nextActionQueue).toEqual(expect.arrayContaining([expect.objectContaining({ owner: "J14", reason: "SOURCE_DENIED", route: "J14_OBSERVED" })]));
    await s.rawWork(run);
    expect(s.observations()).toBe(2);
    // A routing call that throws is retried on the next pass instead of being recorded as final.
    const app = s.app, check = app.providerHealth.check;
    s.world.access.set("synthetic-ig-account-e", "denied");
    app.providerHealth.check = async () => { throw new Error("synthetic J14 outage"); };
    await s.rawWork(await s.fire(0));
    expect(s.out().nextActionQueue.filter(a => a.owner === "J14").some(a => "route" in a && a.route === null)).toBe(true);
    app.providerHealth.check = check;
    await s.rawWork(await s.fire(0));
    expect(s.out().nextActionQueue.filter(a => a.owner === "J14").map(a => "route" in a ? a.route : null)).toEqual(["J14_OBSERVED", "J14_OBSERVED"]);
    expect(s.observations()).toBe(3);
  });

  it("N1-a/N1-b: a held J14 answer stays in the outbox, and the outbox drains even while J08 activation is revoked", async () => {
    const s = await sandbox({ failOnce: false });
    s.world.access.set("synthetic-tt-account-d", "denied");
    const app = s.app, check = app.providerHealth.check;
    app.providerHealth.check = async () => ({ state: "held" as const, runId: "synthetic-held-run", observationId: null, health: null, blockers: ["JOB_NOT_ACTIVATED"] });
    const run = await s.fire(1);
    await s.rawWork(run);
    await s.rawWork(run);
    expect(s.out().nextActionQueue.filter(a => a.owner === "J14").map(a => "route" in a ? a.route : null)).toEqual(["J14_HELD"]);
    expect(s.observations()).toBe(1);
    app.providerHealth.check = check;
    // Activation is revoked: J08 admits nothing, yet the trigger's activation step still drains the outbox to J14.
    s.runtime.kit.state.active = false;
    expect((await s.rawWork(run)).status).toBeGreaterThanOrEqual(400);
    expect(s.out().nextActionQueue.filter(a => a.owner === "J14").map(a => "route" in a ? a.route : null)).toEqual(["J14_OBSERVED"]);
    expect(s.observations()).toBe(2);
  });

  it("M1-a: rows denied on their first read and then suppressed still prevent all clear", async () => {
    const s = await sandbox({ failOnce: false });
    for (const account of ["synthetic-ig-account-a", "synthetic-tt-account-d", "synthetic-ig-account-e"]) s.world.access.set(account, "denied");
    await s.work(await s.fire(1));
    expect(s.out().freshnessCoverage).toMatchObject({ inaccessible: 3 });
    expect(count(s.app, "content_monitor_content WHERE subject_ref IN (SELECT subject_ref FROM content_monitor_items WHERE failure_at IS NOT NULL)")).toBe(0);
    for (const key of ["a", "d", "e"]) s.suppressed.add(s.ids.get(key)!);
    await s.work(await s.fire(0));
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 3, complete: true, noNewContent: true, allClear: false });
  });

  it("reads the funnel ledger once per runtime run, not once per page", async () => {
    const s = await sandbox({ failOnce: false });
    const spy = vi.spyOn(FunnelRepository.prototype, "snapshot");
    try {
      await s.rawWork(await s.fire(1));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it("n6: a J08 success counts only when the runtime committed its item", async () => {
    const s = await sandbox({ failOnce: false });
    // Activation is revoked after J08's completion write commits but before the runtime commits the item.
    s.world.onInboxFence = () => { s.runtime.kit.state.active = false; };
    const run = await s.fire(1);
    expect((await s.work(run)).status).toBeGreaterThanOrEqual(400);
    const held = s.out().rows.filter(r => r.state !== "queued" && r.state !== "notAdmitted");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ category: "deferred", lastSuccessAt: null });
    expect(s.out().freshnessCoverage).toMatchObject({ scanned: 0, lastSourceSuccess: null, complete: false });
  });

  it("J08-02: a budget-limited pass leaves due rows deferred and cannot claim no new content or all clear", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(1), 2);
    const coverage = s.out().freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 2, deferred: 4, complete: false, noNewContent: null, allClear: null, lastSourceSuccess: null });
    expect(sum(coverage)).toBe(6);
    const run = await hourly(s);
    expect(run).toMatchObject({ complete: false, snapshotSize: 6, counts: { changed: 2, deferred: 4 } });
    expect(run.checks.filter(c => c.state === "deferred").every(c => c.at === null && c.reason === "Due but not yet visited in this run.")).toBe(true);
    expect((await content(s)).sourceState).toBe("partial");
  });

  it("J08-01: overlapping triggers share one snapshot and one account lease; a bounded manual recheck re-reads", async () => {
    const s = await sandbox({ failOnce: false });
    const hourlyRun = await s.fire(1, "synthetic-hourly-trigger");
    await s.fire(1, "synthetic-duplicate-trigger");
    const pages = () => s.app.store.database.prepare("SELECT COUNT(DISTINCT run_ref) AS runs FROM job_runtime_pages WHERE registration_ref='synthetic-j08'").get();
    expect(pages()).toEqual({ runs: 1 });
    const [left, right] = await Promise.all([s.work(hourlyRun), s.work(hourlyRun)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    await s.work(hourlyRun);
    const keys = s.world.reads.map(r => JSON.stringify([r.window.windowRef, r.subject.profile.accountId, r.stage, r.cursor]));
    expect(new Set(keys).size).toBe(keys.length);
    const reads = s.world.reads.length;
    await s.work(hourlyRun);
    expect(s.world.reads).toHaveLength(reads);
    // A manual recheck is its own bounded window on the same source binding, so it re-reads and reports unchanged rows.
    const manual = await s.recheck("synthetic-manual-recheck");
    await s.work(manual);
    expect(s.world.reads.length).toBeGreaterThan(reads);
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 6, unchanged: 6, newContent: 0, complete: true, noNewContent: true });
  });

  it("J08-09: policy, suppression and schedule changes act before the next item; prior observations remain", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(3));
    // A changed policy (same version, different checkpoints) holds every remaining item without a source call.
    const run2 = await s.fire(2), reads = s.world.reads.length;
    s.setPolicy({ ...j08SandboxPolicy, checkpoints: { ...j08SandboxPolicy.checkpoints, slots: [{ hours: 48, toleranceHours: 2 }] } });
    await s.work(run2);
    expect(s.world.reads).toHaveLength(reads);
    expect(s.out().rows.every(r => r.reason === "J08_POLICY_VERSION_CHANGED")).toBe(true);
    expect(s.out().freshnessCoverage).toMatchObject({ deferred: 6, complete: false });
    // A new window cannot start under an unpinned policy.
    expect((await s.machine("fire", { registrationRef: "synthetic-j08", registrationVersion: 1, intendedAt: slot(1), triggerEventRef: "synthetic-unpinned" })).status).toBeGreaterThanOrEqual(400);
    s.setPolicy(j08SandboxPolicy);
    // Suppression after the snapshot is frozen holds that row only; its earlier posts stay reconcilable.
    const run3 = await s.fire(1);
    s.suppressed.add(s.ids.get("a")!);
    await s.work(run3);
    const output = s.out();
    expect(output.rows.filter(r => r.reason === "J08_ENROLLMENT_CHANGED")).toHaveLength(1);
    expect(output.freshnessCoverage).toMatchObject({ snapshotCount: 6, scanned: 5, deferred: 1, complete: false });
    expect((await content(s)).posts.filter(p => p.originalUrl?.includes("SYNTHA"))).toHaveLength(2);
    // A disabled schedule (revoked activation) stops work before any source call.
    const run4 = await s.fire(0), held = s.world.reads.length;
    s.runtime.kit.state.active = false;
    expect((await s.work(run4)).status).toBeGreaterThanOrEqual(400);
    expect(s.world.reads).toHaveLength(held);
  });

  it("M1/M6: a denied row stays inaccessible until a later healthy read, never cleared by unbinding, and all clear counts it", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(3));
    s.world.access.set("synthetic-tt-account-d", "denied");
    await s.work(await s.fire(2));
    // Unbinding: the creator leaves the watchlist. The window is complete, but the open condition still prevents all clear.
    s.suppressed.add(s.ids.get("d")!);
    await s.work(await s.fire(1));
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 5, complete: true, allClear: false });
    expect((await content(s)).posts.find(p => p.originalUrl?.includes("7300000000000000004"))).toMatchObject({ visibility: "inaccessible", access: "denied" });
    // A later complete, healthy read of the same row clears it.
    s.suppressed.delete(s.ids.get("d")!);
    s.world.access.delete("synthetic-tt-account-d");
    await s.work(await s.fire(0));
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 6, complete: true, allClear: true, noNewContent: true });
    expect((await content(s)).posts.find(p => p.originalUrl?.includes("7300000000000000004"))).toMatchObject({ visibility: "public", access: "authorized" });
    expect(count(s.app, "sqlite_master WHERE name='content_monitor_incidents'")).toBe(0);
  });

  it("M6: a source login wall opens one runtime takeover and one J14 observation, holds the rest unread, and clears only through the owners", async () => {
    const s = await sandbox({ failOnce: false });
    const observations = () => count(s.app, "health_observations");
    expect(observations()).toBe(1);
    s.world.session = "loginRequired";
    const run = await s.fire(1);
    await s.work(run);
    await s.work(run);
    // One read hit the wall; J14 observed the source once and now holds the binding, so no other row is read.
    expect(s.world.reads).toHaveLength(1);
    expect(count(s.app, "job_runtime_takeovers")).toBe(1);
    expect(observations()).toBe(2);
    expect(s.app.providerHealth.exceptions(s.app.contentMonitor!.capabilityId, 10).records.some(e => e.state === "open")).toBe(true);
    expect(s.out().freshnessCoverage).toMatchObject({ inaccessible: 1, deferred: 5, complete: false, allClear: null });
    expect(count(s.app, "sqlite_master WHERE name LIKE 'content_monitor_incident%' OR name LIKE 'content_monitor_action%'")).toBe(0);
    // J08 cannot clear the wall itself: the session must recover, J14 must re-observe, and the takeover owner must resolve the takeover.
    s.world.session = "ok";
    await s.work(run);
    expect(s.world.reads).toHaveLength(1);
    expect((await s.healthCheck("synthetic-owner-recheck")).health).toMatchObject({ state: "ready" });
    const held = s.app.contentMonitor!.coverage(s.latest()).rows.find(r => r.category === "inaccessible")!;
    const resolved = await s.machine("takeover", { runRef: held.runRef, itemRef: held.item!.itemId, expectedVersion: 1, receiptRef: "receipt:synthetic-takeover-resolution",
      requestKey: "synthetic-takeover-request" });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    await s.work(run);
    expect(s.out().freshnessCoverage).toMatchObject({ snapshotCount: 6, complete: true, allClear: true });
    expect(s.app.providerHealth.exceptions(s.app.contentMonitor!.capabilityId, 10).records.every(e => e.state !== "open")).toBe(true);
  });

  it("J08-03: identity stays stable when source values change, and an older page never overwrites newer facts", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(2));
    const first = (await content(s)).posts.find(p => p.originalUrl?.includes("SYNTHA1"))!, statusBefore = count(s.app, "content_monitor_status");
    expect(statusBefore).toBe(7);
    s.world.urlOverride.set("SYNTHA1", "https://instagram.com/p/SYNTHA1/");
    await s.work(await s.fire(1));
    expect((await content(s)).posts.find(p => p.id === first.id)!.originalUrl).toBe("https://instagram.com/p/SYNTHA1/");
    expect((await content(s)).total).toBe(6);
    expect(count(s.app, "content_monitor_status")).toBe(statusBefore);
    expect(s.out().freshnessCoverage).toMatchObject({ unchanged: 6, newContent: 0, noNewContent: true });
  });

  it("M2/m5: lifecycle follows the page's own observation time, and an older page never overwrites newer facts", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(3));
    // The post's own read is denied while the profile stays readable.
    s.world.postDenied.add("SYNTHA1");
    await s.work(await s.fire(2));
    const id = (await content(s)).posts.find(p => p.originalUrl?.includes("SYNTHA1"))!.id;
    expect(nativePostSchema.parse((await s.read("postPerformance", { postId: id })).body.data).post).toMatchObject({ visibility: "inaccessible" });
    // N2: the profile read completed, but an inaccessible post still prevents all clear.
    expect(s.out().freshnessCoverage).toMatchObject({ complete: true, noNewContent: true, allClear: false });
    // It returns with a source edit time older than the denial: the page's newer observation still clears it; the edit time stays data.
    s.world.postDenied.clear();
    s.world.sourceUpdatedAt.set("SYNTHA1", new Date(Date.now() - 30 * 86_400_000).toISOString());
    await s.work(await s.fire(1));
    expect(nativePostSchema.parse((await s.read("postPerformance", { postId: id })).body.data).post).toMatchObject({ visibility: "public", access: "authorized" });
    expect(s.out().freshnessCoverage).toMatchObject({ complete: true, allClear: true });
    expect(s.out().statusObservations.find(o => o.ref.sourceId === "SYNTHA1")).toMatchObject({ method: "native-api", value: { visibility: "public" },
      sourceUpdatedAt: s.world.sourceUpdatedAt.get("SYNTHA1") });
    // An older replayed page inside the lease cannot change the URL or status that a newer page recorded.
    s.world.urlOverride.set("SYNTHA1", "https://instagram.com/p/SYNTHA1/");
    s.world.privatePosts.add("SYNTHA1");
    s.world.observedShiftMs = -10 * 60_000;
    await s.work(await s.fire(0));
    const post = nativePostSchema.parse((await s.read("postPerformance", { postId: id })).body.data).post;
    expect(post).toMatchObject({ visibility: "public", originalUrl: "https://www.instagram.com/reel/SYNTHA1/" });
  });

  it("M3: content first seen while a row's read failed is new on the row's next complete read", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(2));
    s.world.extraPosts.set("synthetic-ig-account-e", [{ id: "SYNTHE2", account: "synthetic-ig-account-e", network: "instagram", ageHours: 1, creative: null, url: null,
      evidence: [{ kind: "productLink", campaignId: "campaign-autumn", reviewed: true, receiptRef: "synthetic-link-review-e2" }], counts: { views: 1 } }]);
    s.world.inboxDenied = "synthetic-ig-account-e";
    await s.work(await s.fire(1));
    expect(s.out().rows.find(r => r.category === "inaccessible")).toBeTruthy();
    s.world.inboxDenied = null;
    await s.work(await s.fire(0));
    expect(s.out().freshnessCoverage).toMatchObject({ complete: true, newContent: 1, noNewContent: false });
  });

  it("refuses cross-account, wrong-stage and reused-receipt evidence before any write, and stays read-only", async () => {
    const s = await sandbox({ failOnce: false });
    s.world.crossAccount = true;
    expect((await s.work(await s.fire(3))).body).toMatchObject({ code: expect.stringMatching(/J08_CROSS_ACCOUNT_PAYLOAD|SOURCE_HELD/) });
    expect(count(s.app, "content_monitor_content")).toBe(0);
    s.world.crossAccount = false;
    s.world.stage = "source";
    await s.work(await s.fire(2));
    expect(count(s.app, "content_monitor_content")).toBe(0);
    s.world.stage = "synthetic";
    s.world.fixedReceipt = "synthetic-reused-receipt";
    await s.work(await s.fire(1));
    expect(count(s.app, "content_monitor_pages WHERE receipt_ref='synthetic-reused-receipt'")).toBe(1);
    expect(s.out().rows.filter(r => r.reason === "J08_SOURCE_RECEIPT_REUSED").length).toBeGreaterThan(0);
    s.world.fixedReceipt = null;
    s.world.throwStatus = 403;
    const pagesBefore = count(s.app, "content_monitor_pages");
    expect((await s.work(await s.fire(0))).body).toMatchObject({ code: "SOURCE_SCOPE_DENIED" });
    expect(count(s.app, "content_monitor_pages")).toBe(pagesBefore);
    // J08 makes read requests only: no request carries a send, like, follow, term, rate or approval instruction.
    for (const r of s.world.reads) expect(Object.keys(r).sort()).toEqual(["cursor", "eligibilityPolicyVersion", "maxRecords", "policyVersion", "priorObservationRefs",
      "registrationRef", "registrationVersion", "scope", "stage", "subject", "watchlistVersion", "window"]);
    const tables = s.app.store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_scope' AND (name LIKE 'approval%' OR name LIKE 'job_dispatch%' OR name LIKE 'action_%')").all();
    expect(tables.length).toBeGreaterThan(5);
    for (const t of tables) expect(count(s.app, String(t.name))).toBe(0);
  });

  it("J08-07: throttling and UI drift preserve confirmed evidence, expose missing coverage and assign recovery owners", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(2));
    const before = (await content(s)).posts.map(p => [p.id, p.measurement?.views]);
    s.world.access.set("synthetic-tt-account-b", "throttled");
    const run = await s.fire(1);
    for (let attempt = 0; attempt < 4; attempt++) { await s.work(run); await pause(150); }
    const output = s.out();
    expect(output.freshnessCoverage).toMatchObject({ snapshotCount: 6, failed: 1, unchanged: 5, complete: false, noNewContent: null, allClear: null });
    expect(output.rows.find(r => r.category === "failed")?.reason).toBe("SOURCE_THROTTLED");
    expect((await content(s)).posts.map(p => [p.id, p.measurement?.views])).toEqual(before);
    s.world.access.clear();
    s.world.session = "uiDrift";
    await s.work(await s.fire(0));
    expect(s.out().freshnessCoverage).toMatchObject({ failed: 1, deferred: 5 });
    const run0 = await hourly(s);
    expect(run0.checks.find(c => c.state === "failed")).toMatchObject({ owner: expect.stringMatching(/^owner-/), reason: expect.stringContaining("SOURCE_UI_DRIFT") });
  });

  it("emits a typed report for a window that needs review, with aliases only", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(2));
    const binding = { producerRef: "synthetic-j08-producer", link: { kind: "linear" as const, workspaceSlug: "synthetic", issueIdentifier: "EXAMPLE-8", authorizationRef: "synthetic-evidence" } };
    const reportOne = s.app.contentMonitor!.report(s.latest(), binding);
    expect(reportOne).toMatchObject({ severity: "orange", subject: { kind: "aggregate", category: "content" }, nextAction: "reviewContent",
      facts: [{ label: "coverage", value: "complete" }, { label: "pendingItems", value: 0 }, { label: "records", value: 2 }] });
    s.world.access.set("synthetic-tt-account-d", "denied");
    await s.work(await s.fire(1));
    const reportTwo = s.app.contentMonitor!.report(s.latest(), binding)!;
    expect(reportEventSchema.parse(reportTwo)).toMatchObject({ nextAction: "reviewSource", facts: [{ label: "coverage", value: "partial" }, { label: "pendingItems", value: 1 }, { label: "records" }] });
    for (const raw of ["synthetic-tt-account-d", "7300000000000000004", s.ids.get("d")!]) expect(JSON.stringify(reportTwo)).not.toContain(raw);
    s.world.access.clear();
    await s.work(await s.fire(0));
    expect(s.app.contentMonitor!.report(s.latest(), binding)).toBeNull();
  });

  it("keeps synthetic fixtures out of production executors", async () => {
    const root = join(import.meta.dirname, "..", "..");
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toMatch(/^\*\*\/\*\.testkit\.ts$/m);
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files.push(path); } };
    walk(join(root, "src")); walk(join(root, "tools"));
    const production = files.filter(f => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.|\.testkit\.ts$|testFixtures\.ts$/.test(f));
    expect(production.filter(f => readFileSync(f, "utf8").includes("sandbox.testkit"))).toEqual([]);
    const { loadCreatorSourceRuntime } = await import("./sourceRuntime.ts");
    expect(loadCreatorSourceRuntime({}, { workspaceId: scope.workspaceId, accountId: scope.accountId })).not.toHaveProperty("contentMonitor");
  });

  it("reports sandbox capability truthfully and refuses ambiguous or invalid composition", async () => {
    const s = await sandbox({ failOnce: false });
    const capabilities = await (await fetch(`${s.origin}/v1/capabilities`, { headers: { authorization: "Bearer " + reader } })).json();
    expect(capabilities.contentMonitor).toMatchObject({ sourceAuthority: "j08-store", sourceExecution: "sandbox", evidenceStage: "synthetic",
      followUpProposals: "recorded-run-output-no-owner", sourceHealth: "routed-to-j14", outboundActions: "none", retryAuthority: "notConnected" });
    expect(JSON.stringify(capabilities.contentMonitor)).not.toContain("connected\"");
    const base: AgentServerOptions = { databasePath: ":memory:", workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: reader, reviewToken: reviewer };
    const binding = { registrationRef: "synthetic-j08", policy: () => j08SandboxPolicy, source: createJ08SandboxSource(s.world), evidenceStage: "synthetic" as const };
    expect(() => createAgentServer({ ...base, contentMonitor: binding, monitorSource: { read: async () => null, assertCurrent: () => {} } })).toThrow("One content monitor source owner");
    expect(() => createAgentServer({ ...base, contentMonitor: binding })).toThrow("J08_REGISTRATION_INVALID");
    const registry = { registrations: s.runtime.registrations, executors: new Map() };
    expect(() => createAgentServer({ ...base, runtime: { registry }, contentMonitor: { ...binding, policy: () => ({ ...j08SandboxPolicy, version: "other" }) } }))
      .toThrow("J08_POLICY_VERSION_MISMATCH");
    // A source-stage binding refuses an unapproved policy.
    expect(() => createAgentServer({ ...base, runtime: { registry }, contentMonitor: { ...binding, evidenceStage: "source" } })).toThrow("J08_POLICY_UNAPPROVED");
  });
});
