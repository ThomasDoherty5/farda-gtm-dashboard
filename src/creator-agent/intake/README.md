# J01 creator intake and identity resolution — THO-318

This server-only module is the J01 implementation. It records native signups and daily-discovery candidates, resolves them to one canonical creator, and hands the result to Notion and Sheets through injected sinks. It never scores, invites, messages, reserves a sample or pays. Every result carries `outbound` flags that are `false` by construction.

It uses the existing scoped agent SQLite handle and creates only `intake_*` tables. Construct `IntakeRepository(db, scope, authority, now?)`. The server wires it to `POST /v1/intake` (reviewer credential, JSON, `Idempotency-Key`) and the reads below. Machine credentials stay server-side.

## Input and checks

The request is `{envelope, input}`. The envelope follows the shared job envelope. `mode` must be `observe` or `reconcile`: `propose` and `executeApproved` are refused because J01 has no outbound action. `accountRef` must match the server scope, `idempotencyKey` must match the header, and `inputHash` must be the canonical digest of `input`. Timestamps in the future and expired deadlines are refused.

`input` holds the typed contract fields: `campaignRef`, `briefRef`, `sourceCandidate`, `recruitmentSource`, `trigger`, `eventId`, `occurredAt`, `observedAt`, `profileRefs`, `publishingNetworks`, `identityMapVersion`, `suppressionVersion` and `cursor`. Profiles are SourceRefs on `instagram` or `tiktok`, with the handle and source update time. Social Cat is a recruitment source, never a publishing network. Addresses must be plain https on the profile's own network: no login details, query string or fragment. A missing native ID stays `null`.

Before anything is written, `authority.route(source, accountId)` must return `Ready`, for example from the capability ledger's `requireReady`. Anything else pauses that source, keeps its last cursor, writes no identity and answers 503 `SOURCE_<STATE>`. A denial never falls back to another route.

## Identity

- A profile resolves by native ID, then a stored fingerprint of its address, then a reviewed crosswalk entry (`identityMapVersion`). Display names never match people.
- A new creator is created only from a native ID, with a deterministic ID, so a replay cannot create a second person.
- A fingerprint-only profile attaches to a creator only through a source signup, a reviewer's correction or a reviewed crosswalk. A discovery hit alone leaves it unresolved.
- Profiles that resolve to two different creators go to review (`IDENTITY_CONFLICT`). They are not merged.
- A renamed handle follows the native ID and keeps the old handle as an alias. A handle that another creator used before is flagged.
- Relationships are per creator and campaign. Repeats reuse the active relationship. A closed relationship is never reopened, and its creator is `excluded` for that campaign.

## Suppression

The suppression list version is read through `authority.suppression(version)`. Entries are stored and stay in force, so a later list that drops one does not lift it. A suppressed creator or profile is `excluded`. If the list version is unavailable, intake fails closed: the identity is still recorded but eligibility stays `identityPending`.

## Times

Each result has one evidence reference. It keeps the source event time, the newest source update time, the observation time and the local sync time separately. A late record whose source update time is older than the stored profile adds evidence but does not overwrite it (`LATE_SOURCE_RECORD`).

## Handoffs

Local resolution commits first. Handoffs then run in order: `notion-creator-crm`, then `sheets-watchlist`, which carries the Notion receipt reference. Each has a key per creator revision. A thrown or unreadable sink result marks the handoff `uncertain`. The next replay of the same event, or a `reconcile` request, reads the key back before writing again, so a completed write is not repeated. A missing sink shows `unavailable` and does not block identity.

No real Notion or Sheets connection exists yet. The sinks are injected by trusted server configuration; tests use synthetic in-memory sinks.

## Output

The result has `creatorRef`, `profileRefs`, `relationshipRefs`, `identityState` (`resolved` or `needsReview`), `watchlistEligibility` (`active`, `identityPending` or `excluded`), `evidenceRefs`, sorted `reviewReasons`, `nextWork` (`J20` for an active discovery, `J02` for an active signup, otherwise null), `handoffs` and a `checkpoint` with the cursor and handoff keys.

## Reads

- `GET /v1/intake/events/:source/:eventId`: the stored result with current handoff states.
- `GET /v1/intake/creators/:creatorId`: profiles, relationships, aliases and suppressions.
- `GET /v1/intake/sources/:source/:accountId`: cursor, last event and pause state.

## Not done here

Live source signup readers, real Notion and Sheets writers, lifting a suppression, and reopening or merging creators are separate reviewed work. A relationship closure through `closeRelationship` bumps the creator revision; the next intake for that creator sends the new record.
