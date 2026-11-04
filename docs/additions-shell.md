# Shell additions beyond Figma

Acceptance-criteria additions (THO-292 FE00-04, FHC-05, and the `-08` offline state). They are not Figma sources.

| Addition | Where | Notes |
| -- | -- | -- |
| Breadcrumb trail | Shell header, in its existing bottom padding | Section, page and record, derived from the route manifest. It adds no height. It is text, not links: the primary navigation already links every section, and a link named like a section, tab or page would be a duplicate control. |
| Browser-offline state | `useView`, `useAction`, `useSave`, `ViewError`, Shell banner | While `navigator.onLine` is false a read fails as "You're offline" (no spinner, no demo data) and a write is refused locally with "Nothing was sent". Reconnecting reloads the read. |
| One-action rule | `src/routes/oneAction.test.tsx` | Every manifest route has no control nested in another and no two links to one place inside one row, item or card. The lifecycle table's Setup row now has one link, not two. |
