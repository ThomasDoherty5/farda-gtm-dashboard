import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { TextField } from "@/components/Field";
import { SectionTabs } from "@/components/SectionTabs";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { LeaveGuard } from "@/features/approvals/shared";
import { Pending, SourceButton, StaleNotice, PageTitle, evidencePath } from "@/features/creators/creatorsShared";
import { RECRUITMENT_DEFAULT, type RecruitmentData } from "@/fixtures/recruitment";
import { DEMO_COLLABORATION_ID, DEMO_OFFER_ID } from "@/fixtures/ids";
import { ContextBox, NavButtons, Steps, acquisition, assessmentPath, creators, styles } from "./recruitmentShared";
import { checkAffiliateTerms, checkDeliveryWindow, checkSampleAllocation, isDeliveryUnset, percentOf, type Check } from "./recruitmentRules";

const NETWORKS = [{ value: "both", label: "Instagram + TikTok" }, { value: "instagram", label: "Instagram" }, { value: "tiktok", label: "TikTok" }];
const ROUTES = [{ value: "queue", label: "Campaign applicants" }, { value: "inbound", label: "Inbound applications" }, { value: "outbound", label: "Found by us" }];
const allowed = (options: { value: string }[], raw: string | null, fallback: string) => (options.some((o) => o.value === raw) ? (raw as string) : fallback);
const MAX_PCT = 30;

type Draft = { instagram: string; tiktok: string; terms: string; rights: string; sample: string; delivery: string };
const ILLUSTRATIVE: Draft = { instagram: "1 Reel · 30–45 seconds", tiktok: "Optional · terms required", terms: "Draft 15% · $0 upfront", rights: "Rights to negotiate", sample: "1 creator · 1 sample", delivery: "Confirm in the source thread" };

const errorOf = (c: Check) => (c.ok ? null : c.error);
const draftChecks = (d: Draft) => ({
  terms: checkAffiliateTerms(d.terms, MAX_PCT),
  sample: checkSampleAllocation(d.sample),
  delivery: checkDeliveryWindow(d.delivery),
  instagram: d.instagram.trim() ? ({ ok: true } as Check) : ({ ok: false, error: "Describe the Instagram deliverable, or enter None." } as Check),
  tiktok: d.tiktok.trim() ? ({ ok: true } as Check) : ({ ok: false, error: "Describe the TikTok deliverable, or enter None." } as Check),
  rights: d.rights.trim() ? ({ ok: true } as Check) : ({ ok: false, error: "State the rights to negotiate, or enter None." } as Check),
});

/** Social Cat recruitment (Figma source 38:131, owner THO-298). A draft only: nothing here sends, approves or accepts. */
export function RecruitmentPage() {
  const demo = useScope().adapter.environment === "demo";
  const [search, setSearch] = useSearchParams();
  const networks = allowed(NETWORKS, search.get("networks"), RECRUITMENT_DEFAULT.networks);
  const route = allowed(ROUTES, search.get("route"), RECRUITMENT_DEFAULT.route);
  const query = useView<{ networks: string; route: string }, RecruitmentData>("recruitmentQueue", { networks, route }, null, { keepPrevious: true });
  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(search);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setSearch(next);
  };
  const [draft, setDraft] = useState<Draft>(ILLUSTRATIVE);
  const [reviewing, setReviewing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const dirty = (Object.keys(ILLUSTRATIVE) as (keyof Draft)[]).some((k) => draft[k] !== ILLUSTRATIVE[k]);
  const checks = draftChecks(draft);
  const blockers = (Object.entries(checks) as [string, Check][]).filter(([, c]) => !c.ok);
  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const rate = percentOf(draft.terms);

  return (
    <section aria-labelledby="rec-title" data-figma-source="38:131" className={acquisition.page}>
      <LeaveGuard dirty={dirty} />
      <PageTitle id="rec-title" title="Find the right creators. Move every match forward." subtitle="Social Cat recruitment · Instagram + TikTok publishing · website affiliate checkout">
        <SourceButton label="Open Social Cat" title="Open Social Cat" width={176} />
        <Button aria-haspopup="dialog" style={{ minWidth: 196 }} onClick={() => setReviewing(true)}>Review affiliate terms</Button>
      </PageTitle>
      <NavButtons current="Recruitment queue" items={[
        { label: "Social Cat dashboard", to: "/creators/social-cat?view=dashboard" },
        { label: "Prior content score", to: assessmentPath() },
        { label: "Recruitment queue", to: "/creators/social-cat/recruitment" },
        { label: "TikTok dashboard", to: "/creators/tiktok?view=dashboard" },
        { label: "TT scorecard", to: assessmentPath("tt") },
        { label: "Prepare invitation", to: "/creators/tiktok/invitations/new" },
      ]} />
      <ContextBox title="Commission-only acquisition" text="No upfront content fee. Product and shipping need separate approval. Qualify lifestyle content, routine compatibility and commerce evidence independently before proposing exact affiliate terms.">
        <div className={creators.contextActions}>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to={evidencePath} style={{ minWidth: 223.5 }}>Review lifestyle evidence</LinkButton>
        </div>
      </ContextBox>
      <div className={creators.row}>
        <Badge tone="violet" width={188}>Source: Social Cat</Badge>
        <FilterButton name="Publishing networks" title="Choose publishing networks" options={NETWORKS} value={networks} onChange={(v) => setParam("networks", v, "both")} width={196} bare />
        <FilterButton name="Route" title="Choose the recruitment route" options={ROUTES} value={route} onChange={(v) => setParam("route", v, "queue")} width={206} bare />
        <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 176 }}>Find Creators</LinkButton>
        <Badge tone="warning" width={252}>Browser access: to validate</Badge>
        {demo && <span className={acquisition.small}>Illustrative queue</span>}
      </div>
      <Pending query={query} subject="the recruitment queue">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? (
          <Body res={query.data as ReadResponse<RecruitmentData>} data={query.data.data} networks={networks} onPreview={() => setPreviewing(true)} />
        ) : (
          <EmptyState state="Empty" title="No creators in this queue"><p>The source responded, but no creator matches these filters.</p></EmptyState>
        ))}
      </Pending>

      <section className={creators.panel} aria-labelledby="rec-flow-title">
        <h2 id="rec-flow-title" className={acquisition.h2}>The browser acts in Social Cat. Zapier keeps the record moving.</h2>
        <Steps label="Recruitment flow" steps={["Discover + dedupe", "Score + evidence", "Approve action", "Invite + agree", "Sample + create", "Verify + settle"]} />
        <p className={acquisition.small}>Applicants / Find Creators → approved invite or acceptance → native match + Inbox terms → sample → draft/revision → Instagram / TikTok publication → external attribution and settlement → close or repeat.</p>
      </section>

      <div className={creators.pairWide}>
        <section className={`${creators.panel} ${styles.form}`} aria-labelledby="rec-terms-title">
          <h2 id="rec-terms-title" className={acquisition.h2}>Terms, per publishing network.</h2>
          <p className={acquisition.small}>@routine.with.ella · {RECRUIT_REF} · new affiliate draft</p>
          <div className={styles.fields}>
            <TextField label="Instagram" helpText="Proposed deliverable · negotiate before acceptance" value={draft.instagram} error={errorOf(checks.instagram)} onChange={set("instagram")} />
            <TextField label="TikTok" helpText="Adding a post requires new terms + approval" value={draft.tiktok} error={errorOf(checks.tiktok)} onChange={set("tiktok")} />
            <TextField label="Affiliate terms" helpText="Illustrative rate, not approved · external provider settles earned commission" value={draft.terms} error={errorOf(checks.terms)} onChange={set("terms")} />
            <TextField label="Rights" helpText="Affiliation does not grant usage rights" value={draft.rights} error={errorOf(checks.rights)} onChange={set("rights")} />
            <TextField label="Sample allocation" helpText="Release only after terms, budget and stock gates" value={draft.sample} error={errorOf(checks.sample)} onChange={set("sample")} />
            <TextField label="Delivery window" helpText="Do not invent a posting date" value={draft.delivery} error={errorOf(checks.delivery)} onChange={set("delivery")} />
          </div>
        </section>
        <section className={`${creators.panel} ${creators.panelViolet}`} aria-labelledby="rec-msg-title">
          <Badge tone="warning" width={276}>Affiliate draft v1 · not approved</Badge>
          <h2 id="rec-msg-title" className={acquisition.h2}>Draft an affiliate invitation.</h2>
          <p className={styles.message} data-testid="draft-message">
            Hi Ella! We'd love to explore an affiliate collaboration featuring Farda in your everyday routine. This draft offers {rate === null ? "[add a valid rate]" : `${rate}%`} of eligible website merchandise sales, with no upfront content fee. We would provide the product and shipping after approval. Please review the attribution, refund, payment and content terms before accepting.
          </p>
          <p className={acquisition.small}>Recipient, terms, content, destination and version must match the approval receipt. Editing invalidates approval.</p>
          <Button aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => setReviewing(true)}>Review affiliate terms</Button>
          {dirty ? <Button variant="secondary" style={{ width: "100%" }} onClick={() => setDraft(ILLUSTRATIVE)}>Reset to the illustrative draft</Button> : <LinkButton variant="secondary" to={`/offers/${DEMO_OFFER_ID}`} style={{ width: "100%" }}>Open offer terms</LinkButton>}
          <p className={styles.micro}>No invitation or message has been sent by this design.</p>
        </section>
      </div>

      <section className={`${creators.panel}`} aria-labelledby="rec-match-title">
        <h2 id="rec-match-title" className={acquisition.h2}>A match is the beginning.</h2>
        <div className={styles.buttons}>
          <Button disabledReason="Needs source-confirmed acceptance plus separately approved stock and cost." reasonFor="match-reasons" style={{ minWidth: 230 }}>Sample after acceptance</Button>
          <Button disabledReason="Needs accepted content obligations. Uncommitted content has no no-post breach." reasonFor="match-reasons" style={{ minWidth: 220 }}>Content after agreement</Button>
          <Button disabledReason="Needs an explicit rights scope and term. Reuse is never inferred." reasonFor="match-reasons" style={{ minWidth: 165 }}>Rights to agree</Button>
          <LinkButton variant="secondary" to="/finance/commissions" style={{ minWidth: 234 }}>Commission ledger</LinkButton>
          <LinkButton to="/content" style={{ minWidth: 234 }}>Content monitor</LinkButton>
        </div>
        <p id="match-reasons" className={acquisition.small}>
          Social Cat owns recruitment and collaboration. The external affiliate provider owns website tracking and commission settlement. Linked native posts / creator insights supply observed performance. Sample, content and rights stay locked until each one's own gate is met: a source-confirmed acceptance with approved stock and cost, accepted content obligations, and an agreed rights scope.
        </p>
      </section>

      <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="rec-policy-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="rec-policy-title" className={acquisition.h2}>Current policy. Separate settlement responsibilities.</h2>
          <p id="policy-note" className={acquisition.small}>New offers are affiliate-only with no upfront content fee. Accepted historical content fees remain payable in their original records.</p>
        </div>
        <SectionTabs label="Offer type" gap={8} tabs={[
          { label: "Gifted · history", to: "#", width: 190, disabled: true, reasonId: "policy-note" },
          { label: "Paid · history", to: "#", width: 190, disabled: true, reasonId: "policy-note" },
          { label: "Affiliate · current", to: "#", width: 190, current: true },
          { label: "Hybrid · history", to: "#", width: 190, disabled: true, reasonId: "policy-note" },
        ]} />
        <ul className={creators.settle}>
          <li><Badge width={140}>Not allowed</Badge><p className={creators.settleName}>New upfront content fee</p><p className={acquisition.small}>$0 under the current acquisition policy. Historical accepted fees remain separate.</p></li>
          <li><Badge tone="violet" width={140}>Provider-owned</Badge><p className={creators.settleName}>Affiliate commission</p><p className={acquisition.small}>Validate the provider route before invite; terms before shipping; tracking before commerce; payout setup before provider payout.</p></li>
          <li><Badge tone="warning" width={140}>Permission missing</Badge><p className={creators.settleName}>Social Cat automated execution</p><p className={acquisition.small}>Record express provider authorization before automated reads or writes</p></li>
          <li><Badge width={140}>Terminal outcome</Badge><p className={creators.settleName}>No qualifying content</p><p className={acquisition.small}>Review agreed obligations, record the outcome and retain sample cost; no automatic clawback.</p></li>
        </ul>
        <div className={creators.contextActions}>
          <LinkButton to={`/offers/${DEMO_OFFER_ID}`} style={{ minWidth: 204 }}>Configure offer</LinkButton>
          <LinkButton variant="secondary" to={assessmentPath()} style={{ minWidth: 218 }}>Prior commerce score</LinkButton>
          <LinkButton variant="secondary" to="/finance/commissions" style={{ minWidth: 218 }}>Commission ledger</LinkButton>
          <LinkButton variant="ghost" to="/settings/capabilities" style={{ minWidth: 190 }}>Channel access</LinkButton>
        </div>
      </section>

      <Dialog open={reviewing} title="Review affiliate terms" badge="Draft · not approved" onClose={() => setReviewing(false)}>
        <dl className={styles.reviewList} data-testid="review-terms">
          <div><dt>Recipient</dt><dd>@routine.with.ella · {RECRUIT_REF}</dd></div>
          <div><dt>Instagram</dt><dd>{draft.instagram}</dd></div>
          <div><dt>TikTok</dt><dd>{draft.tiktok}</dd></div>
          <div><dt>Affiliate terms</dt><dd>{rate === null ? "No valid rate" : `${rate}% of eligible website merchandise sales · $0 upfront`}</dd></div>
          <div><dt>Rights</dt><dd>{draft.rights}</dd></div>
          <div><dt>Sample allocation</dt><dd>{draft.sample}</dd></div>
          <div><dt>Delivery window</dt><dd>{isDeliveryUnset(draft.delivery) ? "Not set · confirm in the source thread" : draft.delivery}</dd></div>
          <div><dt>Version</dt><dd>Affiliate draft v1 · not approved</dd></div>
        </dl>
        {blockers.length > 0 && (
          <div role="alert" aria-label="Fix before requesting approval">
            <ul className={styles.blockers}>
              {blockers.map(([key, c]) => <li key={key}>{key}: {c.ok ? "" : c.error}</li>)}
            </ul>
          </div>
        )}
        <p>This is a preview. Nothing has been approved or sent, and a match or draft is not an accepted agreement. Editing any term invalidates approval.</p>
        <Button variant="secondary" onClick={() => setReviewing(false)}>Close preview</Button>
      </Dialog>

      <Dialog open={previewing} title="Preview discovery run" badge="Demo" onClose={() => setPreviewing(false)}>
        <dl className={styles.reviewList}>
          <div><dt>Source</dt><dd>Social Cat · Find Creators</dd></div>
          <div><dt>Configuration</dt><dd>Daily, draft schedule · not live</dd></div>
          <div><dt>Limits</dt><dd>Unknown: read the signed-in plan, remaining capacity and renewal date first</dd></div>
          <div><dt>Expected stages</dt><dd>Discover + dedupe → Score + evidence → Approve action</dd></div>
        </dl>
        <p>A preview. No job has been started, and nothing is sent or accepted.</p>
        <LinkButton to="/creators/discovery">Open daily sourcing</LinkButton>
        <Button variant="secondary" onClick={() => setPreviewing(false)}>Close preview</Button>
      </Dialog>
    </section>
  );
}

const RECRUIT_REF = "OP-SC-DEMO-051";

function Body({ res, data, networks, onPreview }: { res: ReadResponse<RecruitmentData>; data: RecruitmentData; networks: string; onPreview: () => void }) {
  const allocation = (networks === "both" ? data.allocation.instagram + data.allocation.tiktok : data.allocation[networks as "instagram" | "tiktok"]);
  const link = (to: RecruitmentData["queue"][number]["next"]["to"]) => (to === "assessment" ? assessmentPath() : to === "brief" ? `/collaborations/${DEMO_COLLABORATION_ID}?tab=overview` : evidencePath);
  return (
    <>
      <StaleNotice res={res} />
      <KpiRow align="start">
        <Kpi label="Historical allocation" context={`Planning reference · not current stock${networks === "both" ? "" : ` · ${networks === "instagram" ? "Instagram" : "TikTok"} only`}`} testId="metric-Historical allocation">{allocation}</Kpi>
        <Kpi label="Instagram primary" context="One sample per creator" testId="metric-Instagram primary">{data.allocation.instagram}</Kpi>
        <Kpi label="TikTok → website" context="Separate from Affiliate Center" testId="metric-TikTok → website">{data.allocation.tiktok}</Kpi>
        <Kpi label="Additional cross-posts" context="Separate assets, same collaboration" testId="metric-Additional cross-posts">{data.crossPostExtraSamples} extra samples</Kpi>
      </KpiRow>
      <div className={creators.pairWide}>
        <section className={creators.panel} aria-labelledby="rec-queue-title">
          <h2 id="rec-queue-title" className={acquisition.h2}>Focus on the next useful action.</h2>
          <p className={acquisition.small}>Synthetic current queue · v3 assessment pending · direct lifestyle evidence required</p>
          {data.queue.length === 0 ? (
            <p className={acquisition.small} role="status">No creator in the queue matches these filters. Choose all networks and the full queue to see everyone.</p>
          ) : (
            <DataTable
              caption="Recruitment queue"
              columns={[{ label: "CREATOR", width: "30.1%" }, { label: "ASSESSMENT", width: "9.7%" }, { label: "STATE", width: "23%" }, { label: "NETWORK", width: "16.8%" }, { label: "NEXT" }]}
              rows={data.queue.map((r) => [r.handle, r.assessment, r.state, r.network, <LinkButton key={r.id} variant="secondary" to={link(r.next.to)} style={{ minWidth: 144, paddingInline: 8 }}>{r.next.label}</LinkButton>])}
              variant="list"
              testId="recruit-queue"
              minWidth={640}
            />
          )}
          <p className={acquisition.small}>Use the website affiliate model for website checkout, regardless of recruitment source or posting network. V3 weights remain unpublished; prior v2 scores stay in history.</p>
        </section>
        <section className={`${creators.panel} ${creators.panelDark} ${creators.panelBare}`} aria-labelledby="rec-plan-title">
          <h2 id="rec-plan-title" className={acquisition.h2} style={{ color: "var(--color-onDark)" }}>{data.plan.name}</h2>
          <p className={creators.big} style={{ color: "var(--color-onDark)" }}>{data.plan.price}</p>
          <p className={acquisition.small}>Highest listed self-service plan · configuration reference only</p>
          <Badge tone="warning" width={240}>Actual usage unknown</Badge>
          <p style={{ font: "var(--text-body)" }}>Published reference: 30 collaborations / month, 5,000 invitations, unlimited campaigns and 10 team members.</p>
          <p className={acquisition.small}>Read the signed-in plan, remaining capacity and renewal date before proposing an invite or acceptance.</p>
          <LinkButton variant="secondary" to="/settings/capabilities" style={{ width: "100%" }}>Open plan & usage</LinkButton>
          <Button aria-haspopup="dialog" style={{ width: "100%" }} onClick={onPreview}>Preview discovery run</Button>
        </section>
      </div>
    </>
  );
}
