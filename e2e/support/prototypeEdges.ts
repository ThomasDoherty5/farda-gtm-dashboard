// Edges of the Figma prototype (page 07 · Interactive prototype), read through the Plugin API on the copy
// z9knjMdQ3kxL6Fblvu1tKc on 2026-11-03. One entry per screen or overlay frame: "label>target", where a target is a frame id,
// `O<id>` for an overlay that opens over the screen, or CLOSE. The six primary-navigation items on each frame are omitted
// (they are one shared header, covered by e2e/smoke.spec.ts). Labels are the UI text of the control, truncated to 28 characters.
export const PROTOTYPE_EDGES: Record<string, readonly string[]> = {
 "28:69": [
  "Last 30 days>O51:1944",
  "View report>28:5210",
  "Open creator workspace →>41:2829",
  "Open launch control>28:4907"
 ],
 "28:594": [
  "Open source>O42:1709",
  "Review proposals>41:1637",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348"
 ],
 "28:1127": [
  "Last 30 days>O51:1944",
  "Export report>O42:1735",
  "Launch date unset>28:69",
  "TikTok Shop>41:3008",
  "View channel report →>28:5210",
  "Explore unit economics →>28:3410",
  "View content monitor>41:2627",
  "View definitions →>28:5210"
 ],
 "28:1391": [
  "All homes>O51:1955",
  "Open warehouse>O42:1709",
  "Shipping>28:3212",
  "Stock>28:1819",
  "Support>41:2158",
  "Open issues>O42:1709",
  "TEST-SH-1042>28:1563",
  "View order>28:1563",
  "View sample>41:1781",
  "View stock>28:1819",
  "Review exceptions>28:1709",
  "Last 7 days · synthetic samp>O51:1955"
 ],
 "28:1563": [
  "Open Shopify>O42:1709",
  "Open source row>O42:1709",
  "Collaboration>41:1781",
  "Open source order>O42:1709",
  "Refund requested>28:2966",
  "Return received>28:2966"
 ],
 "28:1709": [
  "Open Shippo>O42:1709",
  "Open support case>41:2158",
  "Resolve in the source>O42:1709",
  "Open case in Intercom>O42:1709"
 ],
 "28:1819": [
  "All homes>O51:1955",
  "Open inventory>O42:1709",
  "Orders>28:1391",
  "Shipping>28:3212",
  "Support>41:2158",
  "Open source>O42:1709",
  "Open source transfer>O42:1709"
 ],
 "28:2200": [
  "Last 30 days>O51:1944",
  "Open QuickBooks>O42:1709",
  "Unit economics>28:3410",
  "Month-end>28:2373",
  "Reports>28:5210",
  "View metric definitions>O51:2035",
  "Open month-end close>28:2373",
  "Commission ledger>76:3940",
  "Payout reconciliation>76:4102",
  "Direct content fee>41:2033"
 ],
 "28:2373": [
  "Open QuickBooks>O42:1709",
  "View report folder>O42:1735",
  "Unit economics>28:3410",
  "Reports>28:5210",
  "Open month · 4 of 7 checks c>O42:1709",
  "Open close checklist>O42:1709",
  "Match source payout, ledger >O42:1709"
 ],
 "28:2566": [
  "View Zapier>O42:1709",
  "Agent runs>28:5470",
  "Zaps>28:5744",
  "Reporting>28:5744",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "Open source>O42:1709",
  "View decision>41:1637",
  "Channel access>76:4390"
 ],
 "28:2777": [
  "View safe dashboards>O42:1709",
  "Support>41:2158",
  "Open owner register>O42:1709",
  "Founder review>O42:1763",
  "Open launch control>28:4907"
 ],
 "28:2966": [
  "Open source case>O42:1709",
  "Prepare browser task>41:2351",
  "Review in Shopify>O42:1709",
  "Open stock movement>O42:1709",
  "Close with evidence>O42:1833",
  "Open · awaiting receipts>O42:1709"
 ],
 "28:3105": [
  "View source case>O42:1709",
  "Back to support>41:2158",
  "Open case to reopen>28:2966"
 ],
 "28:3212": [
  "Last 14 days>O51:1955",
  "Open operations>28:1391",
  "Open backlog>28:1391",
  "View inventory>28:1819",
  "Review exceptions>28:1709"
 ],
 "28:3410": [
  "Last 30 days>O51:1944",
  "View statements>O42:1735",
  "Last 30 days · before market>O51:1944",
  "Shipping>28:3212",
  "Match source payout → ledger>O42:1709",
  "TikTok Shop>41:3008",
  "Review month-end close>28:2373"
 ],
 "28:3557": [
  "Open connections>28:2566",
  "Clear filters>O42:1720",
  "View failed run>41:2494",
  "Open source health>28:2566",
  "View approval request>41:1637",
  "Reload source record>O42:1709",
  "Reconcile in source>41:2494",
  "Take over browser>O42:1709",
  "View receipt>O42:1820",
  "Review launch plan>28:4907"
 ],
 "28:3676": [
  "To ship>28:1391",
  "Stock>28:1819",
  "View source record>O42:1709",
  "View transfer>28:1819"
 ],
 "28:3731": [
  "More>O42:1930",
  "Open source>O42:1709",
  "All homes · Demo workspace ·>O42:1720",
  "To ship>28:1391",
  "Open issues>O42:1709",
  "TEST-SH-1042>28:1563",
  "View>28:1563",
  "Review exceptions>28:1709"
 ],
 "28:4103": [
  "Metric definitions>O51:1972",
  "Open email tool>O42:1709",
  "GTM overview>28:1127",
  "Launch control>28:4907",
  "Consented early access>28:4716",
  "Early access>28:4338",
  "Abandoned cart>28:4464",
  "Setup help>28:4218",
  "View flow →>28:4218",
  "Review request>28:4590",
  "View activation definitions>28:4818",
  "Open support queue>41:2158"
 ],
 "28:4218": [
  "Back to lifecycle>28:4103",
  "Open provider>O42:1709",
  "Edit timing or template>O51:1987",
  "Pause flow>O42:1796"
 ],
 "28:4338": [
  "Back to lifecycle>28:4103",
  "Save draft>O51:1987",
  "Review provider setup>28:2566"
 ],
 "28:4464": [
  "Back to lifecycle>28:4103",
  "Save draft>O51:1987",
  "Review provider setup>28:2566"
 ],
 "28:4590": [
  "Back to lifecycle>28:4103",
  "Save draft>O51:1987",
  "Review provider setup>28:2566"
 ],
 "28:4716": [
  "Open provider>O42:1709",
  "Review exclusions>O51:1972",
  "Demo cohort>O51:1972"
 ],
 "28:4818": [
  "View source contract>O42:1709",
  "Demo cohort>O51:1972"
 ],
 "28:4907": [
  "Open Notion>O42:1709",
  "Review gates>O42:1709",
  "GTM overview>28:1127",
  "Performance>28:5210",
  "Open run>41:2351",
  "View proof>O42:1820",
  "All required gates pass, wit>O42:1720",
  "Open date proposal>O42:1774"
 ],
 "28:5210": [
  "Last 30 days>O51:1944",
  "Metric definitions>O51:2035",
  "GTM overview>28:1127",
  "Launch control>28:4907",
  "TikTok Shop>41:3008",
  "View definitions>O51:2035",
  "View channel orders>28:1391",
  "Open creator economics>41:2033",
  "Open accounting month>28:2373"
 ],
 "28:5470": [
  "View Zapier>O42:1709",
  "Zaps>28:5744",
  "Connections>28:2566",
  "Reporting>28:5744",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "Full acquisition funnel>111:7018",
  "Review approval>41:1637",
  "Reconcile>41:2494",
  "Take over>O82:2868",
  "View connection>28:2566",
  "View run>41:2351",
  "View schedule>O42:1877",
  "Open run detail>41:2351",
  "Open recovery detail>41:2494"
 ],
 "28:5744": [
  "Open Zapier>O42:1709",
  "Agent runs>28:5470",
  "Connections>28:2566",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "Full acquisition funnel>111:7018",
  "Edit in Zapier>O42:1709",
  "Open preview evidence>111:7219",
  "Open failed run>41:2494"
 ],
 "28:6631": [
  "Back to monitor>41:2627",
  "Review 2 changes>41:3180",
  "Daily sourcing>111:7348",
  "Full acquisition funnel>111:7018",
  "Reconnect source>28:2566",
  "Open post detail →>41:3321",
  "Compare delivery evidence →>28:1563",
  "Reconnect source →>28:2566"
 ],
 "41:1427": [
  "Open Notion>O42:1709",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348",
  "View collaboration →>41:1781",
  "Open approval detail>41:1637"
 ],
 "41:1637": [
  "Current affiliate terms>76:3659",
  "Full acquisition funnel>111:7018",
  "Open approval channel>O42:1709",
  "Open Notion record>O42:1709"
 ],
 "41:1781": [
  "Open Social Cat>O42:1709",
  "Content>41:1918",
  "Payments>41:2033",
  "Current affiliate terms>76:3659",
  "Full acquisition funnel>111:7018",
  "Open content review>41:1918",
  "Commission ledger>76:3940",
  "Configure new offer>76:3659"
 ],
 "41:1918": [
  "Open original draft>O42:1709",
  "Collaboration>41:1781",
  "Payments>41:2033",
  "Current affiliate terms>76:3659",
  "Full acquisition funnel>111:7018",
  "Open draft in Social Cat>O42:1709",
  "Open rights record>O42:1709"
 ],
 "41:2033": [
  "Open ledger source>O42:1709",
  "Current affiliate terms>76:3659",
  "Full acquisition funnel>111:7018",
  "Open Slack approval>O42:1709",
  "Open source evidence>O42:1709"
 ],
 "41:2158": [
  "14-day cohort>O51:1955",
  "Open Intercom>O42:1709",
  "Orders>28:1391",
  "Shipping>28:3212",
  "Stock>28:1819",
  "Open selected case>28:2966",
  "View conversation>O42:1709",
  "14-day cohort · 45 tickets>O51:1955"
 ],
 "41:2351": [
  "Open source>O42:1709",
  "Zaps>28:5744",
  "Connections>28:2566",
  "Reporting>28:5744",
  "Current affiliate terms>76:3659",
  "Daily sourcing>111:7348",
  "View connection setup>28:2566"
 ],
 "41:2494": [
  "Open session>O82:2868",
  "Take over>O82:2868",
  "Zaps>28:5744",
  "Connections>28:2566",
  "Reporting>28:5744",
  "Current affiliate terms>76:3659",
  "Daily sourcing>111:7348"
 ],
 "41:2627": [
  "Open watchlist>41:3180",
  "View hourly runs>28:6631",
  "Social Cat>41:2829",
  "TikTok Shop>41:3008",
  "Watchlist>41:3180",
  "Daily sourcing>111:7348",
  "Full acquisition funnel>111:7018",
  "Inspect coverage>41:3180"
 ],
 "41:2829": [
  "Open Social Cat>O42:1709",
  "Review applications>41:4380",
  "TikTok Shop>41:3008",
  "Content monitor>41:2627",
  "Watchlist>41:3180",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "SC scorecard>41:4026",
  "Recruitment queue>41:4380",
  "Open action queue>41:1427",
  "Open creator lifecycle>41:1427",
  "Affiliate>76:3659",
  "Configure offer>76:3659",
  "Website commerce>76:3780",
  "Commission ledger>76:3940",
  "Channel access>76:4390"
 ],
 "41:3008": [
  "Open TikTok Shop>O42:1709",
  "Review affiliate queue>41:4597",
  "Social Cat>41:2829",
  "Content monitor>41:2627",
  "Watchlist>41:3180",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "TT scorecard>41:4203",
  "Prepare invitation>41:4597",
  "Open affiliate queue>41:4597",
  "Open TikTok lifecycle>28:594",
  "Native settlement & rates>76:4247",
  "Bulk operations>76:4517",
  "Channel access>76:4390"
 ],
 "41:3180": [
  "View monitor>41:2627",
  "Daily sourcing>111:7348",
  "Full acquisition funnel>111:7018",
  "View post performance →>41:3321",
  "Verify deliverable →>41:1918",
  "Reconnect source session →>28:2566",
  "View sheet mapping>O42:1709"
 ],
 "41:3321": [
  "Back to monitor>41:2627",
  "Open source post>O42:1709",
  "View attribution evidence>28:5210",
  "Open collaboration>41:1781"
 ],
 "41:3471": [
  "Last 30 days>O51:1944",
  "Open ad source>O42:1709",
  "All platforms>O42:1720",
  "View asset>O42:1709",
  "Open rights>O42:1709"
 ],
 "41:3677": [
  "Open campaigns>O42:1709",
  "All three cohorts are below >O42:1720",
  "TikTok Shop>41:3008",
  "Open no-post queue>O42:1709"
 ],
 "41:3848": [
  "Open support>O42:1709",
  "Open commerce source>O42:1709",
  "Shipping>28:3212",
  "Open / handed off>O42:1709",
  "Review support queue>41:2158",
  "Open return cases>O42:1709",
  "Open review outcomes>O42:1709"
 ],
 "41:4026": [
  "Open score sheet>O42:1709",
  "Review decision>111:7219",
  "Social Cat dashboard>41:2829",
  "Recruitment queue>41:4380",
  "TikTok dashboard>41:3008",
  "TT scorecard>41:4203",
  "Prepare invitation>41:4597",
  "Review lifestyle evidence>111:7219",
  "Daily sourcing>111:7348",
  "View evidence>111:7219",
  "Website commerce>76:3780",
  "Native Shop commerce>41:4203"
 ],
 "41:4203": [
  "Open score sheet>O42:1709",
  "Review decision>111:7219",
  "Social Cat dashboard>41:2829",
  "SC scorecard>41:4026",
  "Recruitment queue>41:4380",
  "TikTok dashboard>41:3008",
  "Prepare invitation>41:4597",
  "Review lifestyle evidence>111:7219",
  "Daily sourcing>111:7348",
  "View evidence>111:7219",
  "Content quality>41:4026",
  "Website commerce>76:3780"
 ],
 "41:4380": [
  "Open Social Cat>O42:1709",
  "Review affiliate terms>76:3659",
  "Social Cat dashboard>41:2829",
  "Prior content score>41:4026",
  "TikTok dashboard>41:3008",
  "TT scorecard>41:4203",
  "Prepare invitation>41:4597",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "Review brief>41:1637",
  "Review evidence>111:7219",
  "Open plan & usage>O82:2850",
  "Commission ledger>76:3940",
  "Content monitor>41:2627",
  "Affiliate · current>76:3659",
  "Configure offer>76:3659",
  "Prior commerce score>76:3780",
  "Channel access>76:4390"
 ],
 "41:4597": [
  "Open Affiliate Center>O42:1709",
  "Social Cat dashboard>41:2829",
  "SC scorecard>41:4026",
  "Recruitment queue>41:4380",
  "TikTok dashboard>41:3008",
  "Prior TikTok score>41:4203",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "Preview confirmed invitation>O42:2025",
  "Explore uncertain invitation>O42:2040",
  "View connection readiness>28:2566",
  "Review sample decision>O42:2053",
  "Preview sample receipt>O42:2064",
  "View sample handoff>28:1391",
  "Open content monitor>41:2627",
  "Review settlement>O79:2655",
  "Native settlement & rates>76:4247",
  "Bulk operations>76:4517",
  "Channel access>76:4390"
 ],
 "42:1709": [
  "View connection settings>28:2566",
  "Close preview>CLOSE"
 ],
 "42:1720": [
  "Social Cat dashboard>41:2829",
  "TikTok Shop dashboard>41:3008",
  "Combined content monitor>41:2627",
  "Close filters>CLOSE"
 ],
 "42:1735": [
  "View performance report>28:5210",
  "View month-end package>28:2373",
  "Close preview>CLOSE"
 ],
 "42:1763": [
  "View payment evidence>41:2033",
  "Close preview>CLOSE"
 ],
 "42:1774": [
  "Open approval queue>41:1637",
  "Return to the screen>CLOSE"
 ],
 "42:1785": [
  "Return to collaboration>41:1781",
  "Close preview>CLOSE"
 ],
 "42:1796": [
  "View run history>28:5470",
  "Close preview>CLOSE"
 ],
 "42:1807": [
  "Open recovery detail>41:2494",
  "Preview confirmed receipt>O42:1820",
  "Keep paused>CLOSE"
 ],
 "42:1820": [
  "View hourly run evidence>28:6631",
  "Return to dashboard>28:1127",
  "Close preview>CLOSE"
 ],
 "42:1833": [
  "Preview resolved return>28:3105",
  "Keep case open>CLOSE"
 ],
 "42:1844": [
  "Review source record>O42:1709",
  "Keep collaboration open>CLOSE"
 ],
 "42:1855": [
  "Open sample collaboration>41:1781",
  "Close preview>CLOSE"
 ],
 "42:1866": [
  "Review watchlist>41:3180",
  "Close preview>CLOSE"
 ],
 "42:1877": [
  "View hourly run design>28:6631",
  "View connection readiness>28:2566",
  "Keep schedule paused>CLOSE"
 ],
 "42:1890": [
  "Customer lifecycle>28:4103",
  "Launch control>28:4907",
  "Analytics workspace>O42:1945",
  "Team and permissions>28:2777",
  "Connections>28:2566",
  "Mobile operations>28:3676",
  "Tablet operations>28:3731",
  "Recovery states>28:3557",
  "Scheduling preview>O42:1877",
  "Close menu>CLOSE"
 ],
 "42:1915": [
  "Desktop overview>28:1127",
  "Mobile operations>28:3676",
  "Tablet operations>28:3731",
  "Close menu>CLOSE"
 ],
 "42:1930": [
  "Desktop overview>28:1127",
  "Mobile operations>28:3676",
  "Tablet operations>28:3731",
  "Close menu>CLOSE"
 ],
 "42:1945": [
  "Performance and attribution>28:5210",
  "Paid media diagnostics>41:3471",
  "Campaign funnel and gift cap>41:3677",
  "Commerce, support and review>41:3848",
  "Close menu>CLOSE"
 ],
 "42:1984": [
  "Review the sample scorecard>41:4026",
  "Return to recruitment>41:4380",
  "Close preview>CLOSE"
 ],
 "42:2025": [
  "Review the sample decision>O42:2053",
  "Explore an uncertain result>O42:2040",
  "Return to TikTok dashboard>41:3008",
  "Close receipt>CLOSE"
 ],
 "42:2040": [
  "Preview a matching receipt f>O42:2025",
  "View connection readiness>28:2566",
  "Keep task paused>CLOSE"
 ],
 "42:2053": [
  "Preview source-confirmed app>O42:2064",
  "Keep sample pending>CLOSE"
 ],
 "42:2064": [
  "View Operations workspace>28:1391",
  "Return to TikTok workflow>41:4597",
  "Close receipt>CLOSE"
 ],
 "51:1944": [
  "View analytics workspace>O42:1945",
  "Keep demo period>CLOSE"
 ],
 "51:1955": [
  "Shipping exceptions>28:1709",
  "Home stock>28:1819",
  "Support handoffs>41:2158",
  "All operations>28:1391",
  "Close filters>CLOSE"
 ],
 "51:1972": [
  "Consent and eligibility>28:4716",
  "Activation and retention>28:4818",
  "Customer lifecycle>28:4103",
  "Close filters>CLOSE"
 ],
 "51:1987": [
  "Review audience eligibility>28:4716",
  "Return to flow>CLOSE"
 ],
 "51:1998": [
  "Return to assessment>CLOSE"
 ],
 "51:2007": [
  "TikTok Affiliate Center>41:3008",
  "All monitored sources>41:2627",
  "Close filters>CLOSE"
 ],
 "51:2024": [
  "Open example collaboration>41:1781",
  "Keep suggestions pending>CLOSE"
 ],
 "51:2035": [
  "Open performance report>28:5210",
  "Close definitions>CLOSE"
 ],
 "57:1976": [
  "Open Social Cat recruitment>41:4380",
  "Review TikTok invitation>41:4597",
  "Keep current record>CLOSE"
 ],
 "76:3659": [
  "Scorecards>76:3780",
  "Commissions>76:3940",
  "Settlement>76:4102",
  "Access>76:4390",
  "Bulk operations>76:4517",
  "Open channel access>76:4390"
 ],
 "76:3780": [
  "Open offer>76:3659",
  "Review eligibility>76:4390",
  "Content quality>41:4026",
  "Native Shop commerce>41:4203",
  "Review lifestyle evidence>111:7219",
  "Daily sourcing>111:7348"
 ],
 "76:3940": [
  "Reconcile payout>76:4102",
  "Payouts>76:4102",
  "Economics>O84:2869",
  "Provider access>76:4390",
  "Full acquisition funnel>111:7018",
  "View payout>76:4102",
  "Review hold>O79:2592",
  "Review dispute>O79:2601",
  "Inspect eligibility>O79:2610",
  "View receipt>O79:2637"
 ],
 "76:4102": [
  "Open native payout>O79:2637",
  "Commissions>76:3940",
  "Economics>O84:2869",
  "Provider access>76:4390",
  "Full acquisition funnel>111:7018",
  "Inspect source receipt>O79:2637",
  "Inspect receipt>O79:2637",
  "Open ledger source>O42:1709",
  "View activation exception>O79:2619",
  "Review provider failure>O79:2628",
  "Back to commissions>76:3940"
 ],
 "76:4247": [
  "Open target invite>41:4597",
  "Validate native access>76:4390",
  "Full acquisition funnel>111:7018",
  "Daily sourcing>111:7348",
  "Open reconciliation>O79:2655",
  "Reconcile unknown result>O79:2655",
  "Request takeover>O82:2868"
 ],
 "76:4390": [
  "Review evidence>O42:1709",
  "Plan validation>O82:2850",
  "Daily sourcing>111:7348",
  "Review lifestyle evidence>111:7219",
  "Validate Collabs>O82:2850",
  "Validate API / browser>O82:2850",
  "Validate sample route>O82:2850"
 ],
 "76:4517": [
  "Review batch receipt>O79:2682",
  "Daily sourcing>111:7348",
  "Full acquisition funnel>111:7018",
  "View receipt>O79:2682",
  "Reconcile outcome>O79:2709",
  "Request takeover>O82:2868",
  "Inspect approval manifest>O79:2673",
  "Open capacity and access>76:4390"
 ],
 "79:2592": [
  "Close>CLOSE",
  "Open provider reconciliation>76:4102"
 ],
 "79:2601": [
  "Close>CLOSE",
  "Open provider reconciliation>76:4102"
 ],
 "79:2610": [
  "Close>CLOSE",
  "View activation scenario>O79:2619"
 ],
 "79:2619": [
  "Close>CLOSE",
  "Review channel readiness>76:4390"
 ],
 "79:2628": [
  "Close>CLOSE",
  "Return to payout review>76:4102"
 ],
 "79:2637": [
  "Close>CLOSE",
  "Review statement match>76:4102"
 ],
 "79:2646": [
  "Close>CLOSE",
  "Back to pilot ledger>76:3940"
 ],
 "79:2655": [
  "Close>CLOSE",
  "Return to native settlement>76:4247"
 ],
 "79:2673": [
  "Close>CLOSE",
  "View batch progress>76:4517"
 ],
 "79:2682": [
  "Close>CLOSE",
  "Return to batch>76:4517"
 ],
 "79:2691": [
  "Close>CLOSE",
  "Cancel the 3 unsent items>O79:2700"
 ],
 "79:2700": [
  "Close>CLOSE",
  "Return to original batch>76:4517"
 ],
 "79:2709": [
  "Close>CLOSE",
  "Preview confirmed receipt fo>O79:2718"
 ],
 "79:2718": [
  "Close>CLOSE",
  "Return to original batch>76:4517"
 ],
 "79:2727": [
  "Close>CLOSE",
  "Review access requirements>76:4390"
 ],
 "79:2763": [
  "Close>CLOSE",
  "Open finite batch>76:4517"
 ],
 "82:2841": [
  "Close>CLOSE"
 ],
 "82:2850": [
  "Close>CLOSE"
 ],
 "82:2859": [
  "Close>CLOSE",
  "Return to original batch>76:4517"
 ],
 "82:2868": [
  "Close>CLOSE",
  "Review channel access>76:4390"
 ],
 "84:2869": [
  "Close>CLOSE",
  "Back to pilot ledger>76:3940"
 ],
 "111:7018": [
  "Daily sourcing>111:7348",
  "Review evidence>111:7219",
  "Video evidence>111:7219",
  "Social Cat>41:2829",
  "TikTok Shop>41:3008",
  "Content monitor>41:2627",
  "Reconcile uncertain sends>41:2494",
  "Open work queue>76:4517"
 ],
 "111:7219": [
  "Pipeline>111:7018",
  "Daily sourcing>111:7348",
  "Social Cat>41:2829",
  "TikTok Shop>41:3008",
  "Content monitor>41:2627",
  "Validate video access>76:4390"
 ],
 "111:7348": [
  "Review evidence>111:7219",
  "Validate access>76:4390",
  "Pipeline>111:7018",
  "Video evidence>111:7219",
  "Social Cat>41:2829",
  "TikTok Shop>41:3008",
  "Content monitor>41:2627",
  "Open video review>111:7219",
  "Preview sample batch>O79:2673",
  "Open capabilities>76:4390",
  "Open hourly monitor>28:6631",
  "Open sample batch>76:4517"
 ]
};

export const OVERLAY_NAMES: Record<string, string> = {
 "42:1709": "source",
 "42:1720": "filters",
 "42:1735": "export",
 "42:1763": "founder",
 "42:1774": "draft",
 "42:1785": "rejected",
 "42:1796": "paused",
 "42:1807": "recovery",
 "42:1820": "receipt",
 "42:1833": "close",
 "42:1844": "relationship",
 "42:1855": "sample",
 "42:1866": "identity",
 "42:1877": "schedule",
 "42:1890": "workspace",
 "42:1915": "mobileWorkspace",
 "42:1930": "tabletWorkspace",
 "42:1945": "analytics",
 "42:1984": "discovery",
 "42:2025": "ttSent",
 "42:2040": "ttUncertain",
 "42:2053": "sampleApproval",
 "42:2064": "sampleReceipt",
 "51:1944": "period",
 "51:1955": "opsFilters",
 "51:1972": "cohortFilters",
 "51:1987": "flowDraft",
 "51:1998": "holdCandidate",
 "51:2007": "networkFilters",
 "51:2024": "statusReview",
 "51:2035": "definitions",
 "57:1976": "repeat",
 "79:2592": "Holding balance",
 "79:2601": "Disputed balance",
 "79:2610": "Awaiting provider settlement",
 "79:2619": "Waiting for creator payout setup",
 "79:2628": "Provider payment needs attention",
 "79:2637": "Collabs payout receipt",
 "79:2646": "Statement matched",
 "79:2655": "TikTok native reconciliation",
 "79:2673": "Approved finite batch",
 "79:2682": "Invitation confirmed",
 "79:2691": "New work paused",
 "79:2700": "Unsent items canceled",
 "79:2709": "Check the source before retrying",
 "79:2718": "Unknown outcome resolved",
 "79:2727": "Authorized owner handoff required",
 "79:2763": "Filter the operating queue",
 "82:2841": "Offer draft saved",
 "82:2850": "Plan the authorized route",
 "82:2859": "Unsent item canceled",
 "82:2868": "Hand control to an authorized operator",
 "84:2869": "Pilot contribution economics"
};
