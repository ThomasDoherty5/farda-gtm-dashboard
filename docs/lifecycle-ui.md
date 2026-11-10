# Customer lifecycle UI

The lifecycle routes preserve the fixture presentation and add a separate native presentation through the authenticated adapter. Native reads never fall back to demo counts. The lifecycle service accepts a trusted aggregate reader; provider enrollment, delivery and send-time consent enforcement remain with their existing source owner.

| Route | Original source | Native component |
| --- | --- | --- |
| `/customers/lifecycle` | `5:289` | `NativeLifecyclePage` |
| `/customers/flows/setup` | `5:404` | `NativeSetupFlowPage` |
| `/customers/flows/early-access` | `11:372` | `NativeEmailFlowPage` |
| `/customers/flows/abandoned-checkout` | `11:498` | `NativeEmailFlowPage` |
| `/customers/flows/review-request` | `11:624` | `NativeEmailFlowPage` |
| `/customers/consent` | `11:750` | `NativeConsentPage` |
| `/customers/activation` | `11:852` | `NativeActivationPage` |

The source manifest identifies the original file. Private context, token captures, screenshots and numeric comparisons remain outside this public repository. The implementation uses the existing PageKit, field, table, checkbox, dialog and typography mappings. The native layouts retain the header, ordered steps, settings panel, consent distribution and activation funnel, with additional source/version and recovery evidence. Setup remains read-only.

## Source observations

The four read keys remain `lifecycleOverview`, `emailFlow`, `consentEligibility` and `activationRetention`. Browser-safe native schemas live in `src/creator-agent/lifecycle/contract.ts` and are registered alongside the fixture schemas in `src/adapter/viewSchemas/lifecycle.ts`.

Counts carry a value or an explicit missing reason. A consent distribution requires all four exclusive category counts and a positive matching total. A zero denominator has no defined percentage. Activation uses the source-defined device cohort and first seven days after delivery; pairing and bottle interaction do not establish ingestion or health outcomes. Later retention definitions stay proposed.

Entry events, timing rules, timezones, template versions and claim-policy references come from the permitted source catalog. The UI does not invent a launch date, approve a proposed delay, turn a template label into approved copy, or treat queued messages as sent. Source test/publication/activation evidence is read-only and tied to its exact selected basis. Missing source links open an honest handoff dialog with no invented destination.

## Local drafts and uncertainty

Only the three editable flow resources can save local configuration drafts. All nine displayed consent/suppression/deduplication gates remain checked and read-only. The strict server payload cannot change them. Saving cannot enable, publish, schedule or send email, and the UI does not offer a live-test command.

`draftRecovery.ts` checks the generic save envelope against its nested immutable lifecycle receipt: scope, actor, flow, request key, base version, payload digest, payload, stored version and persistence time must agree. A transport success with a different receipt remains uncertain.

An opaque `draftRequestKey` URL parameter allows reload recovery. The exact original payload stays in the server's scoped request receipt; an in-memory, protected query entry preserves an in-progress request during in-app navigation. No draft or receipt is serialized to local storage, session storage or IndexedDB. Access denial clears protected query data and removes the editor.

While an outcome is unresolved, the form cannot issue a fresh key. The original request can be retried only when its exact original payload is available. A failed read or absent lookup is not a terminal rejection. Only exact recorded or durable rejected readback releases correction with a new key. Immutable local revision history remains visible independently of current source availability.

## Verification

`draftRecovery.test.ts` covers exact ACK/readback correlation and mismatched scope, actor, payload, key and versions. Existing lifecycle fixture/schema tests remain in place. `e2e-agent/lifecycle.spec.ts` runs the actual HTTP service and SQLite with an injected fictional source, visits all seven routes at 1440 and 390 pixels, checks keyboard and accessibility behavior, and verifies source loss, zero/unknown populations and uncertain-save reload recovery. This is software integration evidence; it is not provider activation or live customer-delivery evidence.
