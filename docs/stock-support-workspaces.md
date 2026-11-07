# Stock and support workspaces

The stock workspace is at `/inventory` and the support queue at `/support/cases/queue`. The case route accepts a source-owned case reference. The reader and reviewer use the same scoped, authenticated adapter. Demo examples are rendered only in demo mode.

| Source frame | Screen | Source and interactions |
| --- | --- | --- |
| Stock per home and transfer, 7:129 | `features/inventory/InventoryPage.tsx`, `NativeInventoryPage.tsx` | Home, SKU and reporting period select one source snapshot. Totals, movements, reservations, position evidence and transfers use that selection. A transfer proposal contains two homes, one SKU, units and an enumerated operational reason. |
| Support workspace, 7:317 | `features/support/SupportPage.tsx`, `NativeSupportPage.tsx` | Inspect the safe queue and selected case, source owner, order, shipment or return references. Compare all-time open to a separate 14-calendar-day cohort. An allowed handoff saves a proposal for human review. |

Both current-view controls retain the selected record, filters and browser history. The shipping hub remains reachable from both pages. Shared headers, tabs, buttons, notice, cards, tables, metrics and dialogs use the application's existing component and token mappings.

### Inventory basis

J15 owns movements, reservations and physical writes. The source reader provides explicit period-bound position receipts, active reservation IDs and Shopify's independent observed snapshot. On-hand, reserved, available and risk remain unknown when their required evidence is absent. A known zero is rendered numerically. A sample reservation changes the reservation balance. A transfer shows dispatch and destination receipts separately. Missing receipts, conflicting observations and insufficient available stock hold proposals. A locally recorded proposal creates no reservation, shipment or stock movement.

### Support scope

J16 owns conversations, returns, refunds and replacements. The support reader admits operational references, categories, assignment roles and safe outcomes. The strict source and response schemas reject unrecognized fields. A partial support mirror cannot establish a complete all-time queue or a matched support, shipment and refund cohort. Conversation text, person fields and arbitrary source URLs do not enter the browser. A missing external case link is disclosed at the handoff. Financial and delivery denominators require their own source evidence.

### Local proposals

The server validates the workspace, single account, environment and reviewer authority. The cookie path also requires origin and CSRF checks. It re-reads the source, validates current membership, coverage, freshness, version, target and available quantity before appending a review in a SQLite transaction. Only the reported source balance governs stock availability. Competing human review requests are displayed separately. A fresh key with an older version creates a terminal no-op. The stored receipt binds actor, key, target, exact payload digest and base version.

The browser stores the scoped retry key and typed operational parameters while the outcome is uncertain. It can read a just-committed receipt outside the bounded proposal list, or retry only the exact original request after verified absence. An original request whose period has become historical can receive a durable stale rejection. A delayed duplicate cannot then apply. Missing current scope or source access keeps the hold in place. A recorded proposal remains pending human approval.

### Provider binding

`createStockSupportWorkflow` consumes an injected, scope-checked `StockSupportSource` over the existing J15/J16 source boundary. The optional server-side `createNotionStockSupportSource` reads only the two configured data sources on the official Notion origin, with bounded pages and response size. It verifies each row's parent and derives scoped, stable public references. Ledger formula fields are observations, not opening balances. The mirror cannot confirm Shopify stock, reserve totals, complete cohort counts or permission to write to provider systems. Source credentials stay private and an absent binding yields an integration-pending response.

The operational fixtures in `stockSupportFixtures.ts` use synthetic order, sample, transfer and case references shared with the existing queue. `stockSupport.test.ts`, `notionStockSupportSource.test.ts` and `e2e-agent/stock-support.spec.ts` cover the native SQLite, provider transport and browser behavior. Full source captures and operational records are excluded from the public repository.
