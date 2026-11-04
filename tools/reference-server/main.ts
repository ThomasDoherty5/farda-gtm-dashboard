import { startReferenceServer } from "./server";

/** The command-line entry. Started through `npm run reference-server`, which loads this file with the repo's Vite config. */
export async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to start: the reference server is a test double and does not run when NODE_ENV is production.");
    process.exit(1);
  }
  const port = Number(process.env.REFERENCE_SERVER_PORT ?? 8787);
  const origins = process.env.REFERENCE_SERVER_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  const server = await startReferenceServer({
    port,
    environment: process.env.REFERENCE_SERVER_ENVIRONMENT === "production" ? "production" : "sandbox",
    ...(origins ? { allowedOrigins: origins } : {}),
    log: (line) => console.error(line),
  });
  const bar = "=".repeat(78);
  console.log(
    [
      bar,
      "  REFERENCE SERVER: a test double, NOT the backend.",
      "  It serves the demo fixtures over real HTTP so the live adapter's path can be tested.",
      "  No identity provider, database, hosting or provider integration exists. THO-283 is not done.",
      bar,
      `  Listening on ${server.url} (127.0.0.1 only), environment: ${server.environment}`,
      `  Fake sign-in (dev only): ${server.url}/dev/sign-in?user=<${server.users.map((u) => u.role).join("|")}>&next=/`,
      "  Build the app with VITE_FARDA_ADAPTER=sandbox and VITE_FARDA_ADAPTER_BASE_URL=http://localhost:" + server.port,
      bar,
    ].join("\n"),
  );
  const stop = () => void server.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
