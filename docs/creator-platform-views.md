# Saved creator platform views

The Social Cat and TikTok boards and dashboards read authenticated creator funnel observations through the existing dashboard adapter. The four view keys are `socialCatBoard`, `socialCatDashboard`, `tiktokBoard` and `tiktokDashboard`. Their original design nodes are 6:24, 23:275, 9:143 and 23:440 respectively.

## Read contract

Send `POST /v1/read` with the verified workspace, one account, sandbox environment, a null period, empty sort array and page size 1–100. Optional filters are `owner`, `q`, `network`, `start` and `end`. Dates filter cohort starts in UTC with an exclusive end. The normal UI reads 25 rows at a time. A query can match the displayed creator, opportunity, owner or work stage.

The response uses the existing read envelope and the `saved-creator-platform` model. Local totals apply to the complete matching snapshot. Rows are paged. Charts explicitly distinguish exclusive current-stage counts from overlapping acquisition achievements. The latest 12 source events per displayed opportunity and up to 12 recent post observations are labeled with their full local observation counts.

A signed-in reader and reviewer can read the same saved scope. Writes, provider checks, messages, payments and publication are unavailable here. Demo routes retain isolated synthetic fixtures. Empty, unavailable and access-denied live results do not fall back to fixtures.

## Evidence and identity

The canonical funnel repository owns source-verified producer receipts, corrections, identity resolution, maturity and attribution disputes. A platform belongs to the observed acquisition source. Publishing network, checkout, payout owner, match and exact accepted terms are independent fields. A source payout owner is displayed only when explicitly receipted. A prior qualification observation does not establish the current scoring model or grant acquisition authority.

Native post metrics require a dated verified receipt from a supported publishing account. Views can be known when engagements are unavailable. Engagement rate requires a positive, compatible views denominator. Inconsistent same-time receipts or measurement windows make an aggregate unavailable. Financial figures use mature order/refund receipts and the canonical dispute checks; net sales are in the receipted currency's minor units. No order observations leaves revenue unavailable. Saved source outages, event timestamps and the ledger snapshot time remain separate from provider-wide coverage.

The first read pins the scoped ledger sequence and as-of time. An encrypted continuation is bound to role, view, filters, limit, workspace and account and expires after 15 minutes. A new first page incorporates later corrections and backfills. The source repository rejects windows larger than 2,000 receipts and the UI offers date controls. No truncated aggregate is presented as complete.

Source accounts, creators, opportunities, private actions, owner references, deliverables and receipts are not emitted as raw provider identifiers. Resolved collaboration links use a separately sealed scoped record reference. The detail route verifies source authorization on every read. Saved work, historical obligations and an unavailable source do not confer new permission.
