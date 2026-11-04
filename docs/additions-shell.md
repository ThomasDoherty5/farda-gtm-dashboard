# Shell additions beyond Figma

Acceptance-criteria additions (THO-292 FE00-04 and FHC-05). They are not Figma sources. The browser-offline state is not here: it was built separately and is on `main` (`src/adapter/connectivity.ts`, `ConnectionStatus`).

| Addition | Where | Notes |
| -- | -- | -- |
| Breadcrumb trail | Shell header, in its existing bottom padding | Section, page and record, derived from the route manifest. It adds no height. It is text, not links: the primary navigation already links every section, and a link named like a section, tab or page would be a duplicate control. |
| One-action rule | `src/routes/oneAction.test.tsx` | Every manifest route has no control nested in another and no two links to one place inside one row, item or card. The lifecycle table's Setup row now has one link, not two. |
