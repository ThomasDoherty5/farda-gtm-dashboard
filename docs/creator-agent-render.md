# Render creator API deployment

`deploy/render-creator-agent.yaml` prepares a native Node API service with persistent SQLite storage. It does not deploy the dashboard or activate discovery, collection, Zapier schedules, invitations or outreach. The API continues to enforce its existing **sandbox** scope and approved scorecard configurations. Creating the Render service is a separate, owner-approved paid action.

## Resources and cost

The blueprint specifies one `0.5c-512mb` web instance in Oregon and a 1 GB persistent disk. Render lists this compute plan at $7/month and persistent disks at $0.25/GB/month: approximately **$7.25/month** for these resources, before workspace fees, usage, taxes or other services. Confirm the actual billing preview before creating it. This is not the free plan. Prices checked on 2026-11-04 against [Render pricing](https://render.com/pricing); plan IDs are defined in the [Blueprint reference](https://render.com/docs/blueprint-spec).

The API runs one process and one instance. A disk-backed service cannot scale to multiple instances and has brief downtime during deployment. The disk is available only at runtime; this blueprint does not run database initialization during build. See [Render disk behavior](https://render.com/docs/disks).

## Configuration

| Setting | Blueprint value / handling |
| --- | --- |
| Blueprint path | `deploy/render-creator-agent.yaml`; repository root remains the application root |
| Runtime | Native Node, pinned to `24.18.0` using `NODE_VERSION` |
| Build | `npm ci --omit=dev --ignore-scripts`; no browser build or local Docker build |
| Start | `tools/creator-agent/run.mjs`, using native TypeScript support |
| Listen address | `0.0.0.0`, behind Render TLS ingress |
| Port | Render's `PORT`; leave `FARDA_AGENT_PORT` unset |
| Public origin | Exact `RENDER_EXTERNAL_URL` supplied by Render, passed to `FARDA_AGENT_ORIGIN` at startup |
| Cookies | `FARDA_AGENT_SECURE_COOKIES=true`; application sessions remain HttpOnly and SameSite Strict |
| Persistent mount | `/var/data`, 1 GB |
| SQLite path | `/var/data/farda/evidence.sqlite`; main, WAL and SHM files stay together |
| Reader credential | `FARDA_AGENT_READ_TOKEN`, generated privately by Render |
| Reviewer credential | `FARDA_AGENT_REVIEW_TOKEN`, separately generated privately by Render |
| Authorized scope | `FARDA_AGENT_WORKSPACE_ID` and `FARDA_AGENT_ACCOUNT_ID`, entered privately during initial setup (`sync: false`) |
| Scorecards | Default approved checked-in bindings; leave `FARDA_AGENT_CONFIG` unset |
| Health check | Public `GET /health`, containing service/schema identity only |
| Deploy behavior | `autoDeployTrigger: off`; one instance; preview environments disabled |

Render documents explicit Node version selection in [Node version configuration](https://render.com/docs/node-version); the pinned release has [official Node release artifacts](https://nodejs.org/download/release/v24.18.0/SHASUMS256.txt). It also documents `RENDER_EXTERNAL_URL` as the service's full HTTPS `onrender.com` URL and provides `PORT`. See [default environment variables](https://render.com/docs/environment-variables). Startup performs shell expansion because Blueprint environment values do not interpolate variables. No application code trusts a request header to determine its public origin.

The two generated credentials use independent Render `generateValue: true` entries. Render generates 256-bit base64 values, exceeding the API's 32-character minimum; the API rejects identical credentials. Keep them in the private service settings and an approved credential manager. Never put them in Git, `VITE_` variables, browser storage, public URLs, screenshots, logs, Linear descriptions or Notion pages. Scope IDs are internal Farda authorization values, not external commerce account IDs. The SQLite file becomes bound to that exact workspace/account pair; changing scope cannot repurpose an existing database.

`sync: false` prompts only during initial Blueprint creation. Later secret/scope changes require the service's private environment settings. See [Blueprint environment settings](https://render.com/docs/blueprint-spec#setting-environment-variables). The derived origin intentionally matches the default `onrender.com` origin. A future custom domain or browser gateway needs its own reviewed exact-origin configuration; merely adding a domain does not change this value or enable cross-origin cookies/CORS.

## Manual release

1. Obtain approval for the hosting owner, expected recurring cost and private authorization scope. Confirm the intended source commit has passed the repository's required checks. Do not create resources from this document alone.
2. In Render, connect the approved repository and create a Blueprint using `deploy/render-creator-agent.yaml`. Review the resource preview, region, one-instance setting and billing before applying. Initial creation can deploy the service even though subsequent automatic deploys are disabled.
3. Enter the authorized internal workspace/account values in the private setup prompts. Retain the generated credentials privately. Leave the existing model-binding defaults intact. Record the deployment's actual source SHA and Node version; use a manually selected, verified commit for subsequent releases rather than assuming the latest branch head is tested. [Render manual deploys](https://render.com/docs/deploys#manual-deploys) describes deploying a specific commit.
4. Confirm the persistent disk is attached and the launcher can create its private `farda` directory. Do not move the database to ephemeral application storage to bypass a permission problem. The launcher creates new data directories with mode `0700` and uses umask `077`.
5. Complete acceptance below, then record the public service URL, source SHA, Node version, deployment time, exact configuration hashes, scope owner and backup owner in the private deployment record. Record references, not secret values or source packets.

The blueprint's manual-deploy setting prevents a Git push from automatically releasing new code. Blueprint synchronization/configuration changes are still deliberate operational changes and may restart or redeploy the service. Retain the source commit used for each release and schedule the expected disk-backed deployment downtime.

## Acceptance before connecting clients

- Verify the public HTTPS URL and `/health`. Unauthenticated `/v1/capabilities` must return `401`; health alone does not prove authentication, storage persistence or backup recovery.
- With a private reader connection, inspect `/v1/session`, `/v1/policy` and `/v1/capabilities`. Confirm the intended scope, sandbox environment, both approved model bindings and `sourceAutomation: notConnected`. Reader credentials must not authorize a PUT.
- Use only a reviewed synthetic packet for the initial reviewer PUT. Verify idempotency and exact creator/run read identity, then restart the service and confirm the same persisted run remains. Check wrong-scope rejection and that a new login is required after the in-memory session store restarts. Do not fabricate live creator records to fill the service.
- Verify HTTPS ingress, Secure/HttpOnly/SameSite cookies and the existing origin/CSRF behavior if operator sessions will be used. This API-only deployment provides no dashboard build, same-origin dashboard gateway or cross-origin relaxation. Never embed either token in a frontend.
- Assign backup ownership and complete the online SQLite backup plus isolated restore check described in [the hosting guide](creator-agent-hosting.md#backup-and-isolated-restore-check). Keep an encrypted, access-controlled backup beyond this service disk and approve retention/capacity separately. Render disk snapshots do not replace database-aware recovery verification.
- Exercise a controlled SIGTERM/restart and inspect only bounded status/count logs. Preserve application `401`, `403`, `404`, conflict and unavailable responses; do not rewrite them to a static-page success response.

Connecting an authenticated endpoint to a private Zapier connection is a later operational step. It does not authorize publishing a Zap, setting a schedule or contacting creators.

## Validation record

The prepared blueprint was parsed as YAML and checked against [Render's published JSON Schema](https://render.com/schema/render.yaml.json), with start-command shell syntax checked separately. This confirms file structure; it does not provision Render, validate billing/account access or prove a hosted release. Cloud install/start, persistent-volume, public HTTPS/authentication and recovery acceptance remain required after hosting approval.
