import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Kpi, KpiRow } from "@/components/Kpi";
import { DetailRows, Divider, Halves, Page, PageHeader, Panel, PillNav, Small, kit } from "@/components/PageKit";
import { InfoDialog } from "@/features/settings/shared";
import { flowKeys, type NativeLifecycle, type NativeEmailFlow, type NativeConsent, type NativeActivation } from "@/creator-agent/lifecycle/contract";
import { CatalogSteps, CohortDetails, CountBar, ProviderDialog, ReadFeedback, SourceContext, SourceDetails, countReason, countText, flowNames, percentage, share, unknownCount } from "./nativeShared";
import styles from "./Lifecycle.module.css";

/** Native adaptations retain the source layout and never substitute a demo population. */
export function NativeLifecyclePage() {
  const query = useView<Record<string, never>, NativeLifecycle>("lifecycleOverview", {}), data = query.data?.data ?? null;
  const [dialog, setDialog] = useState<"definitions" | "tool" | null>(null);
  return <Page labelledBy="lifecycle-title" source="5:289">
    <PageHeader id="lifecycle-title" title="From first interest to everyday use." subtitle="Follow consent, delivery, setup and support without copying private customer records.">
      <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 184 }} onClick={() => setDialog("definitions")}>Metric definitions</Button>
      <Button aria-haspopup="dialog" style={{ minWidth: 184 }} onClick={() => setDialog("tool")}>Open email tool</Button>
    </PageHeader>
    <PillNav label="Overview sections" items={[{ label: "GTM overview", to: "/overview", width: 132 }, { label: "Customer lifecycle", to: "/customers/lifecycle", width: 180, current: true }, { label: "Launch control", to: "/launch?view=control", width: 148 }]} />
    <ReadFeedback query={query} subject="The customer lifecycle" />
    {data && <><SourceContext data={data} /><KpiRow>
      <Kpi label="Eligible audience" context={countReason(data.consent?.eligible)}>{countText(data.consent?.eligible)}</Kpi>
      <Kpi label="Consent unknown" context={countReason(data.consent?.unknown)} warn>{countText(data.consent?.unknown)}</Kpi>
      <Kpi label="Paired" context={countReason(data.activation?.paired)}>{countText(data.activation?.paired)}</Kpi>
      <Kpi label="Active in week one" context={countReason(data.activation?.weekOne)}>{countText(data.activation?.weekOne)}</Kpi>
    </KpiRow>
      <Panel title="Four flows, one clear consent rule" note="The source owns consent, suppression and delivery. Configured intent and source outcomes remain separate." headingId="flows-title" large headingGap={20}>
        <DataTable variant="ledger" caption="Customer communication flows" columns={[{ label: "FLOW", width: "17.628%" }, { label: "ENTRY & EXIT", width: "37.981%" }, { label: "DELIVERY GATE", width: "31.25%" }, { label: "STATE" }]} minWidth={760}
          rows={flowKeys.map(key => { const f = data.flows.find(flow => flow.flow === key); return [<Link key={key} to={`/customers/flows/${key}`} className={kit.cellLink}>{flowNames[key]}</Link>, f ? `${f.entryEvents.map(e => e.label).join("; ")} → ${f.cancellationRules.join("; ") || "Exit rules unavailable"}` : "Entry and exit not verified", f ? `${f.purpose}; ${f.eligibilityRules.join("; ") || "Eligibility unavailable"}` : "Consent and event evidence required", f?.evidence.find(e => e.kind === "activation")?.state ?? "Unknown"]; })} />
      </Panel>
      <Halves><Panel title="Did setup help people get started?" headingId="activation-title" large tight>
        <DetailRows rows={[["Paired count", countText(data.activation?.paired)], ["Active in week one", countText(data.activation?.weekOne)]]} wide />
        <CountBar label="Week-one active, as a share of paired" value={data.activation?.weekOne ?? unknownCount} denominator={data.activation?.paired ?? unknownCount} />
        <Small>First seven days after delivery. Pairing and app activity do not establish ingestion or a health outcome.</Small>
        <LinkButton variant="secondary" to="/customers/activation">View activation definitions</LinkButton>
      </Panel><Panel title="Close the loop after purchase" headingId="loop-title" large tight>
        <p className={styles.bodyInk}>Review source-owned support and return records in the support workspace.</p>
        <Badge tone="warning">{countText(data.returnsAwaitingInspection)} returns awaiting inspection</Badge><Small>{countReason(data.returnsAwaitingInspection)}</Small>
        <LinkButton to="/support">Open support queue</LinkButton>
        <LinkButton variant="secondary" to="/customers/consent">Review consent eligibility</LinkButton>
      </Panel></Halves>
    </>}
    <ProviderDialog open={dialog === "tool"} onClose={() => setDialog(null)} data={data} title="Open email tool" />
    <InfoDialog open={dialog === "definitions"} onClose={() => setDialog(null)} title="Metric definitions" demo={false}>
      <p>Consent counts describe one source-defined population. Activation counts describe a separate device cohort; the two populations are never added.</p>
      <CohortDetails cohort={data?.consent?.cohort ?? null} /><CohortDetails cohort={data?.activation?.cohort ?? null} />
    </InfoDialog>
  </Page>;
}

export function NativeSetupFlowPage() {
  const query = useView<{ flow: string }, NativeEmailFlow>("emailFlow", { flow: "setup" }), data = query.data?.data ?? null;
  const [providerOpen, setProviderOpen] = useState(false);
  return <Page labelledBy="setup-title" source="5:404"><PageHeader id="setup-title" title="Setup help, with a clean exit." subtitle="Review the exact source eligibility, message evidence and cancellation rules.">
    <LinkButton variant="secondary" to="/customers/lifecycle" style={{ minWidth: 184 }}>Back to lifecycle</LinkButton><Button aria-haspopup="dialog" onClick={() => setProviderOpen(true)} style={{ minWidth: 160 }}>Open provider</Button>
  </PageHeader><ReadFeedback query={query} subject="The setup flow" />{data && <><SourceContext data={data} />
    <div className={styles.split832}><section className={`${kit.card} ${styles.stepsCard}`} aria-labelledby="steps-title"><h2 id="steps-title" className={kit.heading2}>Delivery → eligibility → message → exit</h2><CatalogSteps catalog={data.sourceConfig} /></section>
      <Panel title="Never send when…" headingId="never-title"><ul className={styles.bullets}>{(data.sourceConfig?.cancellationRules.length ? data.sourceConfig.cancellationRules : ["Source eligibility, consent or cancellation rules are unavailable. Hold execution."]).map(r => <li key={r}>{r}</li>)}</ul>
        <Divider /><h2 className={kit.heading2}>What happens next</h2><DetailRows rows={[["Purpose", data.sourceConfig?.purpose ?? "Unknown"], ["Provider publication", data.sourceConfig?.evidence.find(e => e.kind === "publication")?.state ?? "Unknown"], ["Provider activation", data.sourceConfig?.evidence.find(e => e.kind === "activation")?.state ?? "Unknown"], ["Recovery owner", data.sourceConfig?.recoveryOwner ?? "Not supplied"]]} />
        <Small>Setup configuration is read-only. No message or enrollment is created here.</Small></Panel></div>
    <Panel title="A change is visible and reversible" headingId="changes-title"><DataTable variant="ledger" caption="Source outcomes" columns={[{ label: "OUTCOME" }, { label: "COUNT" }, { label: "SOURCE EVIDENCE / RECOVERY" }]} minWidth={600}
      rows={data.sourceConfig?.outcomes?.rows.map(row => [row.state, countText(row.count), row.receipt ?? row.count.missingReason ?? row.reasonCode ?? "Unknown"]) ?? [["Unknown", "Unknown", "No source outcome snapshot."]]} />
      <CohortDetails cohort={data.sourceConfig?.outcomes?.cohort ?? null} /></Panel></>}
    <ProviderDialog open={providerOpen} onClose={() => setProviderOpen(false)} data={data} title="Open provider" /></Page>;
}

export function NativeConsentPage() {
  const query = useView<Record<string, never>, NativeConsent>("consentEligibility", {}), data = query.data?.data ?? null, c = data?.consent;
  const [open, setOpen] = useState(false), target = useRef<HTMLDivElement>(null);
  const segments = [{ key: "eligible", label: "Eligible now", color: "var(--color-violet)" }, { key: "withdrawn", label: "Opted out", color: "var(--color-muted)" }, { key: "suppressed", label: "Bounced / suppressed", color: "var(--color-warning)" }, { key: "unknown", label: "Consent unknown", color: "var(--color-violetSoft)" }] as const;
  const hasBar = c && c.total.value !== null && c.total.value > 0 && segments.every(s => c[s.key].value !== null);
  return <Page labelledBy="consent-title" source="11:750"><PageHeader id="consent-title" title="A clear view of who is eligible." subtitle="Consent stays in the email provider. Only aggregate counts appear here.">
    <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 160 }} onClick={() => setOpen(true)}>Open provider</Button>
    <Button style={{ minWidth: 184 }} disabledReason={data ? null : "Load the source view first."} onClick={() => { target.current?.scrollIntoView({ block: "start" }); target.current?.focus(); }}>Review exclusions</Button>
  </PageHeader><ReadFeedback query={query} subject="Consent eligibility" />{data && <><SourceContext data={data} /><KpiRow>
    {segments.map(s => <Kpi key={s.key} label={s.label} context={countReason(c?.[s.key])} warn={s.key === "unknown"}>{countText(c?.[s.key])}</Kpi>)}
  </KpiRow><Panel title="Send only to the eligible audience" headingId="audience-title" large>
    {hasBar ? <div className={styles.bar} role="img" aria-label={`Exclusive consent categories: ${segments.map(s => `${s.label} ${countText(c[s.key])}`).join(", ")}. Total ${c.total.value}.`}>{segments.map(s => <span key={s.key} style={{ width: `${100 * c[s.key].value! / c.total.value!}%`, background: s.color }} />)}</div>
      : <Small>{c?.total.value === 0 ? "The observed population is zero. No percentage distribution is defined." : "The complete distribution is unavailable. Unknown counts are not converted to zero."}</Small>}
    <ul className={styles.legend}>{segments.map(s => <li key={s.key}><Badge>{s.label}: {countText(c?.[s.key])}</Badge></li>)}</ul>
    <Small>One exclusive category per person. Unknown consent never counts as opted in. Total: {countText(c?.total)}; purpose: {c?.purpose ?? "unknown"}.</Small><CohortDetails cohort={c?.cohort ?? null} />
  </Panel><div ref={target} tabIndex={-1} id="exclusions"><Panel title="Why an enrollment stops" headingId="exclusions-title" large tight>
    <DataTable variant="ledger" caption="Why an enrollment stops" columns={[{ label: "REASON", width: "40%" }, { label: "RECOVERY" }]} minWidth={600} rows={c?.exclusions.map(e => [e.reason, e.recovery]) ?? [["No source exclusions snapshot", "Resolve the owning provider's access and population evidence."]]} />
  </Panel></div></>}
    <ProviderDialog open={open} onClose={() => setOpen(false)} data={data} title="Open provider" /></Page>;
}

export function NativeActivationPage() {
  const query = useView<Record<string, never>, NativeActivation>("activationRetention", {}), data = query.data?.data ?? null, a = data?.activation;
  const [dialog, setDialog] = useState<"contract" | "cohort" | null>(null), activeShare = share(a?.weekOne, a?.paired);
  return <Page labelledBy="activation-title" source="11:852"><PageHeader id="activation-title" title="Measure setup, then sustained use." subtitle="Anonymous source counts connect delivery to pairing and first-week activation.">
    <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 184 }} onClick={() => setDialog("contract")}>View source contract</Button><Button aria-haspopup="dialog" style={{ minWidth: 160 }} onClick={() => setDialog("cohort")}>View cohort</Button>
  </PageHeader><ReadFeedback query={query} subject="Activation and retention" />{data && <><SourceContext data={data} /><div className={styles.split832}>
    <Panel title="First-week cohort" headingId="cohort-title"><Small>{a?.cohort.definition ?? "No verified device cohort."}</Small>
      <CountBar label="Delivered" value={a?.delivered ?? unknownCount} denominator={a?.delivered ?? unknownCount} />
      <CountBar label="Paired" value={a?.paired ?? unknownCount} denominator={a?.delivered ?? unknownCount} detail={`${percentage(share(a?.paired, a?.delivered))} of delivered`} />
      <CountBar label="Active in week one" value={a?.weekOne ?? unknownCount} denominator={a?.delivered ?? unknownCount} detail={`${percentage(activeShare)} of paired`} />
      <Small>First seven days after delivery. Pairing and bottle interaction do not prove ingestion, adherence or health outcomes. No person-level or device identifiers are shown.</Small>
    </Panel><section className={`${kit.card} ${styles.summary}`} aria-labelledby="summary-title"><p id="summary-title" className={styles.summaryLabel}>Pairing → week-one active</p><p className={styles.summaryValue}>{percentage(activeShare)}</p>
      <Small>{countText(a?.weekOne)} active / {countText(a?.paired)} paired</Small><Divider /><DetailRows rows={[["Delivered → paired", percentage(share(a?.paired, a?.delivered))], ["Pairing failure events", countText(a?.pairingFailureEvents)], ["Privacy approval", a?.privacyApproval.state ?? "Unknown"]]} />
      <Small>Failure events have a separate grain and are not subtracted from device counts. A zero denominator has no defined percentage.</Small></section></div>
    <Panel title="Beyond week one" headingId="retention-title" large headingGap={20}><ul className={styles.horizons}><li className={`${styles.horizon} ${styles.defined}`}><h3>Day 7</h3><p>First seven days after delivery</p><Badge>{a ? "Defined" : "Source unknown"}</Badge></li>
      {(a?.laterRetention ?? []).map(h => <li key={h.day} className={styles.horizon}><h3>Day {h.day}</h3><p>No observed retention result</p><Badge>Proposed</Badge></li>)}</ul>
      <Small>Later retention definitions remain proposals. Reactivation messaging requires its own permitted source policy and evidence.</Small></Panel></>}
    <InfoDialog open={dialog === "contract"} title="Source contract" demo={false} onClose={() => setDialog(null)}>{data && <SourceDetails data={data} />}<p>Only scoped anonymous aggregate exports are accepted. No verified external contract link is supplied.</p></InfoDialog>
    <InfoDialog open={dialog === "cohort"} title="Cohort" demo={false} onClose={() => setDialog(null)}><CohortDetails cohort={a?.cohort ?? null} /></InfoDialog></Page>;
}
