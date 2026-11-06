// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AssetRepository } from "./assetStore.ts";
import { assetTestDatabase, assetTestNow, assetTestScope, syntheticAsset, syntheticUse } from "./assetTestFixtures.ts";
import { createNotionDriveAssetSource } from "./notionDriveAssetSource.ts";
import type { NotionDriveAssetConfig } from "./notionDriveAssetSource.ts";

// All identifiers and provider payloads in this file are synthetic.
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = { content: uuid(1), collaborations: uuid(2), asset: uuid(3), collab: uuid(4), creator: uuid(5), campaign: uuid(6) };
const folder = "synthetic-allowed-parent";
const fileId = "synthetic-media-file";
const clock = () => assetTestNow;
const config: NotionDriveAssetConfig = {
  scope: assetTestScope, contentDataSourceId: ids.content, collaborationDataSourceId: ids.collaborations,
  notionToken: async () => "synthetic-notion-token",
  drive: { accountId: "synthetic-drive", permissionId: "synthetic-account-permission", parentFolderIds: [folder], token: async () => "synthetic-google-token" },
};
const submission = syntheticAsset({
  assetId: ids.asset, collaborationId: ids.collab, campaignId: ids.campaign, creatorId: ids.creator,
  source: { provider: "google-drive", accountId: "synthetic-drive", sourceId: fileId }, fileVersion: "synthetic-head",
  format: "video/mp4", durationMs: 12_345,
});
const relation = (...ids: string[]) => ({ type: "relation", has_more: false, relation: ids.map((id) => ({ id })) });
const row = (id: string, source: string, properties: Record<string, unknown>) => ({
  object: "page", id, parent: { type: "data_source_id", data_source_id: source }, in_trash: false, is_archived: false,
  last_edited_time: assetTestNow, properties,
});
const asset = () => row(ids.asset, ids.content, {
  Collaboration: relation(ids.collab), Campaign: relation(ids.campaign),
  "Asset link": { type: "url", url: `https://drive.google.com/file/d/${fileId}/view?usp=sharing` },
  "Ad rights approved": { type: "checkbox", checkbox: true }, Status: { type: "status", status: { name: "Approved" } },
  Name: { type: "title", title: [{ plain_text: "synthetic sensitive title" }] },
});
const collab = () => row(ids.collab, ids.collaborations, { Creator: relation(ids.creator), Campaign: relation(ids.campaign) });
const file = () => ({
  kind: "drive#file", id: fileId, trashed: false, parents: [folder], mimeType: "video/mp4", size: "123456",
  headRevisionId: submission.fileVersion, sha256Checksum: "b".repeat(64), capabilities: { canDownload: true },
  videoMediaMetadata: { durationMillis: "12345" },
});
const list = (results: unknown[] = [], next: string | null = null) => ({
  object: "list", results, next_cursor: next, has_more: next !== null, request_status: { type: "complete" },
});
type Reply = (url: URL, opts: RequestInit) => Response;
function setup(reply: Reply, overrides: Partial<NotionDriveAssetConfig> = {}) {
  const calls: { url: URL; opts: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, opts = {}) => {
    if (!(url instanceof URL)) throw new Error("Expected a constructed native URL");
    calls.push({ url, opts }); return reply(url, opts);
  };
  return { calls, ...createNotionDriveAssetSource({ ...config, ...overrides }, { fetch: fetcher, clock }) };
}
const json = (data: unknown) => Response.json(data);
function fileReader(overrides: { asset?: unknown; collab?: unknown; about?: unknown; file?: unknown } = {}) {
  return setup((url) => {
    if (url.pathname === `/v1/pages/${ids.asset}`) return json(overrides.asset ?? asset());
    if (url.pathname === `/v1/pages/${ids.collab}`) return json(overrides.collab ?? collab());
    if (url.pathname === "/drive/v3/about") return json(overrides.about ?? { user: { permissionId: config.drive!.permissionId } });
    if (url.pathname === `/drive/v3/files/${fileId}`) return json(overrides.file ?? file());
    throw new Error("Unexpected request");
  });
}

describe("read-only pagination of the two configured native registries", () => {
  it("uses the token's native bot workspace identity, holding when the provider cannot supply it", async () => {
    const adapter=setup(url=>{
      expect(url.href).toBe("https://api.notion.com/v1/users/me");
      return json({object:"user",type:"bot",bot:{workspace_id:uuid(10)}});
    });
    expect(await adapter.readNotionWorkspace()).toBe(uuid(10));
    expect(await setup(()=>json({object:"user",type:"bot",bot:{workspace_name:"synthetic workspace"}})).readNotionWorkspace()).toBeNull();
    await expect(setup(()=>new Response(null,{status:403})).readNotionWorkspace()).rejects.toMatchObject({authority:"denied",code:"SOURCE_ACCESS_UNAVAILABLE"});
  });
  it("proves complete empty reads for each registry without requiring a Drive grant", async () => {
    const adapter = setup(() => json(list()), { drive: undefined });
    for (const registry of ["content", "collaborations"] as const) {
      expect(await adapter.listRegistryPage(assetTestScope, { registry })).toEqual({
        registry, observedAt: assetTestNow, records: [], coverage: "complete", queryTruncated:false, nextCursor: null, rights: "unverified",
      });
    }
    expect(adapter.calls.map(({ url }) => url.pathname)).toEqual([ids.content, ids.collaborations].map((id) => `/v1/data_sources/${id}/query`));
    for (const { url, opts } of adapter.calls) {
      expect(url.origin).toBe("https://api.notion.com");
      expect(opts).toMatchObject({ method: "POST", redirect: "error", headers: { "Notion-Version": "2026-03-11", Authorization: "Bearer synthetic-notion-token" } });
    }
  });
  it("preserves a native cursor verbatim across pages without disclosing its session data or cross-scope replay", async () => {
    const nativeCursor = "opaque/native cursor with synthetic session==";
    const adapter = setup((_url, opts) => {
      const body = JSON.parse(String(opts.body));
      if (!body.start_cursor) return json(list([asset()], nativeCursor));
      expect(body).toEqual({ start_cursor: nativeCursor, page_size: 1, result_type: "page" });
      return json(list());
    });
    const first = await adapter.listRegistryPage(assetTestScope, { registry: "content", limit: 1 });
    expect(first).toMatchObject({ coverage: "partial", rights: "unverified", records: [{ driveLink: "present" }] });
    expect(first.nextCursor).toBeTruthy();
    for (const value of [fileId, nativeCursor, ids.asset, "synthetic sensitive title", "drive.google.com"]) expect(JSON.stringify(first)).not.toContain(value);
    const next = { registry: "content" as const, cursor: first.nextCursor!, limit: 1 };
    await expect(adapter.listRegistryPage(assetTestScope, { ...next, registry: "collaborations" })).rejects.toMatchObject({ code: "SOURCE_QUERY_INVALID" });
    await expect(adapter.listRegistryPage({ ...assetTestScope, workspaceId: "foreign" }, next)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(adapter.calls).toHaveLength(1);
    expect(await adapter.listRegistryPage(assetTestScope, next)).toMatchObject({ records: [], nextCursor: null, coverage: "partial" });
  });
  it("keeps the native result cap distinct from a complete zero", async () => {
    const adapter = setup(() => json({ ...list(), request_status: { type: "incomplete" } }));
    expect(await adapter.listRegistryPage(assetTestScope, { registry: "content" })).toMatchObject({ records: [], coverage: "partial", nextCursor: null });
  });
  it("keeps redacted references stable across restarts without sharing provider continuations", async () => {
    const options = { fetch: async () => json(list([asset()], "synthetic-cursor")), clock, referenceKey: "synthetic-long-private-reference-key" };
    const first = createNotionDriveAssetSource(config, options);
    const restarted = createNotionDriveAssetSource(config, options);
    const page = await first.listRegistryPage(assetTestScope, { registry: "content" });
    const after = await restarted.listRegistryPage(assetTestScope, { registry: "content" });
    expect(after.records[0]?.recordRef).toBe(page.records[0]?.recordRef);
    await expect(restarted.listRegistryPage(assetTestScope, { registry: "content", cursor: page.nextCursor! }))
      .rejects.toMatchObject({ code: "SOURCE_QUERY_INVALID" });
  });
  it.each([
    [403, "SOURCE_ACCESS_UNAVAILABLE"], [404, "SOURCE_ACCESS_UNAVAILABLE"], [429, "SOURCE_READ_FAILED"], [500, "SOURCE_READ_FAILED"],
  ])("redacts upstream %i and never turns it into an empty registry", async (status, code) => {
    const adapter = setup(() => new Response("synthetic provider secret", { status: Number(status) }));
    await expect(adapter.listRegistryPage(assetTestScope, { registry: "content" })).rejects.toMatchObject({ code, status: 503, message: code });
  });
  it("distinguishes a missing token from a malformed or wrong-parent provider result", async () => {
    const noToken = setup(() => json(list()), { notionToken: async () => null });
    await expect(noToken.listRegistryPage(assetTestScope, { registry: "content" })).rejects.toMatchObject({ code: "SOURCE_ACCESS_UNAVAILABLE" });
    expect(noToken.calls).toHaveLength(0);
    const wrongParent = setup(() => json(list([collab()])));
    await expect(wrongParent.listRegistryPage(assetTestScope, { registry: "content" })).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    const noCursor = setup(() => json({ ...list(), has_more: true }));
    await expect(noCursor.listRegistryPage(assetTestScope, { registry: "content" })).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  });
});

describe("original file verification before asset ingestion", () => {
  it("receipts the exact file revision through the repository and holds reuse despite approved registry metadata", async () => {
    const adapter = fileReader();
    const db = assetTestDatabase();
    try {
      const repository = new AssetRepository(db, assetTestScope, adapter.authority, clock);
      const stored = await repository.ingest({ scope: assetTestScope, expectedVersion: 0, submission }, "synthetic-ingest");
      expect(stored.sourceEvidence).toMatchObject({ scope: assetTestScope, checksum: file().sha256Checksum, availability: "available" });
      expect(await adapter.authority.currentRights(stored, assetTestScope)).toBeNull();
      const use = syntheticUse(submission.assetId);
      expect(await adapter.authority.resolveDestination(use, assetTestScope)).toBeNull();
      expect(await repository.eligibility({ scope: assetTestScope, use })).toMatchObject({
        state: "blocked", publishingAuthorized: false, reasonCodes: expect.arrayContaining(["J09_RIGHTS_UNAVAILABLE"]),
      });
      for (const { url, opts } of adapter.calls) {
        expect(opts).toMatchObject({ method: "GET", redirect: "error" });
        expect(url.searchParams.has("alt")).toBe(false);
        const notion = url.origin === "https://api.notion.com";
        if (!notion) expect(url.origin).toBe("https://www.googleapis.com");
        expect(new Headers(opts.headers).get("Authorization")).toBe(`Bearer synthetic-${notion ? "notion" : "google"}-token`);
      }
    } finally { db.close(); }
  });
  it.each([
    ["unapproved parent", { parents: ["different-parent"] }], ["wrong file identity", { id: "other-file" }],
    ["revision changed", { headRevisionId: "new-head" }], ["checksum unavailable", { sha256Checksum: undefined }],
    ["wrong content type", { mimeType: "image/png" }], ["missing duration", { videoMediaMetadata: undefined }],
    ["wrong duration", { videoMediaMetadata: { durationMillis: "54321" } }], ["zero length", { size: "0" }],
    ["trashed", { trashed: true }], ["restriction", { capabilities: { canDownload: false } }],
    ["shortcut", { shortcutDetails: { targetId: fileId } }],
  ])("rejects %s without recording source evidence", async (_reason, change) => {
    const adapter = fileReader({ file: { ...file(), ...(change as object) } });
    expect(await adapter.authority.resolveSource(submission, assetTestScope)).toBeNull();
  });
  it("defers the Drive lookup until both registry rows and the authenticated Drive account match", async () => {
    const invalid = [
      fileReader({ asset: { ...asset(), parent: { type: "data_source_id", data_source_id: ids.collaborations } } }),
      fileReader({ asset: { ...asset(), properties: { ...asset().properties, Collaboration: relation(uuid(9)) } } }),
      fileReader({ asset: { ...asset(), properties: { ...asset().properties, Campaign: relation() } } }),
      fileReader({ collab: { ...collab(), properties: { ...collab().properties, Creator: { ...relation(ids.creator), has_more: true } } } }),
      fileReader({ collab: { ...collab(), properties: { ...collab().properties, Creator: relation(uuid(9)) } } }),
      fileReader({ about: { user: { permissionId: "foreign-account" } } }),
    ];
    for (const adapter of invalid) {
      expect(await adapter.authority.resolveSource(submission, assetTestScope)).toBeNull();
      expect(adapter.calls.some(({ url }) => url.pathname.includes("/files/"))).toBe(false);
    }
  });
  it.each(["asset revision", "asset link", "collaboration creator", "collaboration source"])(
    "fails closed if the %s changes while Drive answers", async (change) => {
      let observedFile = false;
      const adapter = setup((url) => {
        if (url.pathname === `/v1/pages/${ids.asset}`) {
          const row = asset();
          if (observedFile && change === "asset revision") row.last_edited_time = "2030-02-02T00:00:00Z";
          if (observedFile && change === "asset link") row.properties["Asset link"] = { type: "url", url: null };
          return json(row);
        }
        if (url.pathname === `/v1/pages/${ids.collab}`) {
          const row = collab();
          if (observedFile && change === "collaboration creator") row.properties.Creator = relation(uuid(9));
          if (observedFile && change === "collaboration source") row.parent.data_source_id = ids.content;
          return json(row);
        }
        if (url.pathname === "/drive/v3/about") return json({ user: { permissionId: config.drive!.permissionId } });
        observedFile = true; return json(file());
      });
      expect(await adapter.authority.resolveSource(submission, assetTestScope)).toBeNull();
      expect(observedFile).toBe(true);
    },
  );
  it.each([
    `https://drive.google.com.example.test/file/d/${fileId}/view`, "http://127.0.0.1/private", "file:///private",
    `https://drive.google.com@evil.test/file/d/${fileId}/view`, `https://drive.google.com/open?id=${fileId}&id=other`,
    "https://drive.google.com/file/d/other-file/view",
  ])("never fetches an untrusted registry URL %s", async (url) => {
    const adapter = fileReader({ asset: { ...asset(), properties: { ...asset().properties, "Asset link": { type: "url", url } } } });
    expect(await adapter.authority.resolveSource(submission, assetTestScope)).toBeNull();
    expect(adapter.calls.map(({ url }) => url.origin)).toEqual(["https://api.notion.com"]);
  });
  it("rejects out-of-scope identities and unverified derivatives before contacting any provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createNotionDriveAssetSource(config, { fetch: fetcher });
    expect(await adapter.authority.resolveSource(submission, { ...assetTestScope, accountId: "other" })).toBeNull();
    expect(await adapter.authority.resolveSource({ ...submission, source: { ...submission.source, accountId: "other" } }, assetTestScope)).toBeNull();
    expect(await adapter.authority.resolveSource({ ...submission, lineage: {
      parentAssetId: "parent", parentVersion: 1, changes: ["cut"], editorRef: "editor", provenanceRef: "source",
    } }, assetTestScope)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
