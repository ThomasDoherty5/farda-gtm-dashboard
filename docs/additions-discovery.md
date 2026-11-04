# Daily sourcing, approval and batch additions beyond Figma

Acceptance-criteria additions (THO-287 DS-01/02/04/06/07, THO-296 FE04-02/04, THO-298 FE06-05). They are not Figma sources.

| Addition | Where | Notes |
| -- | -- | -- |
| Plan detail | `/creators/discovery?view=plan`, linked from "Respect each source's limits" | Versions, per-step owner/evidence/next action, identity and suppression funnel, run states, and an approval request through the adapter. The daily page keeps its 1440×2065 size. |
| Approval request | Plan detail | Sends `requestApproval` / `requestBatchApproval` for the finite batch. The answer is "approval pending"; nothing is approved, sent or reserved. |
| Founder authority | `createDemoAdapter({ actorRole: "founder" })` | A founder also holds the reviewer role. Founder authority does not make a new upfront fee approvable. |
| Sample requests tab | `/batches/:batchId?tab=samples` | TikTok sample decisions count only with TikTok's receipt. A denied account scope is an owner handoff, never a recorded decision. No Figma frame. |
