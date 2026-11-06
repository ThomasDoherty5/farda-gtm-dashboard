import { z } from "zod";
import { createNotionDriveAssetSource } from "./notionDriveAssetSource.ts";
import type { AssetScope } from "./assets.ts";
import { createLinearPortfolioAuthority } from "./linearPortfolioAuthority.ts";

const ref = z.string().min(1).max(240);
const configSchema = z.object({ contentDataSourceId: z.string().uuid(), collaborationDataSourceId: z.string().uuid(),
  drive: z.object({ accountId: ref, permissionId: ref, parentFolderIds: z.array(ref).min(1).max(30) }).strict().optional() }).strict();
const portfolioConfig = z.object({ organizationId: z.string().uuid(), teamId: z.string().uuid(), issueIds: z.array(z.string().uuid()).min(1).max(100),
  founderUserIds: z.array(z.string().uuid()).min(1).max(25), j04WriterBotIds: z.array(z.string().uuid()).max(25).optional(),
  approvedLaunchAt: z.string().datetime({ offset: true }).nullable().optional(), credentialKind: z.enum(["api-key", "oauth"]).default("api-key") }).strict();

/** Source identifiers and credentials are resolved only by the native server launcher. */
export function loadCreatorSourceRuntime(env: Record<string, string | undefined>, scope: AssetScope) {
  const portfolioAuthority = (() => {
    if (!env.FARDA_PORTFOLIO_SOURCE_CONFIG) return undefined;
    try {
      const { credentialKind, ...binding } = portfolioConfig.parse(JSON.parse(env.FARDA_PORTFOLIO_SOURCE_CONFIG));
      return createLinearPortfolioAuthority({ ...binding, scope, credential: env.FARDA_LINEAR_READ_TOKEN ? { kind: credentialKind, value: env.FARDA_LINEAR_READ_TOKEN } : undefined });
    } catch { throw new Error("FARDA_PORTFOLIO_SOURCE_CONFIG is invalid."); }
  })();
  if (!env.FARDA_ASSET_SOURCE_CONFIG) return { portfolioAuthority };
  let config: z.infer<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(env.FARDA_ASSET_SOURCE_CONFIG)); }
  catch { throw new Error("FARDA_ASSET_SOURCE_CONFIG is invalid."); }
  const source = createNotionDriveAssetSource({ ...config, scope,
    notionToken: async () => env.FARDA_NOTION_READ_TOKEN ?? null,
    drive: config.drive ? { ...config.drive, token: async () => env.FARDA_DRIVE_ACCESS_TOKEN ?? null } : undefined,
  }, { referenceKey: env.FARDA_AGENT_READ_TOKEN });
  return { portfolioAuthority, assetAuthority: source.authority, assetRegistryReader: source.listRegistryPage };
}
