// Dev-only simulated environment: the real creator-agent service with every synthetic source the
// agent browser tests use, injected at once. Never part of the API image or a deployment.
// Started by tools/sandbox-sim/run.mjs; see docs/sandbox-sim.md.
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createAgentServer } from "../../src/creator-agent/server.ts";
import { loadApprovedBindings } from "../../src/creator-agent/config.ts";
import { assessCreator, MODEL_FOR_ROUTE } from "../../src/creator-agent/policy.ts";
import { syntheticAgentEvidence } from "../../src/test/creatorQualification.ts";
import { loadCreatorSourceRuntime } from "../../src/creator-agent/sourceRuntime.ts";
import { SYNTHETIC_SCOPE } from "../../src/creator-agent/testFixtures.ts";
import { PortfolioRepository, type StoredPortfolioReview } from "../../src/creator-agent/portfolioStore.ts";
import { overviewOwnersFixture } from "../../src/creator-agent/analytics/overviewOwners.testkit.ts";
import { addReservationFixture } from "../../src/creator-agent/analytics/reservations.testkit.ts";
import { addNativeReviewEvidence } from "../../src/creator-agent/analytics/nativeReviewEvidence.testkit.ts";
import type { NativeAnalyticsSnapshot } from "../../src/creator-agent/analytics/contract.ts";
import { financeSnapshot, financeTestSource, financeTestTime } from "../../src/creator-agent/finance/fixtures.testkit.ts";
import type { FinanceSourceReader } from "../../src/creator-agent/finance/source.ts";
import { operationsReadTestTime, operationsTestSource } from "../../src/creator-agent/operationsReads/fixtures.testkit.ts";
import type { OperationsReadSourceReader } from "../../src/creator-agent/operationsReads/source.ts";
import { teamInvitationSnapshot, teamInvitationTestSource, teamInvitationTestTime } from "../../src/creator-agent/teamInvitationReads/fixtures.testkit.ts";
import { controlSourceFixture, controlSourceProvider, controlTestJob, controlTestTime } from "../../src/creator-agent/operationsControlsFixtures.ts";
import { inventorySourceFixture, stockSupportTestSource, stockTestTime, supportSourceFixture } from "../../src/creator-agent/stockSupportFixtures.ts";
import { lifecycleSourceFixture, lifecycleTestSource } from "../../src/creator-agent/lifecycle/fixtures.testkit.ts";
import { shippingHubSourceFixture } from "../../src/creator-agent/shippingHubRead.testkit.ts";
import { ShippingHubReadError, type ShippingHubSource } from "../../src/creator-agent/shippingHubRead.ts";
import { collabTestAt, collabTestId, collaborationSnapshot, collaborationTestSource } from "../../src/creator-agent/collaborationWorkflowFixtures.ts";
import { nativeSourcingSourceFixture } from "../../src/creator-agent/sourcing/nativeFixtures.testkit.ts";
import { sourcingSourceFixture } from "../../src/creator-agent/sourcing/fixtures.testkit.ts";
import { originalLayoutFinanceSource } from "../../e2e-agent/support/original-layout-finance-source.ts";
import { originalLayoutOperationsSource } from "../../e2e-agent/support/original-layout-operations-source.ts";

const MINUTE = 60_000, DAY = 86_400_000;
/** Every rolling fixture is rebuilt, and every fixed-time fixture re-anchored, this often. Shorter than the
 * shortest fixture lease the screens rely on (settlements: 5 minutes), so a fresh read is always current. */
const REFRESH_MS = Math.max(10_000, Number(process.env.FARDA_SIM_REFRESH_MS) || 3 * MINUTE);
const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
type Method = (...args: unknown[]) => unknown;
type Gen<T> = { at: number; value: T };
const timers: ReturnType<typeof setInterval>[] = [];
const every = (ms: number, fn: () => void) => { const timer = setInterval(fn, ms); timer.unref(); timers.push(timer); };

/** A fixture rebuilt at the current time on a fixed cadence. The previous generation is kept so a
 * read and its assertCurrent that straddle a rebuild still fence against the generation that answered.
 * A fixture whose facts the server persists per source version must carry a new version per generation. */
async function rolling<T>(name: string, build: (at: number, generation: number) => T | Promise<T>) {
  let count = 0;
  const state: { current: Gen<T>; previous: Gen<T> } = { current: { at: Date.now(), value: await build(Date.now(), count) }, previous: undefined as never };
  state.previous = state.current;
  every(REFRESH_MS, () => {
    const at = Date.now();
    Promise.resolve(build(at, ++count)).then(value => { state.previous = state.current; state.current = { at, value }; })
      .catch((error: unknown) => console.error(`sandbox-sim: ${name} rebuild failed; keeping the previous generation.`, error));
  });
  return state;
}

/** Plain-data copy with every ISO instant moved by offsetMs and every calendar date by whole days.
 * The same transform shippingHubSourceFixture applies to its demo data; class instances such as
 * AbortSignal and functions are passed through untouched. */
function shift<T>(value: T, offsetMs: number): T {
  if (!offsetMs) return value;
  const days = Math.round(offsetMs / DAY);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const instant = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z$/.exec(v);
      if (instant) { const moved = new Date(Date.parse(v) + offsetMs).toISOString(); return instant[2] ? moved : moved.replace(/\.\d{3}Z$/, "Z"); }
      if (/^\d{4}-\d\d-\d\d$/.test(v) && days) return new Date(Date.parse(`${v}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Sync fence over the current generation, then the previous one. assertCurrent must return void. */
function fence(attempts: (() => unknown)[]) {
  let first: unknown;
  for (const attempt of attempts) {
    try { attempt(); return; } catch (error) { first ??= error; }
  }
  throw first;
}

/** One stable source object whose methods forward to the current generation's source. */
function delegate<T, S extends object>(roll: { current: Gen<T>; previous: Gen<T> }, pick: (value: T) => S): S {
  const out: Record<string, Method> = {};
  for (const [key, sample] of Object.entries(pick(roll.current.value))) {
    if (typeof sample !== "function") continue;
    const call = (gen: Gen<T>, args: unknown[]) => (pick(gen.value) as unknown as Record<string, Method>)[key]!(...args);
    out[key] = key.startsWith("assert") ? (...args) => fence([() => call(roll.current, args), () => call(roll.previous, args)]) : (...args) => call(roll.current, args);
  }
  return out as S;
}

/** Fixtures whose records carry fixed module-level instants run in their own time frame: their clock is
 * real time minus an offset that is re-anchored every REFRESH_MS, every argument is moved back into that
 * frame and every answer forward into real time. Relative ages are exactly the ones the tests assert. */
function framed<S extends object>(epochIso: string, build: (now: () => number) => S, after?: (answer: unknown) => void): S {
  const epoch = Date.parse(epochIso), anchor = () => Math.floor((Date.now() - epoch) / MINUTE) * MINUTE;
  let offset = anchor(), previous = offset;
  every(REFRESH_MS, () => { previous = offset; offset = anchor(); });
  const source = build(() => Date.now() - offset) as unknown as Record<string, Method>;
  const inFrame = (args: unknown[], o: number) => args.map(arg => typeof arg === "number" && arg > 1e12 ? arg - o : shift(arg, -o));
  const out: Record<string, Method> = {};
  for (const [key, method] of Object.entries(source)) {
    if (typeof method !== "function") continue;
    out[key] = key.startsWith("assert")
      ? (...args) => fence([offset, previous].map(o => () => method.apply(source, inFrame(args, o))))
      : (...args) => {
        const o = offset, answer = method.apply(source, inFrame(args, o));
        const settle = (value: unknown) => { const moved = shift(value, o); after?.(moved); return moved; };
        return answer instanceof Promise ? answer.then(settle) : settle(answer);
      };
  }
  return out as unknown as S;
}

/** Leases the specs extend for interactive browser runs (they lengthen the same fields). */
const extendLease = (answer: unknown) => {
  const authority = (answer as { authority?: { observedAt: string; validUntil: string } } | null)?.authority;
  if (authority) authority.validUntil = new Date(Date.parse(authority.observedAt) + 10 * MINUTE).toISOString();
};

export async function startSimAgent(env: Record<string, string | undefined> = process.env) {
  const readToken = env.FARDA_AGENT_READ_TOKEN ?? "", reviewToken = env.FARDA_AGENT_REVIEW_TOKEN ?? "";
  const port = Number(env.FARDA_SIM_AGENT_PORT ?? 4401), databasePath = env.FARDA_SIM_DATABASE ?? ".agent-data/sim/agent.sqlite";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid FARDA_SIM_AGENT_PORT.");
  if (!databasePath.includes(".agent-data/sim/")) throw new Error("The simulation database must live under .agent-data/sim/.");
  process.umask(0o077);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(databasePath + suffix, { force: true });

  // Overview owners (THO-293): one fixture supplies analytics, the overview's finance dashboard, the
  // operations overview/shipping pair, monitoring and intake, all in one reporting period. It is rebuilt
  // at the current time; generation 0 seeds the server's own SQLite (intake + portfolio review), and later
  // generations are linked to those stored records instead of re-seeding.
  type OverviewFixture = Awaited<ReturnType<typeof overviewOwnersFixture>>;
  const link: { member?: Record<string, unknown>; creatorId?: string; review?: StoredPortfolioReview; store?: Parameters<OverviewFixture["seed"]>[0] } = {};
  const overview = await rolling("overview owners", async () => {
    const f = await overviewOwnersFixture({ now: Date.now, scope });
    if (link.store && link.member && link.review) {
      const member = f.monitor.snapshot.members[0]!, post = f.monitor.snapshot.posts[0]!;
      Object.assign(member, structuredClone(link.member)); post.creatorId = link.creatorId!;
      if (link.review.packet.reviewWindow.start !== f.portfolioPacket.reviewWindow.start) {
        // A new UTC day is a new reporting window: store this generation's review through the same repository.
        const portfolio = new PortfolioRepository(link.store.database, { workspaceId: scope.workspaceId, accountId: scope.accountId });
        link.review = await portfolio.review({ scope: { workspaceId: scope.workspaceId, accountId: scope.accountId }, expectedVersion: 0, packet: f.portfolioPacket },
          `sandbox-sim-review-${f.portfolioPacket.reviewWindow.start.slice(0, 10)}`);
      }
    }
    const initial = f.initialMutate;
    f.analytics.state.mutate = (snapshot: NativeAnalyticsSnapshot) => {
      initial(snapshot);
      if (snapshot.viewKey === "overviewSummary" && link.review && snapshot.facts.portfolio)
        snapshot.facts.portfolio = { ...snapshot.facts.portfolio, reviewKey: link.review.reviewKey, reviewHash: link.review.reviewHash };
      addReservationFixture(snapshot);
      // Review evidence only for paid media: on attribution it re-labels orders and would split the overview's cohort.
      if (snapshot.viewKey === "paidMedia") addNativeReviewEvidence(snapshot, Date.now());
    };
    return f;
  });
  const owners = overview.current.value.serverOptions;

  // Finance (THO-303): the overview's dashboard record; every other finance view from financeSnapshot.
  const financeDetail = framed(financeTestTime, now => financeTestSource(async (_scope, request) => ({ ...financeSnapshot(request.viewKey, {}, now()), scope: { ...scope } })));
  const financeOverview = delegate(overview, f => f.serverOptions.financeSource);
  const financeSource: FinanceSourceReader = {
    read: (s, request, options) => (request.viewKey === "financeDashboard" ? financeOverview : financeDetail).read(s, request, options),
    assertCurrent: (snapshot, binding, now) => (binding.request.viewKey === "financeDashboard" ? financeOverview : financeDetail).assertCurrent(snapshot, binding, now),
  };
  // Settlement ledger behind /finance/commissions, settlements and payables: the original-layout cohort.
  // Built once: the server keeps paid receipts immutable by reference, so a rebuilt (re-timed) receipt would be
  // a conflicting rewrite. Its facts stay inside the reader's 24-hour age; only the access grant slides to now.
  const settlements = originalLayoutFinanceSource(scope, Date.now()), readSettlement = settlements.source.read;
  settlements.source.read = request => { settlements.state.now = Date.now(); return readSettlement(request); };
  const settlementSource = settlements.source;

  // Operations reads (THO-301): a period-scoped read is the overview's own owner; the unscoped screens use
  // the richer original-layout facts (queue rows, stock, homes).
  const operationsLayout = framed(operationsReadTestTime, () => operationsTestSource(async (_scope, request) =>
    ({ ...originalLayoutOperationsSource(request.viewKey, request.filters, false), scope: { ...scope } })));
  const operationsOverview = delegate(overview, f => f.serverOptions.operationsReadSource);
  const periodScoped = (filters: unknown) => typeof (filters as { startAt?: unknown } | null)?.startAt === "string";
  const operationsReadSource: OperationsReadSourceReader = {
    read: (s, request, options) => (periodScoped(request.filters) ? operationsOverview : operationsLayout).read(s, request, options),
    assertCurrent: (snapshot, binding, now) => (periodScoped(binding.request.filters) ? operationsOverview : operationsLayout).assertCurrent(snapshot, binding, now),
  };

  // Daily sourcing plan (THO-287), as sourcing-plan.spec.ts serves it.
  // Each rebuilt generation is a new source version: the reader persists facts per version and refuses changes.
  const sourcing = await rolling("sourcing plan", (at, generation) => {
    const fixture = nativeSourcingSourceFixture({ now: Date.now, scope });
    fixture.state.version = `${fixture.state.version}-g${generation}`;
    const snapshot = sourcingSourceFixture(scope, at - 1000);
    fixture.state.mutate = packet => { packet.snapshot = structuredClone(snapshot); packet.snapshot.version = fixture.state.version; packet.validUntil = new Date(Date.now() + 10 * MINUTE).toISOString(); };
    return fixture;
  });

  // Lifecycle (THO-298) and the shipping hub, as lifecycle.spec.ts and shipping-hub.spec.ts serve them.
  const lifecycle = await rolling("lifecycle", (at, generation) => {
    const snapshot = lifecycleSourceFixture(scope, at);
    return { ...snapshot, version: `${snapshot.version}-g${generation}` };
  });
  const shippingHubSource: ShippingHubSource = {
    async read(binding) {
      const at = Date.now(), packet = shippingHubSourceFixture(binding, at);
      packet.validUntil = new Date(at + 10 * MINUTE).toISOString();
      for (const owner of packet.owners) owner.validUntil = packet.validUntil;
      return packet;
    },
    assertCurrent(snapshot, binding) { if (snapshot.binding.principal.principalRef !== binding.principal.principalRef) throw new ShippingHubReadError("DENIED", 403); },
  };

  const bindings = loadApprovedBindings();
  const app = createAgentServer({
    databasePath, ...scope, readToken, reviewToken, bindings, secureCookies: false,
    // Provider configuration is deliberately not read: the simulation never contacts a real source.
    ...loadCreatorSourceRuntime({}, scope),
    analyticsSource: delegate(overview, f => f.serverOptions.analyticsSource),
    monitorSource: delegate(overview, f => f.serverOptions.monitorSource),
    intakeAuthority: owners.intakeAuthority,
    financeSource, settlements: { source: settlementSource }, operationsReadSource,
    teamInvitationReadSource: framed(teamInvitationTestTime, () => teamInvitationTestSource(async (_scope, request) => ({ ...teamInvitationSnapshot(request.viewKey), scope: { ...scope } }))),
    operationsControlSource: framed(controlTestTime, now => controlSourceProvider(() => controlSourceFixture(scope), now), extendLease),
    stockSupportSource: framed(stockTestTime, now => stockSupportTestSource({ readInventory: s => inventorySourceFixture(s), readSupport: s => supportSourceFixture(s) }, now)),
    collaborationSourceReader: framed(collabTestAt, now => collaborationTestSource(id => id === collabTestId ? collaborationSnapshot() : null, now)),
    sourcingPlanSource: delegate(sourcing, f => f.source),
    lifecycleSource: lifecycleTestSource(async () => structuredClone(lifecycle.current.value), Date.now),
    shippingHubSource,
  });
  try {
    // The registered job behind the controls fixture's finite task, as controls.spec.ts registers it.
    app.operations.jobs.register(controlTestJob, 0);
    // One saved assessment under the approved website model, the packet qualification.spec.ts saves, so
    // discovery, pipeline and the evidence screen have a stored record to read.
    const website = bindings.find(binding => binding.current.modelId === MODEL_FOR_ROUTE.website);
    const packet = syntheticAgentEvidence({ creatorId: "synthetic-browser-creator", evidenceRevision: "synthetic-browser-evidence-1", ratings: { routine: 0, demo: 4 } });
    if (website) app.store.save(packet, assessCreator(packet, website), 0, "sandbox-sim-assessment");
    link.store = app.store;
    const f = overview.current.value;
    await f.seed(app.store);
    link.review = f.portfolioReview;
    const member = f.monitor.snapshot.members[0]!;
    link.member = { creatorId: member.creatorId, revision: member.revision, cohort: member.cohort, notionReceipt: member.notionReceipt, sheetsReceipt: member.sheetsReceipt, verification: structuredClone(member.verification) };
    link.creatorId = member.creatorId;
  } catch (error) { await app.close(); throw error; }
  const host = "127.0.0.1";
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(port, host, resolve); });
  const close = async () => { for (const timer of timers) clearInterval(timer); await app.close(); };
  return { app, close, host, port, databasePath, scope };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const sim = await startSimAgent();
    console.log(`sandbox-sim agent listening on ${sim.host}:${sim.port} (synthetic sources, fresh database ${sim.databasePath}).`);
    let closing = false;
    const stop = () => { if (closing) return; closing = true; sim.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } catch (error) {
    console.error("sandbox-sim agent failed to start:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
