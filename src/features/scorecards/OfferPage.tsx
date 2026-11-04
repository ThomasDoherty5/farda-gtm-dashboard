import { useState } from "react";
import { useParams } from "react-router-dom";
import { AdapterError } from "@/adapter/errors";
import { useView } from "@/adapter/useView";
import { useSave } from "@/adapter/useSave";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Field, SelectField, TextField } from "@/components/Field";
import { SectionTabs } from "@/components/SectionTabs";
import { Card, HandoffDialog, KpiCard, ViewShell, useIsDemo } from "@/features/analytics/parts";
import { DEMO_ASSESSMENT_CONTENT_ID, DEMO_CREATOR_ID, type OfferDraftPayload, type OfferDraftRecord, type Provider } from "@/fixtures/scorecards";
import { economics, parseCommission, parseDollars, usd2, usdAuto } from "./scorecardMath";
import { WATERFALL, waterfallBars } from "./waterfall";
import a from "@/features/analytics/Analytics.module.css";
import s from "./Scorecards.module.css";

const PROVIDERS: { value: Provider; label: string; help: string; objective: string; model: string }[] = [
  { value: "shopify-website", label: "Shopify website · Collabs candidate", help: "Program access before invite; creator activation before payout", objective: "Website affiliate sales", model: "WEBSITE-AFFILIATE-v3" },
  { value: "tiktok-shop", label: "TikTok Shop · native affiliate program", help: "Program access before invite; creator activation before payout", objective: "TikTok Shop affiliate sales", model: "TIKTOK-SHOP-AFFILIATE-v3" },
];
const NETWORKS = [{ value: "instagram+tiktok", label: "Instagram + TikTok" }, { value: "instagram", label: "Instagram" }, { value: "tiktok", label: "TikTok" }];
const OFFER_TYPES = [{ label: "Gifted · history", current: false }, { label: "Paid · history", current: false }, { label: "Affiliate · current", current: true }, { label: "Hybrid · history", current: false }];
const GATE_ROWS: { badge: string; tone: BadgeTone; title: string; detail: string }[] = [
  { badge: "Approval required", tone: "warning", title: "Before invitation", detail: "Proposed terms, feasible provider route, authorized access, budget, stock and quota" },
  { badge: "Acceptance required", tone: "neutral", title: "Before sample shipment", detail: "Accepted contract and sample allocation; do not ship on an unaccepted invitation" },
  { badge: "Tracking required", tone: "neutral", title: "Before commerce activation", detail: "Issued link/code, successful attribution test and applicable program setup" },
  { badge: "Creator setup", tone: "neutral", title: "Before provider payout", detail: "Activation may wait on the creator; it is distinct from merchant billing or paid cash" },
];
const HISTORY_REASON = "offer-type-history-note";

/** Offer and economics (Figma source 65:634, owner THO-297, CTRL-101 to CTRL-114). A commission-only draft: nothing here activates or sends an offer. */
export function OfferPage() {
  const { offerId = "" } = useParams();
  const query = useView<{ offerId: string }, OfferDraftRecord>("offerDraft", { offerId });
  return (
    <section aria-labelledby="offer-title" data-figma-source="65:634" className={a.page}>
      <ViewShell query={query} subject="The offer" emptyTitle="No offer" emptyBody="The source responded, but there is no offer record to show.">
        {(record) => <Offer record={record} />}
      </ViewShell>
      {!query.data?.data && <h1 id="offer-title" style={{ font: "var(--text-h1)", margin: 0 }}>Terms that make sense.</h1>}
    </section>
  );
}

function Offer({ record }: { record: OfferDraftRecord }) {
  const demo = useIsDemo();
  const save = useSave<OfferDraftPayload, OfferDraftRecord>();
  const base = record.payload;
  const [provider, setProvider] = useState<Provider>(base.provider);
  const [networks, setNetworks] = useState<OfferDraftPayload["networks"]>(base.networks);
  const [commission, setCommission] = useState(`${base.commissionPct}% of eligible merchandise`);
  const [sample, setSample] = useState(usdAuto(base.sampleShippingMinor / 100));
  const [shown, setShown] = useState(false);
  const [dialog, setDialog] = useState<"commitment" | "payload" | null>(null);

  const pct = parseCommission(commission);
  const smp = parseDollars(sample);
  const valid = pct.pct !== null && smp.minor !== null;
  const draft: OfferDraftPayload = { ...base, provider, networks, commissionPct: pct.pct ?? base.commissionPct, sampleShippingMinor: smp.minor ?? base.sampleShippingMinor };
  const dirty = JSON.stringify(draft) !== JSON.stringify(base) || !valid;
  const econ = economics(record.assumptions, draft);
  const chosen = PROVIDERS.find((p) => p.value === provider)!;
  const serverErrors = save.error instanceof AdapterError ? (save.error.body.fieldErrors ?? {}) : {};
  const saveFailure = save.error instanceof AdapterError ? save.error : null;
  const bars = waterfallBars(econ.base);
  const submit = () => {
    setShown(true);
    if (!valid) return;
    save.mutate({ resourceKind: "actionDraft", resourceRef: record.offerId, expectedVersion: record.version, payload: draft });
  };
  const a2 = (n: number) => usd2(n);

  return (
    <>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="offer-title">Terms that make sense.</h1>
          <p>Social Cat intake · Instagram / TikTok publishing · website affiliate checkout</p>
        </div>
        <Button variant="secondary" style={{ minWidth: 198 }} loading={save.isPending} onClick={submit}>Save offer draft</Button>
        <Button style={{ minWidth: 200 }} aria-haspopup="dialog" onClick={() => setDialog("commitment")}>Review commitment</Button>
      </div>
      {(save.isSuccess || saveFailure || (shown && !valid)) && (
        <div role={save.isSuccess ? "status" : "alert"} className={s.status}>
          {save.isSuccess && `Draft saved as version ${save.data.resourceVersion}, as acknowledged by the offer service. Nothing was activated or sent.${save.data.reasonCodes.includes("NO_CHANGE") ? " There were no changes." : ""}`}
          {saveFailure && (saveFailure.category === "conflict" ? "This offer changed since you opened it. Reload it before saving; your edits are kept here." : `${saveFailure.message} Your edits are kept.`)}
          {!save.isSuccess && !saveFailure && "Fix the highlighted terms before saving."}
        </div>
      )}
      <div className={s.tabsFixed}>
      <SectionTabs label="Offer sections" tabs={[
        { label: "Offers", to: `/offers/${record.offerId}`, width: 100, current: true },
        { label: "Scorecards", to: `/creators/${DEMO_CREATOR_ID}/assessments/${DEMO_ASSESSMENT_CONTENT_ID}`, width: 102 },
        { label: "Commissions", to: "/finance/commissions", width: 109 },
        { label: "Settlement", to: "/finance/settlements/demo-settlementId", width: 102 },
        { label: "Access", to: "/settings/capabilities", width: 100 },
        { label: "Bulk operations", to: "/batches/demo-batch-tt-024", width: 137 },
      ]} />
      </div>
      <section className={s.hist} aria-label="Draft scenario">
        <p className={a.label}>Commission-only draft · no Farda rate is approved</p>
        <p className={a.small}>{record.offerCode} is a new illustrative affiliate offer: no upfront content fee, separately approved product and shipping, and external provider settlement. The current website v3 model is unpublished; prior proposed scores do not authorize this offer.</p>
      </section>
      <Card labelledBy="deal-title" className={a.card20}>
        <div className={s.heading54}><h2 id="deal-title">Define the agreement</h2><p>Deal type, publishing network and payout ownership are independent.</p></div>
        <div role="tablist" aria-label="Offer type" className={s.tabsRow}>
          {OFFER_TYPES.map((t) => (
            <button key={t.label} type="button" role="tab" aria-selected={t.current} aria-disabled={!t.current || undefined} aria-describedby={t.current ? undefined : HISTORY_REASON} className={`${s.offerTab} ${t.current ? s.offerTabCurrent : ""}`} onClick={(e) => e.preventDefault()}>{t.label}</button>
          ))}
        </div>
        <div className={s.fieldsRow}>
          <Field label="Objective" helpText={`${chosen.model} · publication pending`}>{(p) => <input {...p} readOnly value={chosen.objective} />}</Field>
          <SelectField label="Publishing network" helpText={`Recruitment source: ${record.recruitmentSource}`} value={networks} onChange={(v) => setNetworks(v as OfferDraftPayload["networks"])} options={NETWORKS} />
          <SelectField label="Checkout and commission provider" helpText={chosen.help} value={provider} onChange={(v) => setProvider(v as Provider)} options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))} />
        </div>
        <div className={s.fieldsRow}>
          <TextField label="Commission type" helpText={base.baseVerified ? "Native eligible base verified" : "Draft example only · native eligible base to verify"} error={shown ? (pct.error ?? serverErrors.commission ?? null) : (serverErrors.commission ?? null)} value={commission} onChange={setCommission} />
          <Field label="Upfront content fee" helpText="New guaranteed fees are not permitted; historical obligations remain payable" error={serverErrors.upfrontFee ?? null}>{(p) => <input {...p} readOnly aria-disabled="true" value="$0 · locked by policy" />}</Field>
          <TextField label="Sample + shipping" helpText="One approved allocation for this creator/campaign" error={shown ? (smp.error ?? serverErrors.sample ?? null) : (serverErrors.sample ?? null)} value={sample} onChange={setSample} />
        </div>
        <div className={s.compRow}>
          <Button variant="secondary" style={{ minWidth: 230 }} aria-pressed="true">Percentage commission</Button>
          <Button variant="secondary" style={{ minWidth: 230 }} disabledReason="Needs a verified compatible provider" reasonFor="fixed-note">Fixed per qualified sale</Button>
          <p id="fixed-note">Fixed-per-sale requires a verified compatible provider; this Collabs route documents percentage commissions.</p>
        </div>
        {dirty && <p className={s.status} role="status">Edited since version {record.version}. Approval readiness is cleared until the draft is saved and reviewed again.</p>}
      </Card>
      <Card labelledBy="econ-title" className={s.gap24}>
        <div className={s.heading54}>
          <h2 id="econ-title">The upside needs a downside test.</h2>
          <p>Forecast · {usdAuto(record.assumptions.netSaleMinor / 100)} net eligible sale, {usdAuto(record.assumptions.commerceCostMinor / 100)} commerce cost, {draft.commissionPct}% commission + {record.assumptions.processingPctOfCommission}% processing on commission.</p>
        </div>
        <div className={s.econ}>
          <div className={s.col}>
            <KpiCard label="Estimated base contribution" context={`${econ.base.orders} retained orders · ${usdAuto(0)} fee + ${usdAuto(draft.sampleShippingMinor / 100)} sample`} testId="metric-base-contribution">{a2(econ.base.contribution)}</KpiCard>
            <KpiCard label="Break-even" context={`${trim3(econ.unit)} unit contribution before the ${usdAuto(draft.sampleShippingMinor / 100)} sample`} testId="metric-break-even">{econ.breakEven === null ? "N/A" : `${econ.breakEven} orders`}</KpiCard>
            <KpiCard label="Estimated downside" context={`${econ.downside.orders} retained orders · draft assumptions, not observed performance`} testId="metric-downside">{a2(econ.downside.contribution)}</KpiCard>
          </div>
          <div className={s.col}>
            <h3 style={{ margin: 0, font: "var(--text-h3)" }}>{econ.base.orders}-order base scenario</h3>
            <div className={s.chartScroll} role="region" tabIndex={0} aria-label="Contribution waterfall chart">
            <div className={s.chart} role="img" aria-label={`Contribution waterfall: ${bars.map((b) => `${b.label} ${b.value}`).join(", ")}`}>
              {WATERFALL.lines.map((y) => <span key={y} className={s.chartLine} style={{ top: y }} />)}
              <div className={s.chartCols} aria-hidden="true">
                {bars.map((b) => (
                  <div key={b.label} className={s.chartCol}>
                    <span className={`${s.chartValue} ${b.strong ? s.chartValueStrong : ""}`} style={{ top: b.valueTop }}>{b.value}</span>
                    <span className={`${s.chartBar} ${b.strong ? s.chartBarStrong : ""}`} style={{ top: b.top, height: b.height }} />
                    <span className={s.chartLabel} style={{ top: WATERFALL.labelTop }}>{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
            </div>
            <section className={`${a.notice} ${s.hist} ${s.histSubtle}`} aria-label="Forecast, not settlement">
              <p className={a.label}>Forecast, not settlement</p>
              <p className={a.small}>Refund-adjusted net sales already exclude refunds. Shared subscriptions and overhead are excluded. Missing actual cost or fee data keeps eligibility incomplete.</p>
            </section>
          </div>
        </div>
      </Card>
      <Card labelledBy="gates-title" className={a.card20}>
        <div className={s.heading54}><h2 id="gates-title">Clear the right gate at the right stage.</h2><p>An invitation can precede acceptance, link issuance and creator payout activation. Its proposed terms still need approval.</p></div>
        <ul className={s.rowGates} aria-label="Execution gates">
          {GATE_ROWS.map((g) => <li key={g.title} className={s.rowGate}><span><Badge tone={g.tone} width={140}>{g.badge}</Badge></span><strong>{g.title}</strong><span>{g.detail}</span></li>)}
        </ul>
        <div className={s.actionsRow}>
          <Button style={{ minWidth: 242 }} aria-haspopup="dialog" onClick={() => setDialog("payload")}>Review approval payload</Button>
          <LinkButton variant="secondary" to="/settings/capabilities" style={{ minWidth: 208 }}>Open channel access</LinkButton>
          <p id={HISTORY_REASON}>New acquisition uses commission-only terms. Historical paid, gifted and hybrid records remain available; editing or duplicating them cannot create a new upfront fee offer.</p>
        </div>
      </Card>
      <p className={s.footer}>Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.</p>
      <HandoffDialog open={dialog === "commitment"} onClose={() => setDialog(null)} title="Commitment preview"
        rows={[
          { label: "Offer", value: `${record.offerCode} · version ${record.version}${dirty ? " (saved; your edits are not included)" : ""}` },
          { label: "Provider and account", value: `${PROVIDERS.find((p) => p.value === base.provider)!.label} · no verified account in this build` },
          { label: "Sample + shipping authorization", value: `${usdAuto(base.sampleShippingMinor / 100)} · approval reference not attached` },
          { label: "Earned commission", value: `${base.commissionPct}% of eligible merchandise · nothing earned yet` },
          { label: "Historical obligations", value: "Shown separately; none in this fixture" },
          { label: "Readiness", value: base.baseVerified ? "Native base verified" : "Blocked: native eligible base is unverified" },
        ]}>
        <p>This is a preview. It doesn't approve, invite or reserve stock.</p>
      </HandoffDialog>
      <HandoffDialog open={dialog === "payload"} onClose={() => setDialog(null)} title="Approval payload"
        rows={[
          { label: "Action", value: "Send the commission-only invitation (not available in this build)" },
          { label: "Recipients", value: "None selected" },
          { label: "Terms", value: `${base.commissionPct}% of eligible merchandise · $0 upfront · ${usdAuto(base.sampleShippingMinor / 100)} sample + shipping` },
          { label: "Policy and offer version", value: `commission-only-policy · ${record.version}` },
          { label: "Expiry", value: "Not set" },
        ]}>
        <p>{dirty ? "You have edits that aren't saved, so this shows the saved version. " : ""}Every material edit invalidates earlier approval readiness, and an old approval is never reused.{demo ? " Nothing is sent in the demo." : ""}</p>
      </HandoffDialog>
    </>
  );
}

const trim3 = (n: number) => `$${(Math.round(n * 1000) / 1000).toString()}`;