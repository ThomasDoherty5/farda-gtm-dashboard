# J01 creator intake and identity resolution — THO-318

This server-only module is the J01 implementation. It records native signups and daily-discovery candidates, resolves them to one canonical creator, and hands the result to Notion and Sheets through injected sinks. It never scores, invites, messages, reserves a sample or pays. Every result carries `outbound` flags that are `false` by construction.

It uses the existing scoped agent SQLite handle and creates only `intake_*` tables. Construct `IntakeRepository(db, scope, authority, now?)`. The server wires it to `POST /v1/intake` (reviewer credential, JSON, `Idempotency-Key`) and the reads below. Machine credentials stay server-side.

## Input and checks

The request is `{envelope, input}`. The envelope follows the shared job envelope. `mode` must be `observe` or `reconcile`: `propose` and `executeApproved` are refused because J01 has no outbound action. `accountRef` must match the server scope, `idempotencyKey` must match the header, and `inputHash` must be the canonical digest of `input`. Timestamps in the future and expired deadlines are refused.

`input` holds the typed contract fields: `campaignRef`, `briefRef`, `sourceCandidate`, `recruitmentSource`, `trigger`, `eventId`, `occurredAt`, `observedAt`, `profileRefs`, `publishingNetworks`, `identityMapVersion`, `suppressionVersion` and `cursor`. Profiles are SourceRefs on `instagram` or `tiktok`, with the handle and source update time. Social Cat is a recruitment source, never a publishing network. Addresses must be plain https on the profile's own network: no login details, query string or fragment. A missing native ID stays `null`.

Before anything is written, `authority.route(source, accountId)` must return `Ready`, for example from the capability ledger's `requireReady`. Anything else pauses that source, keeps its last cursor, writes no identity and answers 503 `SOURCE_<STATE>`. A denial never falls back to another route.

## Identity

- A profile resolves by its stored native ID, then a stored fingerprint of its address, then a reviewed crosswalk entry (`identityMapVersion`) for the native key and then the fingerprint key. The fingerprint is computed whenever the profile has an address, even when it also has a native ID. Display names never match people.
- A profile first attached by fingerprint that later arrives with a native ID resolves to the same creator through its fingerprint. Its native-key row is attached to that creator and the fingerprint row stays. If the native key and the fingerprint already belong to different creators, the event goes to review (`IDENTITY_CONFLICT`).
- A new creator is created only from a native ID, with a deterministic ID, so a replay cannot create a second person.
- A fingerprint-only profile attaches to a creator only through a source signup, a reviewer's correction or a reviewed crosswalk. A discovery hit alone leaves it unresolved.
- Profiles that resolve to two different creators go to review (`IDENTITY_CONFLICT`). They are not merged.
- A renamed handle follows the native ID and keeps the old handle as an alias. A handle that another creator used before is flagged.
- Relationships are per creator and campaign. Repeats reuse the active relationship. A closed relationship is never reopened, and its creator is `excluded` for that campaign.

## Suppression

The suppression list version is read through `authority.suppression(version)`. Entries are stored and stay in force, so a later list that drops one does not lift it. A suppressed creator or profile is `excluded`. Suppression is checked against the creator, every profile already attached to it, and every profile key in the event (native and fingerprint), whether or not that profile is attached. A suppressed profile in the event therefore excludes the creator even when a discovery hit could not attach it. If the list version is unavailable, intake fails closed: the identity is still recorded but eligibility stays `identityPending`.

## Times

Each result has one evidence reference. It keeps the source event time, the newest source update time, the observation time and the local sync time separately. A late record whose source update time is older than the stored profile adds evidence but does not overwrite it (`LATE_SOURCE_RECORD`).

## Handoffs

Local resolution commits first. Handoffs then run in order: `notion-creator-crm`, then `sheets-watchlist`, which carries the Notion receipt reference. Each has a key per creator revision. The revision goes up when a profile or relationship changes, and also when the eligibility or suppression state differs from what the current revision's handoffs carry, for example when a suppression excludes an active creator or an available suppression list moves it from `identityPending` to `active`. The new state then reaches Notion and Sheets under new keys. A thrown or unreadable sink result marks the handoff `uncertain`. The next replay of the same event, or a `reconcile` request, reads the key back before writing again, so a completed write is not repeated. A missing sink shows `unavailable` and does not block identity. A handoff that is not confirmed when the creator has a newer revision becomes `superseded` and is never written, so replaying an old event cannot overwrite newer data at a sink.

No real Notion or Sheets connection exists yet. The sinks are injected by trusted server configuration; tests use synthetic in-memory sinks.

## Output

The result has `creatorRef`, `profileRefs`, `relationshipRefs`, `identityState` (`resolved` or `needsReview`), `watchlistEligibility` (`active`, `identityPending` or `excluded`), `evidenceRefs`, sorted `reviewReasons`, `nextWork` (`J20` for an active discovery, `J02` for an active signup, otherwise null), `handoffs` and a `checkpoint` with the cursor and handoff keys.

## Reads

- `GET /v1/intake/events/:source/:eventId`: the stored result with current handoff states.
- `GET /v1/intake/creators/:creatorId`: profiles, relationships, aliases and suppressions.
- `GET /v1/intake/sources/:source/:accountId`: cursor, last event and pause state.

## Not done here

Live source signup readers, real Notion and Sheets writers, lifting a suppression, and reopening or merging creators are separate reviewed work. A relationship closure through `closeRelationship` bumps the creator revision; the next intake for that creator sends the new record.
