// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "../config";
import { AgentStore } from "../store";
import { createAgentServer } from "../server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures";
import { intakeInputSchema, type IntakeInput, type ProfileRef } from "./contract";
import { IntakeRepository, fingerprintKeyOf, profileKeyOf, type CanonicalRecord, type IdentitySink, type IntakeAuthority } from "./repository";
import { handleIntakeRoute } from "./routes";

// Synthetic identities only. No real handle, account or provider identifier appears here.
const scope = { workspaceId: "fictional-workspace", accountId: "fictional-account" };
const NOW = new Date("2026-11-06T12:00:00Z");
const clock = () => NOW;

function profile(network: "instagram" | "tiktok", over: Partial<ProfileRef> = {}): ProfileRef {
  return { source: network, accountId: `${network}-public`, sourceId: null, url: null, canonicalId: null, identityState: "unresolved",
    provenanceRef: `prov:${network}`, handle: null, sourceUpdatedAt: null, ...over };
}
function input(over: Partial<IntakeInput> = {}): IntakeInput {
  const profiles = over.profileRefs ?? [profile("instagram", { sourceId: "ig-1001", handle: "synthetic.maker", sourceUpdatedAt: "2026-11-01T00:00:00Z" })];
  return intakeInputSchema.parse({
    campaignRef: null, briefRef: null, recruitmentSource: "daily-discovery", trigger: "discovery", eventId: "event-1",
    sourceCandidate: { source: "daily-discovery", accountId: "discovery-sandbox", sourceId: "candidate-1", url: null, canonicalId: null, identityState: "unresolved", provenanceRef: "prov:candidate-1" },
    occurredAt: "2026-11-05T10:00:00Z", observedAt: "2026-11-05T11:00:00Z", publishingNetworks: [...new Set(profiles.map((p) => p.source))],
    identityMapVersion: "map-v1", suppressionVersion: "suppression-v1", cursor: null, ...over, profileRefs: profiles,
  });
}
function request(i: IntakeInput, key = `key-${i.recruitmentSource}-${i.eventId}`, over: Record<string, unknown> = {}) {
  return { envelope: { jobId: "J01", jobVersion: "creator-intake.v1", mode: "observe", actor: { id: "agent-intake", role: "agent" }, accountRef: scope,
    policyVersion: "commission-only-v1", inputHash: digest(i), idempotencyKey: key, correlationId: `corr-${i.eventId}`, requestedAt: "2026-11-06T11:59:00Z",
    deadline: null, checkpoint: null, ...over }, input: i };
}
class MemorySink implements IdentitySink {
  rows = new Map<string, CanonicalRecord>();
  writes = 0;
  failNext: "throw" | "throw-after-write" | null = null;
  constructor(readonly name: string) {}
  upsert(key: string, record: CanonicalRecord) {
    this.writes++;
    if (this.failNext === "throw") { this.failNext = null; throw new Error("process stopped before the write"); }
    this.rows.set(key, record);
    if (this.failNext === "throw-after-write") { this.failNext = null; throw new Error("process stopped after the write"); }
    return { receiptRef: `${this.name}:${key}` };
  }
  read(key: string) { return this.rows.has(key) ? { receiptRef: `${this.name}:${key}` } : null; }
}
function setup(over: Partial<IntakeAuthority> = {}, db?: AgentStore) {
  const store = db ?? new AgentStore(":memory:", scope);
  const notion = new MemorySink("notion"), sheets = new MemorySink("sheets");
  const suppression = { version: "suppression-v1", entries: [] as unknown[] };
  const crosswalk = { version: "map-v1", entries: [] as unknown[] };
  const authority: IntakeAuthority = { route: () => "Ready", suppression: (v) => (v === suppression.version ? suppression : null),
    crosswalk: (v) => (v === crosswalk.version ? crosswalk : null), sinks: { "notion-creator-crm": notion, "sheets-watchlist": sheets }, ...over };
  return { store, repo: new IntakeRepository(store.database, scope, authority, clock), notion, sheets, suppression, crosswalk };
}
const creators = (store: AgentStore) => Number(store.database.prepare("SELECT COUNT(*) AS n FROM intake_creators").get()!.n);

describe("J01 intake validation and route permission (J01-01)", () => {
  it("rejects missing keys, a fabricated address and a profile on the wrong network before anything is written", async () => {
    const { repo, store } = setup();
    const bad = { ...request(input()), input: { ...input(), sourceCandidate: undefined } };
    await expect(repo.ingest(bad, "key-bad")).rejects.toThrow();
    expect(() => input({ profileRefs: [profile("tiktok", { url: "https://www.instagram.com/synthetic.maker" })] })).toThrow();
    expect(() => input({ profileRefs: [profile("instagram", { url: "https://user:pw@www.instagram.com/x" })] })).toThrow();
    expect(() => input({ profileRefs: [profile("instagram", { sourceId: "https://www.instagram.com/x" })] })).toThrow();
    expect(creators(store)).toBe(0);
  });
  it("keeps an unknown native ID null instead of inventing one", async () => {
    const { repo } = setup();
    const result = await repo.ingest(request(input({ profileRefs: [profile("instagram", { handle: "no.id.given" })] }), "key-1"), "key-1");
    expect(result).toMatchObject({ creatorRef: null, identityState: "needsReview", watchlistEligibility: "identityPending" });
    expect(result.reviewReasons).toContain("PROFILE_ID_MISSING");
    expect(result.profileRefs[0]).toMatchObject({ sourceId: null, canonicalId: null, identityState: "unresolved" });
  });
  it("pauses a denied or unverified source, keeps its cursor and writes nothing", async () => {
    let state = "Ready";
    const { repo, store } = setup({ route: () => state });
    await repo.ingest(request(input({ cursor: { page: "page-1", position: 20 } }), "key-1"), "key-1");
    state = "Denied";
    await expect(repo.ingest(request(input({ eventId: "event-2", cursor: { page: "page-2", position: 0 } }), "key-2"), "key-2")).rejects.toThrow("SOURCE_DENIED");
    expect(repo.sourceStatus("daily-discovery", "discovery-sandbox")).toMatchObject({ paused: true, pausedReason: "SOURCE_DENIED", cursor: { page: "page-1", position: 20 }, lastEventId: "event-1" });
    state = "Unverified";
    await expect(repo.ingest(request(input({ eventId: "event-3" }), "key-3"), "key-3")).rejects.toThrow("SOURCE_UNVERIFIED");
    expect(repo.event("daily-discovery", "event-2")).toBeNull();
    expect(creators(store)).toBe(1);
  });
  it("refuses outbound modes, the wrong scope, a changed input and a reused key", async () => {
    const { repo } = setup();
    const i = input();
    await expect(repo.ingest(request(i, "k", { mode: "executeApproved" }), "k")).rejects.toThrow("MODE_NOT_SUPPORTED_BY_J01");
    await expect(repo.ingest(request(i, "k", { mode: "propose" }), "k")).rejects.toThrow("MODE_NOT_SUPPORTED_BY_J01");
    await expect(repo.ingest(request(i, "k", { accountRef: { ...scope, accountId: "other" } }), "k")).rejects.toThrow("JOB_SCOPE_MISMATCH");
    await expect(repo.ingest({ ...request(i, "k"), input: { ...i, eventId: "changed" } }, "k")).rejects.toThrow("JOB_INPUT_MISMATCH");
    await repo.ingest(request(i, "k"), "k");
    await expect(repo.ingest(request(input({ eventId: "event-9" }), "k"), "k")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(repo.ingest({ ...request(input({ observedAt: "2026-11-07T00:00:00Z", occurredAt: null, eventId: "future" }), "f") }, "f")).rejects.toThrow("FUTURE_TIMESTAMP");
  });
});

describe("J01 identity resolution (J01-02, J01-03, J01-06, J01-08)", () => {
  it("resolves a signup and an earlier discovery hit into one creator with separate profiles and campaign relationships", async () => {
    const { repo, store } = setup();
    const discovered = await repo.ingest(request(input(), "key-d"), "key-d");
    const signup = await repo.ingest(request(input({
      recruitmentSource: "social-cat", trigger: "signup", eventId: "signup-1",
      sourceCandidate: { source: "social-cat", accountId: "social-cat-sandbox", sourceId: "application-77", url: null, canonicalId: null, identityState: "unresolved", provenanceRef: "prov:application-77" },
      campaignRef: { source: "linear", accountId: "farda", sourceId: null, url: null, canonicalId: "campaign-launch", identityState: "resolved", provenanceRef: "prov:campaign" },
      briefRef: { ref: "brief-lifestyle", version: "v3" },
      profileRefs: [profile("instagram", { sourceId: "ig-1001", handle: "synthetic.maker", sourceUpdatedAt: "2026-11-01T00:00:00Z" }),
        profile("tiktok", { sourceId: "tt-2002", handle: "synthetic.maker", sourceUpdatedAt: "2026-11-02T00:00:00Z" })],
    }), "key-s"), "key-s");
    expect(signup.creatorRef?.canonicalId).toBe(discovered.creatorRef?.canonicalId);
    expect(creators(store)).toBe(1);
    const record = repo.creator(signup.creatorRef!.canonicalId!)!;
    expect(record.profiles.map((p) => p.network)).toEqual(["instagram", "tiktok"]);
    expect(record.relationships).toEqual([expect.objectContaining({ campaignKey: "campaign-launch", state: "active", recruitmentSource: "social-cat" })]);
    expect(signup).toMatchObject({ briefRef: { ref: "brief-lifestyle", version: "v3" }, campaignRef: { canonicalId: "campaign-launch" } });
    // Social Cat is a recruitment source, never a publishing network.
    expect(() => input({ publishingNetworks: ["social-cat" as never] })).toThrow();
  });
  it("never merges two people who share a handle or name, and flags a reassigned handle", async () => {
    const { repo, store } = setup();
    const a = await repo.ingest(request(input({ eventId: "a", profileRefs: [profile("instagram", { sourceId: "ig-1", handle: "same.name" })] }), "ka"), "ka");
    const b = await repo.ingest(request(input({ eventId: "b", profileRefs: [profile("instagram", { sourceId: "ig-2", handle: "same.name" })] }), "kb"), "kb");
    expect(a.creatorRef?.canonicalId).not.toBe(b.creatorRef?.canonicalId);
    expect(creators(store)).toBe(2);
    expect(b.reviewReasons).toContain("HANDLE_PREVIOUSLY_USED_BY_ANOTHER_CREATOR");
  });
  it("follows a renamed handle by native ID and keeps the old handle as an alias", async () => {
    const { repo, store } = setup();
    const first = await repo.ingest(request(input({ eventId: "r1", profileRefs: [profile("tiktok", { sourceId: "tt-9", handle: "old.handle", sourceUpdatedAt: "2026-10-01T00:00:00Z" })] }), "r1"), "r1");
    const renamed = await repo.ingest(request(input({ eventId: "r2", profileRefs: [profile("tiktok", { sourceId: "tt-9", handle: "new.handle", sourceUpdatedAt: "2026-11-01T00:00:00Z" })] }), "r2"), "r2");
    expect(renamed.creatorRef?.canonicalId).toBe(first.creatorRef?.canonicalId);
    expect(creators(store)).toBe(1);
    const record = repo.creator(first.creatorRef!.canonicalId!)!;
    expect(record.profiles[0]!.handle).toBe("new.handle");
    expect(record.aliases.map((a) => a.handle)).toEqual(["new.handle", "old.handle"]);
  });
  it("deduplicates a repeated event and a resumed page without a second person or a second write", async () => {
    const { repo, store, notion } = setup();
    const page = input({ cursor: { page: "page-1", position: 0 } });
    const first = await repo.ingest(request(page, "page-key"), "page-key");
    const again = await repo.ingest(request(page, "page-key"), "page-key");
    const resumed = await repo.ingest(request(page, "resumed-import-key"), "resumed-import-key");
    expect(again).toEqual(first);
    expect(resumed).toEqual(first);
    expect(notion.writes).toBe(1);
    expect(creators(store)).toBe(1);
    await expect(repo.ingest(request({ ...page, observedAt: "2026-11-05T11:30:00Z" }, "changed"), "changed")).rejects.toThrow("EVENT_ID_REUSED");
  });
  it("holds a profile with no native ID until a reviewed crosswalk maps it", async () => {
    const { repo, store, crosswalk } = setup();
    const known = await repo.ingest(request(input({ eventId: "native", profileRefs: [profile("instagram", { sourceId: "ig-55" })] }), "native"), "native");
    const fpProfile = profile("tiktok", { url: "https://www.tiktok.com/@synthetic.fingerprint" });
    const held = await repo.ingest(request(input({ eventId: "fp-1", profileRefs: [fpProfile] }), "fp-1"), "fp-1");
    expect(held).toMatchObject({ creatorRef: null, identityState: "needsReview", watchlistEligibility: "identityPending", nextWork: null, handoffs: [] });
    expect(held.reviewReasons).toContain("IDENTITY_UNRESOLVED");
    crosswalk.entries.push({ network: "tiktok", profileKey: profileKeyOf(fpProfile)!, creatorId: known.creatorRef!.canonicalId!, reviewedRef: "review-12" });
    const mapped = await repo.ingest(request(input({ eventId: "fp-2", profileRefs: [fpProfile] }), "fp-2"), "fp-2");
    expect(mapped.creatorRef?.canonicalId).toBe(known.creatorRef?.canonicalId);
    expect(creators(store)).toBe(1);
  });
  it("sends conflicting profiles to review instead of merging two creators", async () => {
    const { repo, store } = setup();
    await repo.ingest(request(input({ eventId: "x", profileRefs: [profile("instagram", { sourceId: "ig-x" })] }), "x"), "x");
    await repo.ingest(request(input({ eventId: "y", profileRefs: [profile("tiktok", { sourceId: "tt-y" })] }), "y"), "y");
    const both = await repo.ingest(request(input({ eventId: "xy", profileRefs: [profile("instagram", { sourceId: "ig-x" }), profile("tiktok", { sourceId: "tt-y" })] }), "xy"), "xy");
    expect(both).toMatchObject({ creatorRef: null, identityState: "needsReview", watchlistEligibility: "identityPending" });
    expect(both.reviewReasons).toContain("IDENTITY_CONFLICT");
    expect(creators(store)).toBe(2);
  });
  it("lets only a reviewer correction attach a fingerprint profile to a named creator", async () => {
    const { repo } = setup();
    const known = await repo.ingest(request(input({ eventId: "native", profileRefs: [profile("instagram", { sourceId: "ig-77" })] }), "native"), "native");
    const correction = input({ recruitmentSource: "reviewed-correction", trigger: "correction", eventId: "correction-1",
      sourceCandidate: { source: "reviewed-correction", accountId: "farda", sourceId: "review-9", url: null, canonicalId: known.creatorRef!.canonicalId, identityState: "resolved", provenanceRef: "prov:review-9" },
      profileRefs: [profile("tiktok", { url: "https://www.tiktok.com/@synthetic.second" })] });
    await expect(repo.ingest(request(correction, "c1"), "c1")).rejects.toThrow("REVIEWER_REQUIRED_FOR_CORRECTION");
    const applied = await repo.ingest(request(correction, "c2", { actor: { id: "reviewer-1", role: "reviewer" } }), "c2");
    expect(applied).toMatchObject({ identityState: "resolved", creatorRef: { canonicalId: known.creatorRef!.canonicalId } });
    expect(repo.creator(known.creatorRef!.canonicalId!)!.profiles).toHaveLength(2);
  });
  it("keeps one creator when a profile attached by fingerprint later shows its native ID", async () => {
    const { repo, store } = setup();
    const address = "https://www.tiktok.com/@synthetic.grower";
    const signup = await repo.ingest(request(input({
      recruitmentSource: "social-cat", trigger: "signup", eventId: "signup-fp",
      sourceCandidate: { source: "social-cat", accountId: "social-cat-sandbox", sourceId: "application-88", url: null, canonicalId: null, identityState: "unresolved", provenanceRef: "prov:application-88" },
      profileRefs: [profile("instagram", { sourceId: "ig-501" }), profile("tiktok", { url: address })] }), "s"), "s");
    const creatorId = signup.creatorRef!.canonicalId!;
    expect(repo.creator(creatorId)!.profiles.map((p) => [p.network, p.profileKey])).toEqual([["instagram", "id:ig-501"], ["tiktok", fingerprintKeyOf(profile("tiktok", { url: address }))]]);
    const discovered = await repo.ingest(request(input({ eventId: "tt-native", profileRefs: [profile("tiktok", { sourceId: "tt-9", url: address })] }), "d"), "d");
    expect(discovered.creatorRef?.canonicalId).toBe(creatorId);
    expect(discovered.reviewReasons).not.toContain("IDENTITY_CONFLICT");
    expect(creators(store)).toBe(1);
    expect(repo.creator(creatorId)!.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ network: "tiktok", profileKey: "id:tt-9", sourceId: "tt-9", creatorId })]));
  });
});

describe("J01 suppression and closed relationships (J01-04)", () => {
  it("keeps a rediscovered opted-out profile excluded even after the list drops it", async () => {
    const setupA = setup();
    const { repo, suppression } = setupA;
    const first = await repo.ingest(request(input(), "k1"), "k1");
    suppression.entries.push({ subject: { kind: "profile", network: "instagram", profileKey: "id:ig-1001" }, reason: "opt-out", sourceRef: "optout-1", effectiveAt: "2026-11-05T12:00:00Z" });
    const second = await repo.ingest(request(input({ eventId: "event-2" }), "k2"), "k2");
    expect(second).toMatchObject({ watchlistEligibility: "excluded", nextWork: null });
    expect(second.reviewReasons).toContain("SUPPRESSED_OPT_OUT");
    suppression.entries.length = 0;
    const third = await repo.ingest(request(input({ eventId: "event-3" }), "k3"), "k3");
    expect(third.watchlistEligibility).toBe("excluded");
    expect(third.creatorRef?.canonicalId).toBe(first.creatorRef?.canonicalId);
  });
  it("excludes a creator when the event carries a suppressed profile that is not attached", async () => {
    const { repo, suppression } = setup();
    const optedOut = profile("tiktok", { url: "https://www.tiktok.com/@synthetic.optout" });
    suppression.entries.push({ subject: { kind: "profile", network: "tiktok", profileKey: fingerprintKeyOf(optedOut)! }, reason: "opt-out", sourceRef: "optout-7", effectiveAt: "2026-11-05T12:00:00Z" });
    const result = await repo.ingest(request(input({ eventId: "mixed", profileRefs: [profile("instagram", { sourceId: "ig-808" }), optedOut] }), "k"), "k");
    expect(result).toMatchObject({ identityState: "resolved", watchlistEligibility: "excluded", nextWork: null });
    expect(result.reviewReasons).toContain("SUPPRESSED_OPT_OUT");
  });
  it("sends a new revision to Notion and Sheets when a suppression excludes an active creator", async () => {
    const { repo, sheets, suppression } = setup();
    const first = await repo.ingest(request(input(), "k1"), "k1");
    const creatorId = first.creatorRef!.canonicalId!;
    expect(first.handoffs.map((h) => h.state)).toEqual(["confirmed", "confirmed"]);
    expect(sheets.rows.get(`sheets-watchlist:${creatorId}:r1`)).toMatchObject({ watchlistEligibility: "active", suppressed: false });
    suppression.entries.push({ subject: { kind: "profile", network: "instagram", profileKey: "id:ig-1001" }, reason: "opt-out", sourceRef: "optout-2", effectiveAt: "2026-11-05T12:00:00Z" });
    const second = await repo.ingest(request(input({ eventId: "event-2" }), "k2"), "k2");
    expect(second.watchlistEligibility).toBe("excluded");
    expect(second.checkpoint.handoffKeys).toEqual([`notion-creator-crm:${creatorId}:r2`, `sheets-watchlist:${creatorId}:r2`]);
    expect(second.handoffs.map((h) => h.state)).toEqual(["confirmed", "confirmed"]);
    expect(sheets.rows.get(`sheets-watchlist:${creatorId}:r2`)).toMatchObject({ revision: 2, watchlistEligibility: "excluded", suppressed: true });
  });
  it("sends a new revision when eligibility moves from identityPending to active", async () => {
    let available = false;
    const list = { version: "suppression-v1", entries: [] };
    const { repo, sheets } = setup({ suppression: (v) => (available && v === list.version ? list : null) });
    const pending = await repo.ingest(request(input(), "k1"), "k1");
    const creatorId = pending.creatorRef!.canonicalId!;
    expect(pending.watchlistEligibility).toBe("identityPending");
    available = true;
    const active = await repo.ingest(request(input({ eventId: "event-2" }), "k2"), "k2");
    expect(active).toMatchObject({ watchlistEligibility: "active", nextWork: "J20" });
    expect(active.checkpoint.handoffKeys).toEqual([`notion-creator-crm:${creatorId}:r2`, `sheets-watchlist:${creatorId}:r2`]);
    expect(sheets.rows.get(`sheets-watchlist:${creatorId}:r2`)).toMatchObject({ revision: 2, watchlistEligibility: "active", suppressed: false });
  });
  it("fails closed when the suppression list version is unavailable", async () => {
    const { repo } = setup({ suppression: () => null });
    const result = await repo.ingest(request(input(), "k"), "k");
    expect(result).toMatchObject({ watchlistEligibility: "identityPending", nextWork: null });
    expect(result.reviewReasons).toContain("SUPPRESSION_LIST_UNAVAILABLE");
  });
  it("never reopens a closed relationship and never duplicates an active one", async () => {
    const { repo, store } = setup();
    const campaign = { source: "linear", accountId: "farda", sourceId: null, url: null, canonicalId: "campaign-a", identityState: "resolved" as const, provenanceRef: "prov:a" };
    const first = await repo.ingest(request(input({ campaignRef: campaign }), "k1"), "k1");
    const again = await repo.ingest(request(input({ eventId: "event-2", campaignRef: campaign }), "k2"), "k2");
    expect(again.relationshipRefs).toEqual(first.relationshipRefs);
    expect(Number(store.database.prepare("SELECT COUNT(*) AS n FROM intake_relationships").get()!.n)).toBe(1);
    repo.closeRelationship(first.relationshipRefs[0]!.sourceId!, "closure-1");
    const rediscovered = await repo.ingest(request(input({ eventId: "event-3", campaignRef: campaign }), "k3"), "k3");
    expect(rediscovered.watchlistEligibility).toBe("excluded");
    expect(rediscovered.reviewReasons).toContain("RELATIONSHIP_CLOSED");
    expect(repo.creator(first.creatorRef!.canonicalId!)!.relationships[0]!.state).toBe("closed");
  });
});

describe("J01 checkpointed Notion and Sheets handoff (J01-05)", () => {
  it("writes Notion before Sheets, and the watchlist references the Notion receipt", async () => {
    const { repo, notion, sheets } = setup();
    const result = await repo.ingest(request(input(), "k"), "k");
    expect(result.handoffs.map((h) => [h.target, h.state])).toEqual([["notion-creator-crm", "confirmed"], ["sheets-watchlist", "confirmed"]]);
    const [row] = [...sheets.rows.values()];
    expect(row!.canonicalReceiptRef).toBe(result.handoffs[0]!.receiptRef);
    expect(notion.rows.size).toBe(1);
  });
  it("recovers a crash between the two writes on replay without a second person or a second Notion write", async () => {
    const store = new AgentStore(":memory:", scope);
    const first = setup({}, store);
    first.sheets.failNext = "throw";
    const partial = await first.repo.ingest(request(input(), "k"), "k");
    expect(partial.handoffs.map((h) => h.state)).toEqual(["confirmed", "uncertain"]);
    // A restarted worker with new sink connections replays the same event.
    const restarted = setup({}, store);
    restarted.notion.rows = first.notion.rows;
    restarted.sheets.rows = first.sheets.rows;
    const replay = await restarted.repo.ingest(request(input(), "k"), "k");
    expect(replay.handoffs.map((h) => h.state)).toEqual(["confirmed", "confirmed"]);
    expect(restarted.notion.writes).toBe(0);
    expect(creators(store)).toBe(1);
  });
  it("reads an uncertain write back by key before retrying, so a completed write is not repeated", async () => {
    const { repo, notion } = setup();
    notion.failNext = "throw-after-write";
    const uncertain = await repo.ingest(request(input(), "k"), "k");
    expect(uncertain.handoffs.map((h) => h.state)).toEqual(["uncertain", "pending"]);
    const reconciled = await repo.ingest(request(input(), "k", { mode: "reconcile" }), "k");
    expect(reconciled.handoffs.map((h) => h.state)).toEqual(["confirmed", "confirmed"]);
    expect(notion.writes).toBe(1);
  });
  it("supersedes an older revision's unfinished handoff on replay instead of overwriting newer sink data", async () => {
    const { repo, notion, sheets } = setup();
    notion.failNext = "throw";
    const first = await repo.ingest(request(input(), "k1"), "k1");
    const creatorId = first.creatorRef!.canonicalId!;
    expect(first.handoffs.map((h) => h.state)).toEqual(["uncertain", "pending"]);
    const campaign = { source: "linear", accountId: "farda", sourceId: null, url: null, canonicalId: "campaign-b", identityState: "resolved" as const, provenanceRef: "prov:b" };
    const second = await repo.ingest(request(input({ eventId: "event-2", campaignRef: campaign }), "k2"), "k2");
    expect(second.checkpoint.handoffKeys).toEqual([`notion-creator-crm:${creatorId}:r2`, `sheets-watchlist:${creatorId}:r2`]);
    expect(second.handoffs.map((h) => h.state)).toEqual(["confirmed", "confirmed"]);
    const writes = notion.writes;
    const replay = await repo.ingest(request(input(), "k1"), "k1");
    expect(replay.handoffs.map((h) => h.state)).toEqual(["superseded", "superseded"]);
    expect(notion.writes).toBe(writes);
    expect([...notion.rows.keys()]).toEqual([`notion-creator-crm:${creatorId}:r2`]);
    expect([...sheets.rows.keys()]).toEqual([`sheets-watchlist:${creatorId}:r2`]);
  });
  it("shows an unavailable handoff when no sink is configured, without blocking the identity", async () => {
    const { repo } = setup({ sinks: {} });
    const result = await repo.ingest(request(input(), "k"), "k");
    expect(result).toMatchObject({ identityState: "resolved", watchlistEligibility: "active" });
    expect(result.handoffs.map((h) => h.state)).toEqual(["unavailable", "pending"]);
  });
});

describe("J01 times and downstream work (J01-07, J01-09)", () => {
  it("keeps event, source-update, observation and sync times apart, and a late record never overwrites a newer profile", async () => {
    const { repo } = setup();
    const current = await repo.ingest(request(input({ eventId: "new", profileRefs: [profile("instagram", { sourceId: "ig-1", handle: "current.handle", sourceUpdatedAt: "2026-11-04T00:00:00Z" })] }), "new"), "new");
    expect(current.evidenceRefs[0]).toMatchObject({ occurredAt: "2026-11-05T10:00:00Z", sourceUpdatedAt: "2026-11-04T00:00:00Z", observedAt: "2026-11-05T11:00:00Z", syncedAt: NOW.toISOString() });
    const late = await repo.ingest(request(input({ eventId: "late", profileRefs: [profile("instagram", { sourceId: "ig-1", handle: "older.handle", sourceUpdatedAt: "2026-10-01T00:00:00Z" })] }), "late"), "late");
    expect(late.reviewReasons).toContain("LATE_SOURCE_RECORD");
    expect(repo.creator(current.creatorRef!.canonicalId!)!.profiles[0]!.handle).toBe("current.handle");
    expect(late.evidenceRefs).toHaveLength(1);
  });
  it("routes discovery to J20 and signups to J02, and never scores, invites, messages, reserves or pays", async () => {
    const { repo } = setup();
    const discovery = await repo.ingest(request(input(), "d"), "d");
    const signup = await repo.ingest(request(input({ recruitmentSource: "tiktok-shop", trigger: "signup", eventId: "s",
      profileRefs: [profile("tiktok", { sourceId: "tt-3" })] }), "s"), "s");
    expect(discovery.nextWork).toBe("J20");
    expect(signup.nextWork).toBe("J02");
    for (const r of [discovery, signup]) expect(r.outbound).toEqual({ scored: false, invited: false, messaged: false, sampleReserved: false, paid: false });
  });
});

describe("J01 route and authenticated HTTP service", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });
  it("requires the reviewer credential and an idempotency key, and reads results back", async () => {
    const notion = new MemorySink("notion"), sheets = new MemorySink("sheets");
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...scope,
      intakeAuthority: { route: () => "Ready", suppression: () => ({ version: "suppression-v1", entries: [] }), crosswalk: () => ({ version: "map-v1", entries: [] }),
        sinks: { "notion-creator-crm": notion, "sheets-watchlist": sheets } } });
    await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const origin = `http://127.0.0.1:${address.port}`;
    const i = input({ observedAt: new Date(Date.now() - 60_000).toISOString(), occurredAt: null });
    const body = JSON.stringify(request(i, "http-key", { requestedAt: new Date(Date.now() - 60_000).toISOString() }));
    const post = (token: string, key?: string) => fetch(`${origin}/v1/intake`, { method: "POST", body,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) } });
    expect((await post(SYNTHETIC_READ_TOKEN, "http-key")).status).toBe(403);
    expect((await post(SYNTHETIC_REVIEW_TOKEN)).status).toBe(400);
    const saved = await post(SYNTHETIC_REVIEW_TOKEN, "http-key");
    expect(saved.status).toBe(200);
    const result = await saved.json() as { creatorRef: { canonicalId: string } };
    const read = await fetch(`${origin}/v1/intake/events/daily-discovery/event-1`, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    expect(await read.json()).toMatchObject({ creatorRef: { canonicalId: result.creatorRef.canonicalId }, outbound: { invited: false } });
    const creator = await fetch(`${origin}/v1/intake/creators/${result.creatorRef.canonicalId}`, { headers: { authorization: `Bearer ${SYNTHETIC_READ_TOKEN}` } });
    expect(creator.status).toBe(200);
  });
  it("maps validation, conflict and source errors to not-applied responses", async () => {
    const { repo } = setup({ route: () => "Denied" });
    const call = (body: unknown, key = "k") => handleIntakeRoute({ method: "POST", path: "/v1/intake", role: "reviewer", body, idempotencyKey: key }, repo);
    expect(await call({})).toMatchObject({ status: 422, body: { executionCertainty: "notApplied" } });
    expect(await call(request(input(), "k"))).toMatchObject({ status: 503, body: { code: "SOURCE_DENIED" } });
    expect(await call(request(input(), "k", { mode: "propose" }))).toMatchObject({ status: 409, body: { code: "MODE_NOT_SUPPORTED_BY_J01" } });
    expect(await handleIntakeRoute({ method: "GET", path: "/v1/intake/events/daily-discovery/missing", role: "reader" }, repo)).toMatchObject({ status: 404 });
    expect(await handleIntakeRoute({ method: "GET", path: "/v1/offers/x", role: "reader" }, repo)).toBeNull();
  });
});
