import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/** Optional local integration route. Remote targets, embedded credentials and path rewrites are refused. */
function agentProxy() {
  const target = process.env.FARDA_AGENT_PROXY_TARGET;
  if (!target) return undefined;
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("FARDA_AGENT_PROXY_TARGET must be a credential-free loopback origin.");
  return { "/v1": { target: url.origin, changeOrigin: false } };
}

const proxy = agentProxy();

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        // Third-party code changes far less often than the app, so it gets its own cacheable chunks.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/(react-router|react-router-dom|@remix-run)\//.test(id)) return "vendor-router";
          if (/node_modules\/(@tanstack|zod)\//.test(id)) return "vendor-data";
          return undefined;
        },
      },
    },
  },
  server: { port: 5173, strictPort: true, proxy },
  preview: { proxy },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tools/**/*.test.ts"],
    restoreMocks: true,
    // Keep local verification within a low-memory machine; no concurrent test files.
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
