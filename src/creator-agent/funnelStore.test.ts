// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digest } from "./config.ts";
import { livePipelineSchema, type FunnelEvent } from "./funnelContract.ts";
import { FunnelRepository, type FunnelAuthority } from "./funnelStore.ts";
import { evt, fixtureRef, jan } from "./funnelFixtures.testkit.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const scope = { workspaceId: "fixture-w", accountId: "fixture-account" };
const hashByProof = new Map<string, string>();
const authority: FunnelAuthority = {
  resolve: async (_scope, _request, ref) =>
    hashByProof.has(ref) ? { ...scope, eventHash: hashByProof.get(ref)! } : null,
};
let dir: string, db: InstanceType<typeof DatabaseSync>, repo: FunnelRepository, today: string;
function open() {
  db = new DatabaseSync(join(dir, "agent.sqlite"));
  repo = new FunnelRepository(db, scope, authority, () => new Date(today));
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "farda-funnel-test-"));
  today = jan(20);
  hashByProof.clear();
  open();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function envelope(e: FunnelEvent, key = e.eventId) {
  return {
    jobId: "fixture-job",
    jobVersion: "v1",
    mode: e.correctsEventId ? "reconcile" : "observe",
    actor: { id: "fixture-producer", role: "observer" },
    accountRef: e.sourceAccount,
    policyVersion: e.policyOfferApprovalVersions.policy,
    inputHash: digest(e),
    idempotencyKey: key,
    correlationId: "corr:" + key,
    requestedAt: today,
    deadline: null,
    checkpoint: null,
    event: e,
  };
}
function ingest(e: FunnelEvent, key = e.eventId) {
  hashByProof.set(e.evidenceRef.provenanceRef, digest(e));
  return repo.ingest(envelope(e, key));
}
const details = (items: FunnelEvent["details"] | Omit<FunnelEvent["details"], "blockers">) => ({
  details: { blockers: [], ...items },
});
describe("EVT-INV scoped acquisition ledger", () => {
  it("verifies the producer and exact hash before a write; rejects wrong scope, missing native crosswalks and forged state", async () => {
    const base = evt("q", "queued");
    await expect(repo.ingest(envelope(base))).rejects.toMatchObject({
      status: 403,
      code: "FUNNEL_PRODUCER_RECEIPT_REQUIRED",
    });
    await expect(
      ingest({ ...base, sourceAccount: { ...base.sourceAccount, accountId: "foreign" } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      ingest({ ...base, ingestIdentity: { nativeId: null, fingerprint: null, sourceVersion: "1" } }),
    ).rejects.toThrow();
    await expect(ingest({ ...base, route: "inbound" })).rejects.toThrow();
    expect(repo.read().queue).toEqual([]);
  });
  it("deduplicates the native revision and idempotency key across restarts and rejects contradictory replays", async () => {
    const base = evt("a", "confirmedSent");
    expect((await ingest(base)).replayed).toBe(false);
    db.close();
    open();
    expect((await repo.ingest(envelope(base))).replayed).toBe(true);
    expect(await ingest({ ...base, eventId: "other-ingest-id", observedAt: jan(7) })).toMatchObject({
      storedEventRef: "a",
      replayed: true,
    });
    await expect(ingest({ ...base, nativeActorRole: "changed" })).rejects.toMatchObject({ status: 409 });
    expect(repo.read().coverage.events).toBe(1);
  });
  it("preserves original as-ofs under late changes; resolves a verified cross-source creator bridge without double-counting", async () => {
    const e = evt("first", "discovered");
    e.creatorRef = { ...e.creatorRef, canonicalId: null, identityState: "unresolved" };
    await ingest(e);
    const second = evt("match", "matched", "A", 6, {
      sourceAccount: fixtureRef("shopify", "web"),
      creatorRef: fixtureRef("shopify", "person"),
    });
    await expect(ingest(second)).rejects.toMatchObject({ code: "FUNNEL_IDENTITY_CROSSWALK_REQUIRED" });
    second.details.identityCrosswalk = {
      fromSource: "social-cat",
      fromId: e.creatorRef.sourceId!,
      canonicalId: "person",
      provenanceRef: "identity-directory:revision1",
    };
    await ingest(second);
    today = jan(21);
    const correction = evt("fixed", "matched", "A", 4, {
      ...second,
      eventId: "fixed",
      ingestIdentity: { nativeId: "native:match", sourceVersion: "2", fingerprint: null },
      correctsEventId: "match",
      observedAt: jan(20),
      occurredAt: jan(4),
    });
    await ingest(correction);
    const old = repo.read({ asOf: jan(20) }),
      latest = repo.read({ source: "social-cat", account: "external-account" });
    expect(old.queue[0]!.facts.map((f) => f.eventId)).toEqual(["first", "match"]);
    expect(latest.queue[0]!.facts.map((f) => f.eventId)).toEqual(["fixed", "first"]);
    expect(latest.coverage).toMatchObject({ opportunities: 1, creators: 1 });
    expect(latest.queue[0]).toMatchObject({ creator: "person", source: "social-cat" });
    expect(repo.read({ source: "shopify" }).coverage.opportunities).toBe(0);
    await expect(
      ingest({
        ...second,
        eventId: "bad",
        creatorRef: fixtureRef("shopify", "wrong"),
        ingestIdentity: { nativeId: "wrong", sourceVersion: "1", fingerprint: null },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      ingest({
        ...correction,
        eventId: "fork",
        ingestIdentity: { nativeId: "fork", sourceVersion: "3", fingerprint: null },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("counts distinct opportunities and independent attempts without inventing preceding milestones", async () => {
    for (const e of [
      evt("d", "discovered"),
      evt("a1", "attempt"),
      evt("a2", "attempt"),
      evt("u", "uncertain"),
      evt("s", "confirmedSent"),
      evt("m", "matched", "A", 7),
      evt("r", "reply", "A", 8),
      evt("paid", "paid", "B", 6, { route: "inbound", occurredAt: null }),
      evt("terms", "terms", "C", 6, { route: "inbound" }),
      evt("queued", "queued", "D"),
      evt("exp", "expired", "D", 7),
      evt("decline", "declined", "E"),
    ])
      await ingest(e);
    const data = livePipelineSchema.parse(repo.read());
    expect(data.sends).toMatchObject({
      attempts: 2,
      recipients: 1,
      confirmed: 1,
      uncertain: 0,
      queued: 1,
      replies: 1,
      matched: 1,
    });
    expect(data.milestones.find((m) => m.key === "matched")).toMatchObject({
      reached: 1,
      eligible: 1,
      advanced: 1,
      knownPairs: 1,
      medianDays: 2,
    });
    expect(repo.read({ route: "inbound" }).milestones.find((m) => m.key === "confirmedSent")?.reached).toBe(0);
    expect(data.queueCounts.expired).toBe(1);
    expect(data.coverage).toMatchObject({ opportunities: 5, missingTimes: 1, incomplete: true });
    expect(data.exclusions).toMatchObject({ expired: 1, declined: 1 });
    expect(Object.values(data.queueCounts).reduce((a, b) => a + b, 0)).toBe(5);
  });
  it("uses due agreements, one agreed creative across two crossposts, and keeps zero-sale seeded creators", async () => {
    const agreement = details({ deliverableId: "d1", obligation: "required", dueAt: jan(10) });
    const ps = details({ deliverableId: "d1", creativeId: "creative", postId: "post" });
    for (const e of [
      evt("seedA", "sampleDelivered"),
      evt("seedB", "sampleDelivered", "B"),
      evt("brief", "briefAccepted", "A", 5, agreement),
      evt("p1", "published", "A", 7, ps),
      evt("p2", "published", "A", 8, { network: "tiktok", ...ps }),
      evt("skip", "noSample", "C"),
      evt("voluntary", "published", "C", 9, details({ postId: "other", obligation: "voluntary" })),
      evt("immature", "discovered", "D", 5, { maturationAt: jan(30) }),
      evt("open", "discovered", "E", 5, { maturationAt: null }),
      evt("eligible", "repeatEligible", "A", 7, details({ reviewId: "rev" })),
      evt("again", "repeatParticipation", "A", 10, details({ reviewId: "rev" })),
    ])
      await ingest(e);
    const data = repo.read(),
      l = Object.fromEntries(data.lifecycle.map((m) => [m.name, m]));
    expect(l["Verified native publications"]?.value).toBe(3);
    expect(l["Agreed published creatives"]?.value).toBe(1);
    expect(l["Posting completion"]).toMatchObject({ value: 100, denominator: 1 });
    expect(l["Voluntary publications"]?.value).toBe(1);
    expect(l["Seeded with no observed publication"]?.value).toBe(1);
    expect(l["Seeded with no observed retained sale"]?.value).toBe(2);
    expect(l["Sample to first publication"]).toMatchObject({ value: 2, denominator: 1 });
    expect(l["Repeat participation"]).toMatchObject({ value: 100, denominator: 1 });
    expect(data.coverage).toMatchObject({ mature: 3, immature: 1, unknownMaturity: 1 });
  });
  it("reports partial coverage and every blocker once; refunds and changing attribution metadata do not duplicate sales", async () => {
    const first = evt(
      "order",
      "retainedOrder",
      "A",
      6,
      details({
        orderId: "o1",
        retainedMinor: 2500,
        currency: "USD",
        attributionVersion: "last-click-v1",
        attributionWindow: "7d",
        newCustomer: false,
      }),
    );
    await ingest(first);
    await ingest(
      evt("cost", "cost", "A", 6, details({ bucket: "task", basis: "cash", currency: "USD", amountMinor: 60 })),
    );
    const late = evt("order-v2", "refund", "A", 12, {
      sourceAccount: fixtureRef("shopify", "web"),
      ...details({
        orderId: "o1",
        retainedMinor: 0,
        currency: "USD",
        attributionVersion: "report-v2",
        attributionWindow: "7d",
      }),
    });
    today = jan(21);
    await ingest(late);
    const outage = evt("outage", "sourceOutage", "A", 14, {
      evidenceRef: { ...late.evidenceRef, access: "denied" },
      ...details({ blockers: ["Access denied", "Stale provider"] }),
    });
    await ingest(outage);
    const now = repo.read(),
      old = repo.read({ asOf: jan(20) });
    expect(now.outcomes.find((x) => x.name === "Attributed net sales")?.value).toBe(0);
    expect(now.outcomes.find((x) => x.name === "Attributed orders")?.value).toBe(1);
    expect(old.outcomes.find((x) => x.name === "Attributed net sales")?.value).toBe(2500);
    expect(now.economics.find((x) => x.name === "task cash")?.value).toBe(60);
    expect(now.economics.find((x) => x.name === "Contribution after recorded accruals")?.value).toBeNull();
    expect(now.coverage.unavailable).toBe(1);
    expect(now.queue[0]?.blockers).toHaveLength(3);
    expect(Object.values(now.exclusions)).toEqual([1]);
  });
});
