# Direct video evidence (J20)

J20 observes Instagram and TikTok lifestyle videos and versions what it saw. It does not keep its own ledger. A collected page becomes a new revision of the existing creator evidence packet (`src/creator-agent/evidence.ts`), written through the same writer as the reviewer `PUT /v1/creators/:id` route. J02 (`policy.ts`) still owns assessment, ratings, floors and arithmetic. J20 assigns no score, resolves no claim, sends nothing and authorizes no spend.

## Wiring

| Piece | Role |
| -- | -- |
| `creatorEvidenceWriter.ts` | The one writer. It aliases comment authors and provider accounts, resolves server-held route proof, runs `assessCreator` and appends through `AgentStore.save`. The reviewer route and the J20 executor both call it. |
| `videoEvidence/runtime.ts` | `bindVideoEvidence` registers the executor on an existing compiled daily `J20` observe registration, through `options.runtime.registry`. `server.ts` only composes it. |
| `intake/repository.ts` | `reviewWork(creatorId)` is the executor's input. It returns work only while the creator's latest revision came from a discovery event that emitted `nextWork: "J20"` and its enrollment is still verified. |
| `videoEvidence/contract.ts` | The collector request and response. A collector returns one bounded page, a login or MFA takeover, a denial, or a retryable outage. |
| `videoEvidence/packet.ts` | Merges one page into the latest stored packet. It applies the like gate, the taxonomy, the inference screen and the change rules. |
| `videoEvidence/quality.ts` | The evidence-quality projection, returned as `videoEvidenceQuality` on the `evidenceRecord` read for collected packets only. It is not rendered yet. |
| `videoEvidence/fixtures.testkit.ts` | The synthetic sandbox collector and fixtures. It is a test double only. |

The runtime owns cadence, leases, quota, checkpoints, retries and takeovers. Each step makes one collector call and at most one evidence write. A step with more pages returns a checkpoint. A login or MFA response becomes the runtime's owned takeover, and work resumes from the last checkpoint only after a source-issued resolution receipt. A source-level denial holds the item and writes nothing. The run trace is the existing `runDetail` read.

## Versions

| Version | Value |
| -- | -- |
| Packet marker | `collection.schemaVersion` = `farda.video-evidence.v1` |
| Sampling policy | `j20-sampling.2026-11-04.v1` |
| Taxonomy | `j20-lifestyle-taxonomy.v1` |
| Collector request | `j20-collector-request.v1` |
| Executor | `j20-video-evidence.v1` |
| Collector | `collection.collectorVersion` and `collection.collectorStage`, as declared by the bound collector |

Every new field is optional, so earlier packets, assessments, packet hashes and idempotency receipts parse and compare unchanged. A packet that carries `collection` must state source provenance, context, counters, access and playback facts on every reviewed post. The agent version is unchanged: J02 output for earlier inputs is identical.

## Rules the code enforces

- **Identity.** The record ID derives from the creator and the native post identity, never from a caller label. Identical facts on a later read reuse the stored revision. Observation and receipt times alone never create a new one.
- **Like gate.** Only posts with strictly more than 200 exact native likes are deep-reviewed. Exactly 200 fails. Hidden, rounded, ambiguous and third-party counts stay pending with their raw label. Lower-like posts join the recent metadata baseline only. A review offered for one is dropped and the exclusion is recorded.
- **Coverage.** Status comes from observed ranges and frames. Elapsed playback, muted playback and caption text never earn coverage. Once playback facts are recorded, a complete continuous review must cover the clip. The six fixtures (complete, sampled, caption-only, muted, interrupted, blocked) derive six distinct statuses. Sampled frames remain credited exactly as on main, labelled sampled and never continuous.
- **Observations.** Shown actions carry their kind. Only shown handling, operation or use can count as brief-matched use. Narration and reviewer inferences are stored separately. Neither a CTA nor a Shop anchor is required. Outcome causality is always reported as unresolved.
- **Counters.** A hidden or missing counter is null with its reason, never zero. Raw label, unit, definition, window and snapshot time are kept. Provider route metrics gain the same provenance, plus a separate unavailable list.
- **Taxonomy.** Only GRWM, workday, organization, travel/purse and practical product use are relevant. Clinical lectures, IVF/fertility explainers and generic medical education are excluded. Educator status is recorded and changes nothing.
- **Audience.** Only an authorized dated native report or creator export with provenance is verified. No schema has a field or route for face, voice, name, appearance, health or location inference.
- **Claims.** Compatibility, medical and outcome claims are listed as `claim-N` targets for the existing reviewer disagree/override path. Diagnosing, demographic, purchasing-power and outcome-promising text that Farda authors is withheld by the inference screen and recorded by field.
- **Access.** Removed, changed, login-required and denied posts keep their earlier observation and record the new access state beside it. Changed footage is not re-credited until it is reviewed again. History is never edited.
- **Reviewer writes.** A reviewer can rate or annotate a collected packet through the same writer. The reviewer cannot author or alter `collection` or any post carrying J20 source provenance (`J20_COLLECTION_READ_ONLY`).
- **Privacy.** Provider accounts and comment authors are stored only as scoped aliases. Run views alias creator subjects.

## Stage

**Fixture-complete only.** All collector evidence in this repository is synthetic. The sandbox collector reports `synthetic-fixture` in `/v1/capabilities` and on every packet it writes. It refuses to start when `NODE_ENV` is `production`, the same guard as the reference test double. Testkit files are excluded from the API image.

These remain open and are not claimed:

- **J20-10 actual collector and source records.** No qualified collector has read a real Instagram or TikTok source. A real collector, its account permissions, selectors or API scopes, and its source receipts need their own qualification. The quality projection labels synthetic packets `SYNTHETIC_FIXTURE_COLLECTOR`.
- **J20-08 authorized audience reports.** No real authorized native report or creator export has been ingested. Every collected packet reports `NO_VERIFIED_AUDIENCE_REPORT` until one is.
- **Rendering.** `videoEvidenceQuality`, narration, counters and context reach the browser schema but are not rendered. That waits for the original design.
