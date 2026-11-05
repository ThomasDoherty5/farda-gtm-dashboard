import { readRuntimeConfig } from "./runtime-config.mjs";

try {
  const { host, port } = readRuntimeConfig();
  const address = host === "::" || host === "::1" ? "[::1]" : host === "0.0.0.0" ? "127.0.0.1" : host;
  const response = await fetch(`http://${address}:${port}/health`, { signal: AbortSignal.timeout(3_000), redirect: "error" });
  const result = await response.json();
  if (!response.ok || result.service !== "farda-creator-agent" || typeof result.schemaVersion !== "string") throw new Error("Unhealthy agent.");
} catch {
  console.error("Creator agent health probe failed.");
  process.exitCode = 1;
}
