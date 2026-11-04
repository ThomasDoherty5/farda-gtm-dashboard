// Starts the reference server. The server reuses the demo services under src/, which use the "@/" alias and TypeScript,
// so this launcher loads them through Vite's SSR loader and the repo's own vite.config.ts. No extra dependency.
// Usage: npm run reference-server   (REFERENCE_SERVER_PORT, REFERENCE_SERVER_ORIGINS, REFERENCE_SERVER_ENVIRONMENT)
import { createServer } from "vite";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to start: the reference server is a test double and does not run when NODE_ENV is production.");
  process.exit(1);
}

const vite = await createServer({ appType: "custom", server: { middlewareMode: true, watch: null }, logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
const shutdown = async () => { await vite.close(); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  const { main } = await vite.ssrLoadModule("/tools/reference-server/main.ts");
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await shutdown();
  process.exit(1);
}
