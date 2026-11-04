# Pipeline additions beyond Figma 102:74

These are acceptance-criteria additions (THO-289 CF-01, CF-05, CF-07, CF-08, CF-10). They are not Figma sources.

| Addition | Where | Notes |
| -- | -- | -- |
| Route and Policy filters | Filter row of `/creators/pipeline` | The two extra buttons are 160px wide so the row stays on one line and the page keeps its 1440×2552 size. |
| Every filter slices the demo data | `src/fixtures/pipeline.ts` | The cohort is eight outbound cells plus one inbound cell. A source's facts are the sum of the cells a filter picks. Medians pool only where the cells agree; otherwise they are N/A. |
| Inbound route | `?route=inbound` | A separate Social Cat cohort. It has no outbound send, so Confirmed sent and Dispatch are N/A, never zero. |
| Paths and branches | `/creators/pipeline?view=branches` | Terminal decline/opt-out/expiry, repeat paths, optional sample branch and content-obligation branch. Linked from "Where the work sits today". |
| Daily versus hourly label | Commerce outcomes paragraph | One short sentence so the paragraph stays on one line. |
