// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { digest } from "./config.ts";
import { runtimeSyntheticScope as scope } from "./jobs/runtime.testkit.ts";
import { runtimeApiAckSchema } from "./jobs/runtimeViews.ts";
import { nativeContentSchema, nativePostSchema, nativeRunSchema, nativeWatchlistSchema } from "./monitor/contract.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
import { createJ08SandboxRuntime, createJ08SandboxSource, createJ08SandboxWorld, ingestJ08Orders, j08SandboxIntakeAuthority, j08SandboxOrders, j08SandboxPolicy,
  seedJ08Intake } from "./contentMonitor/sandbox.testkit.ts";
import type { J08Policy } from "./contentMonitor/contract.ts";

const runtimeToken = "synthetic-j08-runtime-worker-credential-0000";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const hour = (h: number) => `2026-11-07T${String(h).padStart(2, "0")}:00:00.000Z`;

/** Actual agent service, real SQLite, real J01 intake and order ledger routes, the registered runtime and the J08 sandbox source. */
async function sandbox(options: { failOnce?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "farda-j08-")), databasePath = join(directory, "agent.sqlite");
  const store = new AgentStore(databasePath, scope);
  let time = Date.parse("2026-11-07T11:05:00Z");
  const now = () => time, world = createJ08SandboxWorld(now, Date.parse(hour(11)));
  if (options.failOnce === false) world.failOnce.clear();
  let policy: J08Policy = structuredClone(j08SandboxPolicy);
  const suppressed = new Set<string>(), proofs = new Map<string, string>();
  const holder: { app?: ReturnType<typeof createAgentServer> } = {};
  const runtime = createJ08SandboxRuntime(store.database, { now, plan: () => holder.app!.contentMonitor!.plan });
  await runtime.kit.initialize();
  const at = () => new Date(now()).toISOString(), until = () => new Date(now() + 60_000).toISOString();
  const serverOptions: AgentServerOptions = { databasePath, workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: reader, reviewToken: reviewer,
    operations: { now }, intakeAuthority: j08SandboxIntakeAuthority(suppressed),
    funnelAuthority: { resolve: async (s, _request, ref) => proofs.has(ref) ? { ...s, eventHash: proofs.get(ref)! } : null },
    runtime: { registry: { registrations: runtime.kit.registry.registrations, executors: new Map() }, authority: runtime.authority,
      machine: { token: runtimeToken, workerRef: runtime.kit.machine.workerRef,
        resolve: async (s, operation, input) => ({ scope: s, workerRef: runtime.kit.machine.workerRef, operation, inputHash: digest(input), proofRef: "synthetic-machine-proof", observedAt: at(), validUntil: until() }),
        assertCurrent: () => {} } },
    contentMonitor: { registrationRef: runtime.registration.registrationRef, policy: () => policy, source: createJ08SandboxSource(world), evidenceStage: "synthetic" } };
  const server = createAgentServer(serverOptions);
  holder.app = server;
  await new Promise<void>((resolve, reject) => { server.server.once("error", reject); server.server.listen(0, "127.0.0.1", resolve); });
  const address = server.server.address(); if (!address || typeof address === "string") throw new Error("Missing local test address");
  const origin = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  async function post(path: string, body: unknown, token = runtimeToken, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const ids = await seedJ08Intake(post, scope, reviewer);
  await ingestJ08Orders(post, proofs, j08SandboxOrders(ids, scope, now()), now(), reviewer);
  const machine = (operation: string, input: unknown) => post("/v1/runtime/machine", { operation, input });
  const fire = async (h: number, trigger = `synthetic-hourly-${h}`) => {
    const answer = await machine("fire", { registrationRef: runtime.registration.registrationRef, registrationVersion: runtime.registration.version, intendedAt: hour(h), triggerEventRef: trigger });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return runtimeApiAckSchema.parse(answer.body).runRefs[0]!;
  };
  const work = (runRef: string, maxItems = 10) => machine("work", { runRef, maxItems });
  const read = async (viewKey: string, filters: Record<string, unknown> = {}) => {
    const answer = await post("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-j08-read",
      requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" }, viewKey, filters, period: null, sort: [],
      page: { limit: 100, cursor: null } }, reader);
    return answer;
  };
  const advanceTo = async (iso: string) => { time = Date.parse(iso); await runtime.kit.verify("api"); };
  const latestRun = () => server.contentMonitor!.runs()[0]!;
  return { app: server, world, runtime, ids, suppressed, now, fire, work, read, advanceTo, latestRun, machine, post,
    setPolicy: (next: J08Policy) => { policy = next; } };
}
const content = async (s: Awaited<ReturnType<typeof sandbox>>, filters: Record<string, unknown> = {}) => {
  const answer = await s.read("contentMonitor", filters);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return nativeContentSchema.parse(answer.body.data);
};

describe("J08 hourly content and Inbox monitoring through the registered runtime (fixture stage, synthetic data)", () => {
  it("J08-10: runs a mixed Instagram/TikTok/Inbox sandbox with resume, unchanged counters, an ambiguous brand match and an inaccessible row", async () => {
    const s = await sandbox();
    const run1 = await s.fire(11);
    const first = await s.work(run1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const raw1 = s.latestRun();
    // Interrupted: one TikTok page failed after its first page was confirmed. The run cannot claim no new content or all clear.
    let coverage = s.app.contentMonitor!.output(raw1).freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 5, deferred: 1, inaccessible: 0, failed: 0, complete: false, noNewContent: null, allClear: null });
    expect(coverage.unchanged + coverage.newContent + coverage.inaccessible + coverage.deferred + coverage.failed).toBe(coverage.snapshotCount);
    const confirmedBeforeResume = s.app.contentMonitor!.output(raw1).metricSnapshots.filter(m => m.contentRef.sourceId === "7300000000000000001");
    expect(confirmedBeforeResume.length).toBeGreaterThan(0);
    let hourly = nativeRunSchema.parse((await s.read("hourlyRun", { runId: (await content(s)).latestRunRef })).body.data);
    expect(hourly).toMatchObject({ complete: false, counts: { deferred: 1, failed: 0, inaccessible: 0 } });
    // Resume from the saved checkpoint: the confirmed first page is neither re-read nor duplicated.
    await s.advanceTo("2026-11-07T11:05:03Z");
    expect((await s.work(run1)).status).toBe(200);
    const pageOneReads = s.world.reads.filter(r => r.subject.profile.accountId === "synthetic-tt-account-b" && r.stage === "posts" && r.cursor === null);
    expect(pageOneReads).toHaveLength(1);
    expect(s.app.contentMonitor!.output(raw1).metricSnapshots.filter(m => m.contentRef.sourceId === "7300000000000000001")).toEqual(confirmedBeforeResume);
    coverage = s.app.contentMonitor!.output(raw1).freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 6, newContent: 6, deferred: 0, complete: true, noNewContent: false, allClear: true });

    // The watchlist reads J01 membership with the J08 store's frozen snapshot: six enrolled profiles, all active after a complete run.
    const watch = nativeWatchlistSchema.parse((await s.read("watchlist")).body.data);
    expect(watch).toMatchObject({ sourceState: "current", total: 6, active: 6, pending: 0, excluded: 0 });
    // Reproducible four-metric output. Instagram and TikTok view definitions differ, so the cross-network total stays unknown.
    const all = await content(s);
    expect(all).toMatchObject({ sourceState: "current", synthetic: true, views: null, rate: null, orders: null, net: null });
    expect(all.posts.map(p => p.network).sort()).toEqual(["instagram", "instagram", "instagram", "instagram", "tiktok", "tiktok"]);
    const a1 = all.posts.find(p => p.originalUrl?.includes("SYNTHA1"))!;
    const springInstagram = await content(s, { network: "instagram", campaign: a1.campaign });
    expect(springInstagram).toMatchObject({ total: 3, views: 2000, orders: 1, net: { minorUnits: 4000, currency: "USD" },
      metricBasis: { definition: "Synthetic Instagram plays (native lifetime counter)", semantics: "cumulative", context: "organic" } });
    expect(springInstagram.rate).toBeCloseTo(7.7, 5);
    const tiktok = await content(s, { network: "tiktok" });
    expect(tiktok).toMatchObject({ total: 2, views: 5300, rate: null, orders: null, net: null });
    const b1 = tiktok.posts.find(p => p.originalUrl?.includes("7300000000000000001"))!;
    const b1Detail = nativePostSchema.parse((await s.read("postPerformance", { postId: b1.id })).body.data);
    // A TikTok Shop order also imported into Shopify carries one canonical order ID and counts once.
    expect(b1Detail.post.attribution).toMatchObject({ level: "post", orders: 1, net: { minorUnits: 2500, currency: "USD" }, complete: true });
    expect(b1Detail.post.checkpointHours).toBe(168);
    expect(b1Detail.history.find(h => h.checkpoint)?.checkpoint).toEqual({ hours: 168, actualAgeHours: 192.1, version: "ticket-initial-checkpoints-v1" });
    expect(b1Detail.history.find(h => h.checkpoint?.hours === 24)).toBeUndefined();
    const crosspost = all.posts.find(p => p.originalUrl?.includes("SYNTHB1"))!;
    expect(crosspost.creative).toBe(b1.creative);
    expect(crosspost.id).not.toBe(b1.id);
    expect(s.app.contentMonitor!.output(raw1).originals).toBe(5);
    const e1 = all.posts.find(p => p.originalUrl?.includes("SYNTHE1"))!;
    expect(e1.attribution).toMatchObject({ level: "creator", orders: 1, net: { minorUnits: 1800, currency: "USD" } });
    // The ambiguous brand-only match and the unrelated post never enter Farda activity metrics.
    expect(all.posts.some(p => p.originalUrl?.includes("SYNTHC1"))).toBe(false);
    expect(all.total).toBe(6);
    const actions = s.app.contentMonitor!.actions();
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "J09", reason: "ATTRIBUTION_BRAND_ONLY_CONCURRENT_CAMPAIGNS", state: "proposed" }),
      expect.objectContaining({ owner: "J09", reason: "INBOX_REPLY_REVIEW", state: "proposed" }),
    ]));

    // Next hour: unchanged counters, a confirmed private post and a login-required row.
    await s.advanceTo("2026-11-07T12:05:00Z");
    s.world.login.add("synthetic-tt-account-d");
    s.world.privatePosts.add("SYNTHA2");
    const metricRows = () => s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_metrics").get()!.n;
    const contentRows = () => s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_content").get()!.n;
    const [metricsBefore, contentBefore] = [metricRows(), contentRows()];
    const run2 = await s.fire(12);
    expect(run2).not.toBe(run1);
    await s.work(run2);
    const raw2 = s.latestRun();
    coverage = s.app.contentMonitor!.output(raw2).freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 5, unchanged: 5, newContent: 0, inaccessible: 1, deferred: 0, failed: 0,
      complete: false, noNewContent: null, allClear: null });
    expect(metricRows()).toBe(metricsBefore);
    expect(contentRows()).toBe(contentBefore);
    expect(s.app.contentMonitor!.actions().filter(a => a.reason === "INBOX_REPLY_REVIEW")).toHaveLength(1);
    expect(s.app.contentMonitor!.actions().filter(a => a.reason.startsWith("ATTRIBUTION_"))).toHaveLength(1);
    expect(s.app.contentMonitor!.actions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "J09", reason: "CONTENT_PRIVATE", state: "proposed" }),
      expect.objectContaining({ owner: "J14", reason: "SOURCE_LOGIN_REQUIRED", state: "proposed" }),
    ]));
    hourly = nativeRunSchema.parse((await s.read("hourlyRun", { runId: (await content(s)).latestRunRef })).body.data);
    expect(hourly).toMatchObject({ complete: false, counts: { changed: 0, unchanged: 5, inaccessible: 1, failed: 0, deferred: 0 }, schedule: "disabled", nextRun: null });
    const inaccessible = hourly.checks.find(c => c.state === "inaccessible")!;
    // Source freshness: the failed read's time and the last source success stay separate source-owned watermarks.
    expect(inaccessible).toMatchObject({ access: "loginRequired", lastSuccessAt: expect.stringMatching(/^2026-11-07T11:05/), at: expect.stringMatching(/^2026-11-07T12:05/) });
    const after = await content(s);
    expect(after.sourceState).toBe("partial");
    const d1 = after.posts.find(p => p.originalUrl?.includes("7300000000000000004"))!;
    expect(d1).toMatchObject({ visibility: "inaccessible", access: "loginRequired", measurement: { views: 300 } });
    const d1Detail = nativePostSchema.parse((await s.read("postPerformance", { postId: d1.id })).body.data);
    expect(d1Detail.publicationHistory.some(h => h.state === "public")).toBe(true);
    const a2 = after.posts.find(p => p.originalUrl?.includes("SYNTHA2"))!;
    expect(a2).toMatchObject({ visibility: "private", access: "authorized", measurement: { views: 0, likes: 0 } });
    const trace = s.app.contentMonitor!.trace(raw2, "synthetic-j08-trace-key-000000000000");
    const text = JSON.stringify(trace);
    for (const raw of ["synthetic-tt-account-d", "7300000000000000004", "SYNTHA2", s.ids.get("d")!]) expect(text).not.toContain(raw);
    expect(trace).toMatchObject({ evidenceStage: "synthetic", freshnessCoverage: { snapshotCount: 6, inaccessible: 1 } });
    // The earlier complete run keeps its own all-clear claim; a later incident is not back-dated into it.
    expect(s.app.contentMonitor!.output(raw1).freshnessCoverage).toMatchObject({ complete: true, allClear: true });
    // Every browser response stays aliased: no raw account, post, profile, message or canonical creator ID.
    // A public native post URL is the existing source-link field; every other reference is a scoped alias.
    const browser = JSON.stringify([all, after, hourly, b1Detail, d1Detail, (await s.read("watchlist")).body], (key, value) => key === "originalUrl" ? null : value);
    for (const raw of ["synthetic-ig-account-a", "synthetic-tt-account-b", "synthetic-ig-profile-a", "SYNTHA1", "7300000000000000001", "synthetic-message-a1",
      "synthetic-conversation-a", ...s.ids.values()]) expect(browser).not.toContain(raw);
  });

  it("J08-02: a budget-limited pass leaves due rows deferred and cannot claim no new content or all clear", async () => {
    const s = await sandbox({ failOnce: false });
    const run = await s.fire(11);
    await s.work(run, 2);
    const coverage = s.app.contentMonitor!.output(s.latestRun()).freshnessCoverage;
    expect(coverage).toMatchObject({ snapshotCount: 6, scanned: 2, deferred: 4, complete: false, noNewContent: null, allClear: null });
    expect(coverage.unchanged + coverage.newContent + coverage.inaccessible + coverage.deferred + coverage.failed).toBe(6);
    const hourly = nativeRunSchema.parse((await s.read("hourlyRun", { runId: (await content(s)).latestRunRef })).body.data);
    expect(hourly).toMatchObject({ complete: false, snapshotSize: 6, counts: { changed: 2, deferred: 4 } });
    expect(hourly.checks.filter(c => c.state === "deferred").every(c => c.at === null && c.reason === "Due but not yet visited in this run.")).toBe(true);
    expect((await content(s)).sourceState).toBe("partial");
  });

  it("J08-01: hourly and manual recheck triggers share one finite snapshot and one account lease; no checkpoint is read twice", async () => {
    const s = await sandbox({ failOnce: false });
    const hourly = await s.fire(11, "synthetic-hourly-trigger"), manual = await s.fire(11, "synthetic-manual-recheck");
    const pages = () => s.app.store.database.prepare("SELECT COUNT(DISTINCT run_ref) AS runs,COUNT(*) AS pages FROM job_runtime_pages WHERE registration_ref='synthetic-j08'").get();
    expect(pages()).toEqual({ runs: 1, pages: 1 });
    expect(s.app.store.database.prepare("SELECT COUNT(*) AS n FROM job_runtime_triggers WHERE registration_ref='synthetic-j08'").get()!.n).toBe(2);
    const [left, right] = await Promise.all([s.work(hourly), s.work(manual)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    await s.work(hourly);
    const keys = s.world.reads.map(r => JSON.stringify([r.subject.profile.accountId, r.stage, r.cursor]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(s.app.contentMonitor!.runs()).toHaveLength(1);
    expect(s.app.contentMonitor!.output(s.latestRun()).freshnessCoverage).toMatchObject({ snapshotCount: 6, complete: true });
    // A duplicate trigger after completion reuses the completed run and reads nothing.
    const reads = s.world.reads.length;
    await s.work(await s.fire(11, "synthetic-hourly-trigger"));
    expect(pages()).toEqual({ runs: 1, pages: 1 });
    expect(s.world.reads).toHaveLength(reads);
  });

  it("J08-09: policy, suppression and schedule changes act before the next item; prior observations remain", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(11));
    const before = await content(s);
    expect(before.total).toBe(6);
    // A changed J08 policy version holds every remaining item without a source call.
    await s.advanceTo("2026-11-07T12:05:00Z");
    s.setPolicy({ ...j08SandboxPolicy, version: "synthetic-j08-policy-v2" });
    const reads = s.world.reads.length, run2 = await s.fire(12);
    await s.work(run2);
    expect(s.world.reads).toHaveLength(reads);
    expect(s.app.contentMonitor!.output(s.latestRun()).rows.every(r => r.state === "held" && r.reason === "J08_POLICY_VERSION_CHANGED")).toBe(true);
    expect(s.app.contentMonitor!.output(s.latestRun()).freshnessCoverage).toMatchObject({ deferred: 6, complete: false, noNewContent: null, allClear: null });
    // Suppression is rechecked per item: the suppressed row is held, the rest proceed, and its earlier posts stay reconcilable.
    s.setPolicy(j08SandboxPolicy);
    await s.advanceTo("2026-11-07T13:05:00Z");
    const run3 = await s.fire(13);
    s.suppressed.add(s.ids.get("a")!);
    await s.work(run3);
    const out = s.app.contentMonitor!.output(s.latestRun());
    expect(out.rows.filter(r => r.reason === "J08_ENROLLMENT_CHANGED")).toHaveLength(1);
    expect(out.freshnessCoverage).toMatchObject({ snapshotCount: 6, scanned: 5, deferred: 1, complete: false });
    expect(s.world.reads.some(r => r.subject.creatorId === s.ids.get("a") && Date.parse(r.window.end) === Date.parse("2026-11-07T13:00:00Z"))).toBe(false);
    expect((await content(s)).posts.filter(p => p.originalUrl?.includes("SYNTHA"))).toHaveLength(2);
    // A disabled schedule (revoked activation) stops work before any source call.
    await s.advanceTo("2026-11-07T14:05:00Z");
    const run4 = await s.fire(14), held = s.world.reads.length;
    s.runtime.kit.state.active = false;
    expect((await s.work(run4)).status).toBeGreaterThanOrEqual(400);
    expect(s.world.reads).toHaveLength(held);
  });

  it("clears an inaccessible incident only on a later complete healthy observation, never by unbinding the row", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(11));
    await s.advanceTo("2026-11-07T12:05:00Z");
    s.world.login.add("synthetic-tt-account-d");
    await s.work(await s.fire(12));
    const open = () => s.app.contentMonitor!.incidents().filter(i => i.state === "open");
    expect(open()).toHaveLength(1);
    // Unbinding: the creator leaves the watchlist. The incident and its J14 proposal stay open.
    s.suppressed.add(s.ids.get("d")!);
    await s.advanceTo("2026-11-07T13:05:00Z");
    await s.work(await s.fire(13));
    expect(s.app.contentMonitor!.output(s.latestRun()).freshnessCoverage.snapshotCount).toBe(5);
    expect(open()).toHaveLength(1);
    expect(s.app.contentMonitor!.actions().find(a => a.owner === "J14")?.state).toBe("proposed");
    const stillInaccessible = (await content(s)).posts.find(p => p.originalUrl?.includes("7300000000000000004"))!;
    expect(stillInaccessible).toMatchObject({ visibility: "inaccessible", access: "loginRequired" });
    // A later complete, healthy read of the same row closes it.
    s.suppressed.delete(s.ids.get("d")!);
    s.world.login.delete("synthetic-tt-account-d");
    await s.advanceTo("2026-11-07T14:05:00Z");
    await s.work(await s.fire(14));
    expect(open()).toHaveLength(0);
    expect(s.app.contentMonitor!.incidents()[0]).toMatchObject({ state: "closed", closedAt: "2026-11-07T14:05:00.000Z" });
    expect(s.app.contentMonitor!.actions().find(a => a.owner === "J14")?.state).toBe("resolvedByObservation");
    expect(s.app.contentMonitor!.output(s.latestRun()).freshnessCoverage).toMatchObject({ complete: true, allClear: true, noNewContent: true });
  });

  it("J08-03: identity stays stable when source values change, and repeated observations reuse their keys", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(11));
    const statusRows = () => s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_status").get()!.n;
    const first = (await content(s)).posts.find(p => p.originalUrl?.includes("SYNTHA1"))!, statusBefore = statusRows();
    // Attributed and review content carry lifecycle status; unrelated content does not.
    expect(statusBefore).toBe(7);
    await s.advanceTo("2026-11-07T12:05:00Z");
    s.world.urlOverride.set("SYNTHA1", "https://instagram.com/p/SYNTHA1/");
    await s.work(await s.fire(12));
    const second = (await content(s)).posts.find(p => p.id === first.id)!;
    expect(second.originalUrl).toBe("https://instagram.com/p/SYNTHA1/");
    expect((await content(s)).total).toBe(6);
    expect(statusRows()).toBe(statusBefore);
    expect(s.app.contentMonitor!.output(s.latestRun()).freshnessCoverage).toMatchObject({ unchanged: 6, newContent: 0, noNewContent: true });
  });

  it("refuses cross-account, malformed and wrong-stage evidence before any write, and stays read-only", async () => {
    const s = await sandbox({ failOnce: false });
    s.world.crossAccount = true;
    const run = await s.fire(11);
    const answer = await s.work(run);
    expect(answer.body).toMatchObject({ code: expect.stringMatching(/J08_CROSS_ACCOUNT_PAYLOAD|SOURCE_HELD/) });
    expect(s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_content").get()!.n).toBe(0);
    // A real-source binding refuses a synthetic page, and vice versa.
    s.world.crossAccount = false;
    s.world.stage = "source";
    await s.advanceTo("2026-11-07T12:05:00Z");
    await s.work(await s.fire(12));
    expect(s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_content").get()!.n).toBe(0);
    // A source receipt reused for different facts is refused; the first page's facts stay as recorded.
    s.world.stage = "synthetic";
    s.world.fixedReceipt = "synthetic-reused-receipt";
    await s.advanceTo("2026-11-07T13:05:00Z");
    await s.work(await s.fire(13));
    expect(s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_pages WHERE receipt_ref='synthetic-reused-receipt'").get()!.n).toBe(1);
    expect(s.app.contentMonitor!.output(s.latestRun()).rows.filter(r => r.reason === "J08_SOURCE_RECEIPT_REUSED").length).toBeGreaterThan(0);
    // A thrown source denial is a protected-state denial, not a retry, and writes nothing.
    s.world.fixedReceipt = null;
    s.world.throwStatus = 403;
    await s.advanceTo("2026-11-07T14:05:00Z");
    const pagesBefore = s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_pages").get()!.n;
    expect((await s.work(await s.fire(14))).body).toMatchObject({ code: "SOURCE_SCOPE_DENIED" });
    expect(s.app.store.database.prepare("SELECT COUNT(*) AS n FROM content_monitor_pages").get()!.n).toBe(pagesBefore);
    expect(s.app.contentMonitor!.output(s.latestRun()).rows.filter(r => r.reason === "SOURCE_SCOPE_DENIED")).toHaveLength(1);
    // J08 makes read requests only: no request carries a send, like, follow, term, rate or approval instruction.
    for (const r of s.world.reads) expect(Object.keys(r).sort()).toEqual(["cursor", "maxRecords", "policyVersion", "priorObservationRefs", "registrationRef",
      "registrationVersion", "scope", "stage", "subject", "watchlistVersion", "window"]);
    const tables = s.app.store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_scope' AND (name LIKE 'approval%' OR name LIKE 'job_dispatch%' OR name LIKE 'action_%')").all();
    expect(tables.length).toBeGreaterThan(5);
    for (const t of tables) expect(s.app.store.database.prepare(`SELECT COUNT(*) AS n FROM ${String(t.name)}`).get()!.n).toBe(0);
  });

  it("J08-07: denial, UI drift and throttling preserve confirmed evidence, expose missing coverage and assign recovery owners", async () => {
    const s = await sandbox({ failOnce: false });
    await s.work(await s.fire(11));
    const before = (await content(s)).posts.map(p => [p.id, p.measurement?.views]);
    await s.advanceTo("2026-11-07T12:05:00Z");
    s.world.access.set("synthetic-ig-account-a", "denied").set("synthetic-ig-account-e", "uiDrift").set("synthetic-tt-account-b", "throttled");
    const run = await s.fire(12);
    await s.work(run);
    for (let attempt = 0; attempt < 3; attempt++) { await s.advanceTo(new Date(s.now() + 5_000).toISOString()); await s.work(run); }
    const out = s.app.contentMonitor!.output(s.latestRun());
    expect(out.freshnessCoverage).toMatchObject({ snapshotCount: 6, inaccessible: 1, failed: 2, unchanged: 3, complete: false, noNewContent: null, allClear: null });
    expect(out.rows.filter(r => r.category !== "unchanged").map(r => r.reason).sort()).toEqual(["SOURCE_DENIED", "SOURCE_THROTTLED", "SOURCE_UI_DRIFT"]);
    expect(s.app.contentMonitor!.actions().filter(a => a.owner === "J14").map(a => a.reason).sort()).toEqual(["SOURCE_DENIED", "SOURCE_UI_DRIFT"]);
    // Confirmed observations from the earlier run are retained, never replaced by zero.
    expect((await content(s)).posts.map(p => [p.id, p.measurement?.views])).toEqual(before);
    const hourly = nativeRunSchema.parse((await s.read("hourlyRun", { runId: (await content(s)).latestRunRef })).body.data);
    expect(hourly.counts).toMatchObject({ inaccessible: 1, failed: 2 });
    expect(hourly.checks.filter(c => c.state !== "unchanged").every(c => c.owner !== null && c.lastSuccessAt !== null && c.lastSuccessAt !== c.at)).toBe(true);
  });

  it("keeps synthetic fixtures out of production executors", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
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
    const capabilities = await (await fetch(`http://127.0.0.1:${(s.app.server.address() as { port: number }).port}/v1/capabilities`, { headers: { authorization: "Bearer " + reader } })).json();
    expect(capabilities.contentMonitor).toMatchObject({ sourceAuthority: "j08-store", sourceExecution: "sandbox", evidenceStage: "synthetic",
      followUpProposals: "J09-proposal-only", outboundActions: "none", retryAuthority: "notConnected" });
    expect(JSON.stringify(capabilities.contentMonitor)).not.toContain("connected\"");
    const base: AgentServerOptions = { databasePath: ":memory:", workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: reader, reviewToken: reviewer };
    const binding = { registrationRef: "synthetic-j08", policy: () => j08SandboxPolicy, source: createJ08SandboxSource(s.world), evidenceStage: "synthetic" as const };
    expect(() => createAgentServer({ ...base, contentMonitor: binding, monitorSource: { read: async () => null, assertCurrent: () => {} } })).toThrow("One content monitor source owner");
    expect(() => createAgentServer({ ...base, contentMonitor: binding })).toThrow("J08_REGISTRATION_INVALID");
    const registry = { registrations: s.runtime.kit.registry.registrations, executors: new Map() };
    expect(() => createAgentServer({ ...base, runtime: { registry }, contentMonitor: { ...binding, policy: () => ({ ...j08SandboxPolicy, version: "other" }) } }))
      .toThrow("J08_POLICY_VERSION_MISMATCH");
  });
});
