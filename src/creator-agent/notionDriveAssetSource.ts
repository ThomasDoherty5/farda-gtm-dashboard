import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { assetIdSchema, assetScopeSchema, sameAssetScope, unavailableAssetAuthority } from "./assets.ts";
import type { AssetAuthority, AssetScope, AssetSubmission } from "./assets.ts";
import { digest } from "./config.ts";

// Credentials and provider identifiers belong in private server configuration.
type TokenReader = () => Promise<string | null>;
type DriveBinding = { accountId: string; permissionId: string; parentFolderIds: string[]; token: TokenReader };
export type NotionDriveAssetConfig = {
  scope: AssetScope; contentDataSourceId: string; collaborationDataSourceId: string;
  notionToken: TokenReader; drive?: DriveBinding;
};
export type AssetRegistryQuery = { registry: "content" | "collaborations"; cursor?: string; limit?: number };
export type AssetRegistryPage = {
  registry: AssetRegistryQuery["registry"]; observedAt: string;
  records: { recordRef: string; registryEditedAt: string; driveLink: "present" | "absent" | "unsupported" | "not_applicable" }[];
  coverage: "complete" | "partial"; queryTruncated?: boolean; nextCursor: string | null; rights: "unverified";
};
export class AssetRegistryReadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly authority: "expired"|"denied"|"unknown";
  constructor(code: string, status: number, authority: "expired"|"denied"|"unknown" = "unknown") {
    super(code); this.code = code; this.status = status; this.authority = authority;
  }
}
const badResponse = () => new AssetRegistryReadError("SOURCE_RESPONSE_INVALID", 502);
const missingAccess = (authority: "expired"|"denied"|"unknown" = "unknown") => new AssetRegistryReadError("SOURCE_ACCESS_UNAVAILABLE", 503, authority);
const invalidQuery = () => new AssetRegistryReadError("SOURCE_QUERY_INVALID", 400);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pageId = z.string().regex(uuidPattern).transform((id) => id.toLowerCase());
const driveId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const notionPage = z.object({
  object: z.literal("page"), id: pageId, parent: z.object({ type: z.literal("data_source_id"), data_source_id: pageId }),
  last_edited_time: z.string().datetime({ offset: true }), in_trash: z.literal(false),
  is_archived: z.literal(false).optional(), archived: z.literal(false).optional(), properties: z.record(z.unknown()),
});
type RegistryRow = z.infer<typeof notionPage>;
const notionList = z.object({
  object: z.literal("list"), results: z.array(notionPage).max(100), has_more: z.boolean(),
  next_cursor: z.string().min(1).max(6000).nullable(),
  request_status: z.object({ type: z.enum(["complete", "incomplete"]) }).optional(),
});
const querySchema = z.object({
  registry: z.enum(["content", "collaborations"]), cursor: z.string().min(1).max(8192).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();
const relation = z.object({ type: z.literal("relation"), relation: z.array(z.object({ id: pageId })), has_more: z.literal(false).optional() });
const linkProperty = z.object({ type: z.literal("url"), url: z.string().max(2048).nullable() });
const googleFile = z.object({
  id: driveId, kind: z.literal("drive#file"), trashed: z.literal(false), parents: z.array(driveId).length(1),
  mimeType: z.string(), size: z.string().regex(/^[1-9][0-9]*$/), headRevisionId: assetIdSchema,
  sha256Checksum: z.string().regex(/^[0-9a-f]{64}$/), capabilities: z.object({ canDownload: z.literal(true) }),
  shortcutDetails: z.never().optional(), videoMediaMetadata: z.object({ durationMillis: z.string().regex(/^[1-9][0-9]*$/) }).optional(),
});

function fileIdFromLink(raw: string | null) {
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.origin !== "https://drive.google.com" || url.username || url.password) return null;
  const match = /^\/file\/d\/([A-Za-z0-9_-]{1,128})(?:\/(?:view|preview))?\/?$/.exec(url.pathname);
  if (match) return match[1]!;
  if (url.pathname === "/open" && url.searchParams.getAll("id").length === 1) {
    const parsed = driveId.safeParse(url.searchParams.get("id"));
    if (parsed.success) return parsed.data;
  }
  return null;
}
function matchesRelation(row: RegistryRow, name: string, expected: string | null) {
  const parsed = relation.safeParse(row.properties[name]);
  if (!parsed.success) return false;
  const ids = parsed.data.relation;
  return expected === null ? ids.length === 0 : ids.length === 1 && ids[0]?.id === expected;
}

// Never follow an external URL or pre-signed storage link. Both token audiences are fixed.
async function readJson(fetcher: typeof fetch, url: URL, token: string | null, body?: object, signal?: AbortSignal): Promise<unknown> {
  if (!token) throw missingAccess();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (url.origin === "https://api.notion.com") headers["Notion-Version"] = "2026-03-11";
  if (body) headers["Content-Type"] = "application/json";
  try {
    const response = await fetcher(url, {
      method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
      redirect: "error", signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw missingAccess("expired");
      if (response.status === 403) throw missingAccess("denied");
      if (response.status === 404) throw missingAccess();
      throw new AssetRegistryReadError("SOURCE_READ_FAILED", 503);
    }
    const reader = response.body?.getReader();
    if (!reader) throw badResponse();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2_000_000) { await reader.cancel(); throw badResponse(); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw badResponse(); }
  } catch (error) {
    if (error instanceof AssetRegistryReadError) throw error;
    throw new AssetRegistryReadError("SOURCE_READ_FAILED", 503);
  }
}

// Provider continuations can contain session metadata. Authenticated encryption keeps
// them private and binds them to this source and service scope. Restart begins a fresh scan.
function sealCursor(key: Buffer, binding: string, cursor: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(binding));
  const bytes = Buffer.concat([cipher.update(cursor, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
}
function openCursor(key: Buffer, binding: string, cursor: string) {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length <= 28 || bytes.toString("base64url") !== cursor) throw invalidQuery();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch { throw invalidQuery(); }
}

export function createNotionDriveAssetSource(config: NotionDriveAssetConfig, options: {
  fetch?: typeof fetch; clock?: () => string; referenceKey?: string;
} = {}) {
  const scope = assetScopeSchema.parse(config.scope);
  const ids = { content: pageId.parse(config.contentDataSourceId), collaborations: pageId.parse(config.collaborationDataSourceId) };
  if (ids.content === ids.collaborations) throw new Error("SOURCE_CONFIGURATION_INVALID");
  const drive = config.drive;
  if (drive) {
    assetIdSchema.parse(drive.accountId); driveId.parse(drive.permissionId);
    z.array(driveId).min(1).max(100).parse(drive.parentFolderIds);
  }
  const folders = new Set(drive?.parentFolderIds);
  const secret = randomBytes(32);
  const referenceKey = options.referenceKey ?? secret;
  if (typeof referenceKey === "string" && Buffer.byteLength(referenceKey) < 16) throw new Error("SOURCE_REFERENCE_KEY_INVALID");
  const clock = options.clock ?? (() => new Date().toISOString());
  const fetcher = options.fetch ?? fetch;
  const notionUrl = (resource: string) => new URL(`https://api.notion.com/v1/${resource}`);
  const driveUrl = (resource: string, fields: string) => {
    const url = new URL(`https://www.googleapis.com/drive/v3/${resource}`);
    url.searchParams.set("fields", fields);
    return url;
  };
  async function notionToken() {
    try { return await config.notionToken(); } catch { throw missingAccess(); }
  }
  /** Native identity of the current integration, independent of any configured account label. */
  async function readNotionWorkspace(signal?: AbortSignal): Promise<string|null> {
    const identity = z.object({ object:z.literal("user"),type:z.literal("bot"),bot:z.object({workspace_id:pageId}) });
    try {
      const result=identity.safeParse(await readJson(fetcher,notionUrl("users/me"),await notionToken(),undefined,signal));
      return result.success ? result.data.bot.workspace_id : null;
    } catch (error) {
      if (error instanceof AssetRegistryReadError && (error.authority !== "unknown" || error.code !== "SOURCE_ACCESS_UNAVAILABLE")) throw error;
      return null;
    }
  }
  async function listRegistryPage(requestScope: AssetScope, input: AssetRegistryQuery, signal?: AbortSignal): Promise<AssetRegistryPage> {
    if (!sameAssetScope(scope, requestScope)) throw new AssetRegistryReadError("SCOPE_DENIED", 403);
    const validated = querySchema.safeParse(input);
    if (!validated.success) throw invalidQuery();
    const { registry, limit, cursor } = validated.data;
    const source = ids[registry];
    const binding = digest({ scope, source });
    const start = cursor ? openCursor(secret, binding, cursor) : undefined;
    const data = await readJson(fetcher, notionUrl(`data_sources/${source}/query`), await notionToken(), {
      page_size: limit, result_type: "page", ...(start ? { start_cursor: start } : {}),
    },signal);
    const parsed = notionList.safeParse(data);
    if (!parsed.success) throw badResponse();
    const page = parsed.data;
    if (page.results.length > limit || page.has_more !== (page.next_cursor !== null) || (start && page.next_cursor === start)) throw badResponse();
    const records = page.results.map((row): AssetRegistryPage["records"][number] => {
      if (row.parent.data_source_id !== source) throw badResponse();
      let driveLink: AssetRegistryPage["records"][number]["driveLink"] = "not_applicable";
      if (registry === "content") {
        const link = linkProperty.safeParse(row.properties["Asset link"]);
        if (!link.success) throw badResponse();
        driveLink = link.data.url === null ? "absent" : fileIdFromLink(link.data.url) ? "present" : "unsupported";
      }
      return { recordRef: createHmac("sha256", referenceKey).update(binding + row.id).digest("hex"), registryEditedAt: row.last_edited_time, driveLink };
    });
    return {
      registry, observedAt: clock(), records, rights: "unverified",
      coverage: !cursor && !page.has_more && page.request_status?.type !== "incomplete" ? "complete" : "partial",
      queryTruncated:page.request_status?.type === "incomplete",
      nextCursor: page.next_cursor ? sealCursor(secret, binding, page.next_cursor) : null,
    };
  }

  async function registryRow(id: string, source: string, token: string | null) {
    const parsed = notionPage.safeParse(await readJson(fetcher, notionUrl(`pages/${id}`), token));
    if (!parsed.success || parsed.data.id !== id || parsed.data.parent.data_source_id !== source) return null;
    return parsed.data;
  }
  function bindsAsset(row: RegistryRow | null, submission: AssetSubmission): row is RegistryRow {
    if (!row || !matchesRelation(row, "Collaboration", submission.collaborationId)
        || !matchesRelation(row, "Campaign", submission.campaignId)) return false;
    const link = linkProperty.safeParse(row.properties["Asset link"]);
    return link.success && fileIdFromLink(link.data.url) === submission.source.sourceId;
  }
  function bindsCollaboration(row: RegistryRow | null, submission: AssetSubmission): row is RegistryRow {
    return !!row && matchesRelation(row, "Creator", submission.creatorId) && matchesRelation(row, "Campaign", submission.campaignId);
  }
  async function resolveSource(submission: AssetSubmission, requestScope: AssetScope) {
    // The registry has no authoritative derivative provenance. Its rights flags are never grants.
    if (!sameAssetScope(scope, requestScope) || !drive || submission.lineage || submission.source.provider !== "google-drive"
        || submission.source.accountId !== drive.accountId || !driveId.safeParse(submission.source.sourceId).success) return null;
    if (![submission.assetId, submission.collaborationId, submission.creatorId, ...(submission.campaignId ? [submission.campaignId] : [])]
      .every((id) => uuidPattern.test(id) && id === id.toLowerCase())) return null;
    try {
      const token = await notionToken();
      const asset = await registryRow(submission.assetId, ids.content, token);
      if (!bindsAsset(asset, submission)) return null;
      const collaboration = await registryRow(submission.collaborationId, ids.collaborations, token);
      if (!bindsCollaboration(collaboration, submission)) return null;
      const driveToken = await drive.token();
      const about = await readJson(fetcher, driveUrl("about", "user(permissionId)"), driveToken);
      if (!z.object({ user: z.object({ permissionId: z.literal(drive.permissionId) }) }).safeParse(about).success) return null;
      const fileUrl = driveUrl(`files/${submission.source.sourceId}`, "kind,id,trashed,parents,mimeType,size,headRevisionId,sha256Checksum,capabilities(canDownload),shortcutDetails,videoMediaMetadata(durationMillis)");
      fileUrl.searchParams.set("supportsAllDrives", "true");
      const parsed = googleFile.safeParse(await readJson(fetcher, fileUrl, driveToken));
      if (!parsed.success) return null;
      const file = parsed.data;
      if (file.id !== submission.source.sourceId || !folders.has(file.parents[0]!) || file.headRevisionId !== submission.fileVersion
          || file.mimeType !== submission.format) return null;
      if (submission.format.startsWith("video/")) {
        if (!submission.durationMs || Number(file.videoMediaMetadata?.durationMillis) !== submission.durationMs) return null;
      } else if (submission.durationMs !== null) return null;
      // A registry row may be reassigned, moved, or trashed while Drive is answering.
      const [currentAsset, currentCollaboration] = await Promise.all([
        registryRow(asset.id, ids.content, token), registryRow(collaboration.id, ids.collaborations, token),
      ]);
      if (!bindsAsset(currentAsset, submission) || !bindsCollaboration(currentCollaboration, submission)
          || currentAsset.last_edited_time !== asset.last_edited_time
          || currentCollaboration.last_edited_time !== collaboration.last_edited_time) return null;
      // This receipts only storage, revision and registry ownership of the requested file.
      // The submission's descriptive brief/product fields still require independent J09 review.
      const authorizationRef = digest({ scope, account: drive.accountId, folder: file.parents[0], revision: file.headRevisionId,
        file: file.id, checksum: file.sha256Checksum, asset: asset.id, collaboration: collaboration.id });
      return { scope, submissionHash: digest(submission), observedAt: clock(), availability: "available" as const, checksum: file.sha256Checksum, authorizationRef };
    } catch { return null; }
  }
  const authority: AssetAuthority = { ...unavailableAssetAuthority, resolveSource };
  return { listRegistryPage, readNotionWorkspace, authority };
}
