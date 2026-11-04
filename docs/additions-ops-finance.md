# Operations, finance and integration additions beyond Figma

Acceptance-criteria additions (THO-300 FE08-03; THO-301 FE09-03/05, OPS270; THO-302 FE10-05; THO-303 FIN274-02/03, FIN-EVIDENCE; THO-304 FE12-05; THO-305 FE13-05). They are not Figma sources.

| Addition | Where | Notes |
| -- | -- | -- |
| Adjustments after payout | Settlement "Matching evidence" dialog | Appended beside an unchanged receipt. `appendAdjustment` refuses an unpaid group, a positive amount, a reused id and the wrong receipt. |
| Customer details (restricted) | Order page, beside "No customer details are mirrored" | A dialog. Only the operations and founder roles can reveal, a reason is required, the reveal is logged, and the values are synthetic placeholders. Demo role: `createDemoAdapter({ actorRole })`. |
| In transit, exception kinds, sandbox chain | `/operations?view=shipping` | In transit excludes carrier-confirmed delivered. Six exception kinds are counted from rows. One order → sample → shortage → transfer chain reuses the existing refs. |
| Late transfer | `/inventory?scenario=late` | A transfer past its expected date and not received. On hand is unchanged. |
| Months and revisions, dry-run manifest | `/finance/close/:period?view=months` and `?view=manifest`, linked from the reconciliation dialog | No tax rule is invented; the CPA tax-policy reference reads "Not set". Nothing is generated. |
| Event handling | Email flow pages, "Event handling" dialog | Withdrawn consent, duplicates, replays, missing entry events, unsupported claims and outages, computed by `flowEvents.ts`. |
| Nightly reconciliation | `/automations?tab=reconciliation` | Conflicts name the authoritative side; a repair is requested through the adapter and applied by the source owner after approval; the audit trail is append-only. |
