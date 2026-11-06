# Evidence, creator-platform and collaboration reads

These modules extend the existing native sandbox agent service. They use the scoped adapter envelope `2026-11-02.proposed`, the existing server database and reader/reviewer authentication. They introduce no provider dispatch, scheduler activation or new infrastructure.

## Evidence review

`POST /v1/read`, `viewKey: evidenceRecord`, takes exact `creatorId`, `evidenceId` and optional immutable `runId` filters. Period and sort must be empty; a continuation cursor is unsupported. The returned source review identifies the exact native media, packet, policy, model, terms and annotation versions. Missing playback permission, modality, reviewer or timestamps stay unknown. A source-recorded review and current playback access are separate facts.

Reviewers may append `evidenceDraft` observations or `reviewerAssessment` disagreements/override proposals through `POST /v1/save`. Saves bind the exact source basis, expected version and idempotency key. The server supplies the reviewer identity. Observations cannot extend a sampled frame into a continuous interval, and no save completes J20 review, edits the original packet or sends a message. An override remains a proposal beside immutable source evidence.

Disputed evidence holds affected effective qualification while its original assessment remains readable. New labels or run identifiers cannot resolve a challenge. Unsupported or uncertain acknowledgments require independent history readback before further writes.

Creator writes and their idempotent replays return the same effective currentness checks as creator reads. A disputed or superseded write receipt cannot present itself as currently eligible. The stored assessment remains immutable and is available through the explicit assessment-history projection.

New intake replaces commenter identifiers with authenticated pseudonyms bound to the private database key, workspace, account and publishing network. Null authors remain unknown and author deduplication is preserved. Read projections protect legacy identifiers without rewriting historical receipts. Canonical comparison keeps pre-migration retries idempotent while still rejecting materially changed payloads. The UI displays a short anonymous label rather than a raw identifier or full token.

## Creator-platform projections

`POST /v1/read` supports `socialCatBoard`, `tiktokBoard`, `socialCatDashboard` and `tiktokDashboard`. Filters are owner, search, publishing network and cohort start/end; the end is exclusive. Period and arbitrary sort are unsupported.

All four views reuse canonical funnel corrections, exclusive work stages and overlapping achievements. The acquisition source is independent of publishing network, checkout and payout owner. Native publishing metrics need matching source definitions and windows; absent observations never establish a provider-wide zero. Money retains its currency and minor-unit basis.

Continuations bind the authorized scope, role, view, filters, page size, private database key, insertion watermark and snapshot time. Local membership and cumulative page coverage are exact; provider-wide coverage remains unknown. Oversized source cohorts require narrower filters rather than silently truncating results. A cursor is not authorization and never permits execution.

## Collaboration source and proposals

`POST /v1/read`, `viewKey: collaborationDetail`, accepts a canonical internal collaboration key or scoped opaque route reference. The configured source reader must verify membership in the fixed registry. Unconfigured, denied, partial, missing and stale source states are distinct. A fresh check does not imply the underlying source record changed.

The projection keeps accepted terms, sample observations, registered submissions, content decisions, rights and native publication evidence separate. The existing saved asset/portfolio evidence reader owns derivative and renewal records. Unknown publishing slots, account permission, visibility and rights remain held; a registry checkbox or content URL cannot establish native publication authority.

`POST /v1/action` only accepts `requestApproval` with `proposeCollaborationReview` for this module. Exact scope, source version, deliverable/submission and suppression/posting guards apply. The response acknowledges a durable **local proposal** in `approvalPending`, with no approval or dispatch receipt. J04 decision and source execution remain disconnected. Readback must match the immutable proposal before the UI confirms it.

After an uncertain response, reviewer-only `collaborationDetail` reads may include `proposalRequestKey`. The server checks the exact actor/request receipt over the full proposal ledger, independently of the latest50 display rows. A confirmed absence permits only the original request key and payload to retry. Failed, stale or incomplete source reads cannot certify absence or release the hold. Identical text from another request cannot acknowledge this one.

The related `collaborationEvidence` read resolves the same opaque route reference before querying exact saved membership and echoes the browser reference. This prevents an encrypted route key from being mistaken for an empty canonical subject.

## Release evidence

Unit and HTTP tests verify the native repositories and boundaries; browser tests use actual authenticated service/SQLite paths with synthetic inputs. Figma comparisons identify their source frames and explicit adaptations. Passing these checks establishes the recorded implementation stage, not account-specific provider permission, live publication, financial authorization or production readiness. Linear holds the acceptance and deployment evidence for each release.
