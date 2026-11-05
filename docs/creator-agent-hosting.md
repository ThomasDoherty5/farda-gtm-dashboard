# Hosted creator API

This packages the existing authenticated reviewed-evidence API. It remains a **sandbox** service with the approved scorecard bindings. No source search, video collection, Zap, invitation or outreach is activated. Frontend hosting is outside this deployment package.

## Runtime and storage

Use Node24 and one running service instance. `tools/creator-agent/run.mjs` is the entrypoint; it loads the approved configurations by default. Native TypeScript execution is used, so include the source files and configuration JSON in the release artifact. The API image is `tools/creator-agent/Dockerfile`, built with the repository root as context. The root `.dockerignore` allowlists its public runtime files and excludes local dependencies, tests, credentials, private handoffs and SQLite files. Do not copy a developer workspace wholesale into an image.

The process runs as the unprivileged `node` user in the image. Mount private durable storage at `/var/lib/farda-agent` (or supply another database path). Prepare the mounted directory for that runtime user with mode0700. The launcher uses umask077; it creates new parent directories restrictively but does not change ownership/permissions on an existing provider mount. SQLite main/WAL/SHM files must remain together on the same local persistent volume. Do not use ephemeral instance storage, a shared network filesystem or multiple independently scaled writers. Keep one replica and avoid overlapping old/new instances during rollout.

Pin the tested image digest and source commit in the deployment record. The Dockerfile tracks Node24; an actual release must record the resolved image digest and Node version. No local Docker build is required to prepare the artifact; cloud installation uses `npm ci --omit=dev --ignore-scripts`.

## Private deployment variables

Supply these through the hosting environment's private settings; never use `VITE_` variables, URLs, public build arguments or Linear descriptions for secrets.

| Variable | Meaning |
| --- | --- |
| `FARDA_AGENT_READ_TOKEN` | Private random reader credential, at least32 characters |
| `FARDA_AGENT_REVIEW_TOKEN` | Different private random reviewer credential, at least32 characters |
| `FARDA_AGENT_WORKSPACE_ID` / `FARDA_AGENT_ACCOUNT_ID` | Exact authorized scope; persisted database scope must match |
| `FARDA_AGENT_DATABASE` | Absolute durable SQLite path; image default `/var/lib/farda-agent/evidence.sqlite` |
| `FARDA_AGENT_HOST` | Default `127.0.0.1`; use explicit `0.0.0.0` or `::` only behind a trusted TLS ingress |
| `FARDA_AGENT_PORT` | Explicit port, overriding platform `PORT`; otherwise `PORT`, then8787 |
| `FARDA_AGENT_ORIGIN` | Exact public HTTPS origin, without a path, query, fragment or credentials |
| `FARDA_AGENT_SECURE_COOKIES` | Set `true` for TLS deployment |
| `FARDA_AGENT_CONFIG` | Optional private immutable binding file; default is the approved checked-in bindings |

The launcher rejects unrecognized interface names, invalid ports and non-loopback binding without both an explicit HTTPS origin and secure cookies. Loopback remains appropriate when the TLS proxy shares the host. An origin can use HTTP only for local development. These checks cannot verify that an external proxy actually terminates TLS; HTTPS acceptance must be tested at the public endpoint.

## TLS and ingress

Terminate TLS at the hosting ingress or a reverse proxy, forward the API without path rewriting and preserve its HTTP status codes. Publish only the intended API origin; do not expose the bare HTTP port on the public network. Configure the exact public origin above so cookie-authenticated writes retain same-origin/CSRF checks. Keep `Authorization`, `Cookie`, `Set-Cookie`, request bodies and source records out of access logs. Apply bounded request size/time limits and authentication-attempt rate limiting at ingress; the application already limits JSON bodies to1MiB and request/header timeouts.

`GET /health` is a public liveness check containing only service/schema identity. The included healthcheck probes loopback with a3-second deadline. It is not a backup or database-readiness guarantee. All `/v1/*` operations require application authentication except the reader authentication bootstrap itself, which still rejects invalid credentials. Unimplemented views/actions remain unavailable; never route API failures to a static HTML fallback.

The API currently reports and enforces `environment: sandbox`. Hosting it does not promote the wider dashboard or grant production/provider permissions. A separately hosted browser UI needs an approved same-origin gateway arrangement; this API package adds no cross-origin cookie/CORS relaxation.

## Backup and isolated restore check

Use `tools/creator-agent/backup.mjs` under Node24. It uses the [official Node SQLite online-backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackupsourceDb-path-options), not a copy of a live main file that omits WAL state. It reserves a new destination and refuses to overwrite an existing backup.

```sh
node tools/creator-agent/backup.mjs create /private-volume/evidence.sqlite /private-backups/new-snapshot.sqlite
node tools/creator-agent/backup.mjs verify /private-backups/new-snapshot.sqlite
```

The helper checks integrity/storage schema/scope, restores into a temporary isolated SQLite file and checks record counts plus one bounded application record/hash round trip when records exist. Supply the expected workspace/account variables to verify the exact scope. Output contains only counts/status, never IDs or record text. This checks recoverability of the snapshot; it does not overwrite the running service or validate every historical evidence claim.

Schedule backups in the hosting environment with a job timeout/retry policy; continuous writes on another SQLite connection can restart an online backup. Keep encrypted, access-controlled copies beyond the service volume, with approved retention and storage capacity monitoring. The helper prepares/verifies snapshots but does not provision a scheduler or off-site storage. To recover, stop the service, preserve its current files separately, restore a verified snapshot to a fresh private directory with correct ownership, then restart and verify scope/config/readiness. Do not replace an open database or discard a live WAL file.

## Acceptance before connecting Zapier

1. Record source commit, immutable image digest, Node version, private storage location, scope owner and backup owner without recording secret values.
2. Verify public HTTPS and `/health`; unauthenticated `/v1/capabilities` must return401. With the private reader connection, confirm sandbox scope, both approved model hashes and `sourceAutomation: notConnected`.
3. Use one reviewed synthetic packet to verify authenticated idempotent PUT, exact saved-run GET/read views and persisted results after a controlled restart. Confirm a reader cannot write and a wrong scope cannot read. Avoid logging packet contents.
4. Verify Secure/HttpOnly/SameSite cookie behavior if browser sessions are exposed; verify failed authorization cannot return protected records. Confirm ingress blocks direct public HTTP and does not cache authenticated responses.
5. Create and verify an isolated backup, then complete the documented recovery drill before collecting irreplaceable records. Exercise SIGTERM; shutdown is single-flight with a15-second deadline and unsuccessful exit on failure.
6. Only after the reachable authenticated TLS endpoint passes these checks, connect the private Zapier HTTP credential. The owner must complete login/MFA when prompted. No Zap publication, schedule or creator contact is implied by deployment.

Local focused checks for this wrapper (synthetic data only, serial):

```sh
node --test --test-concurrency=1 tools/creator-agent/deployment.test.mjs
```

The test covers interface/port/TLS settings, bounded shutdown, a live-WAL backup with isolated restore verification, refusal to overwrite, and the actual launcher/authentication/data permissions. Run repository verification separately and record cloud/container smoke results on the hosting/adapter issue. A prepared image definition is not a deployed service.
