import { useState } from "react";
import { useScope } from "@/adapter/scope";
import { NativeInvitationPage } from "./NativeInvitationPage";
import type { ReadResponse } from "@/adapter/contract";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState } from "@/components/EmptyState";
import { TextField } from "@/components/Field";
import { Kpi, KpiRow } from "@/components/Kpi";
import { LeaveGuard, blockedReason, dateTime } from "@/features/approvals/shared";
import { PageTitle, Pending, SourceButton, StaleNotice, evidencePath } from "@/features/creators/creatorsShared";
import { DEMO_BATCH_ID, DEMO_SETTLEMENT_ID } from "@/fixtures/ids";
import type { InvitationData } from "@/fixtures/recruitment";
import { BareTitle, ContextBox, NavButtons, Steps, acquisition, assessmentPath, creators, styles } from "./recruitmentShared";
import { checkCommission, checkCreator, checkExpiry, checkProduct, checkSample, checkStart, parsePacific, percentOf, type Check } from "./recruitmentRules";

type Draft = { creator: string; product: string; commission: string; sample: string; starts: string; expires: string };
const INITIAL: Draft = { creator: "@studio.rae", product: "Farda bottle + companion app", commission: "12% · illustrative proposal", sample: "Free sample · separate approval", starts: "", expires: "" };
const errorOf = (c: Check) => (c.ok ? null : c.error);

/** TikTok native invitation (Figma source 38:348, owner THO-298). An exact draft: nothing here sends, approves or reaches TikTok. */
export function InvitationPage() {
  const ctx = useScope();
  return ctx.adapter.kind === "demo" ? <DemoInvitationPage /> : <NativeInvitationPage />;
}
function DemoInvitationPage() {
  const query = useView<Record<string, never>, InvitationData>("invitationDraft", {});
  return (
    <section aria-labelledby="inv-title" data-figma-source="38:348" className={acquisition.page}>
      {!query.isPending && !query.data?.data && <BareTitle id="inv-title" title="One precise request. A verifiable outcome." />}
      <Pending query={query} subject="the invitation draft">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? <Body res={query.data as ReadResponse<InvitationData>} data={query.data.data} /> : <EmptyState state="Empty" title="No invitation draft"><p>The source responded, but no draft is available for this account.</p></EmptyState>)}
      </Pending>
    </section>
  );
}

type Preview = null | "request" | "confirmed" | "sample";

function Body({ res, data }: { res: ReadResponse<InvitationData>; data: InvitationData }) {
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [edited, setEdited] = useState<Set<keyof Draft>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<Preview>(null);
  const dirty = (Object.keys(INITIAL) as (keyof Draft)[]).some((k) => draft[k] !== INITIAL[k]);
  const set = (key: keyof Draft) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setEdited((e) => new Set(e).add(key));
  };
  const { program } = data;
  const checks: Record<keyof Draft, Check> = {
    creator: checkCreator(draft.creator, data.creators),
    product: checkProduct(draft.product, data.products),
    commission: checkCommission(draft.commission, program.maxCommissionPct),
    sample: checkSample(draft.sample),
    starts: checkStart(draft.starts),
    expires: checkExpiry(draft.expires, draft.starts, program.maxValidityDays),
  };
  const shown = (k: keyof Draft) => (attempted || edited.has(k) ? errorOf(checks[k]) : null);
  const invalid = (Object.entries(checks) as [keyof Draft, Check][]).filter(([, c]) => !c.ok);
  const rate = percentOf(draft.commission);
  const firstName = draft.creator.replace(/^@/, "").split(".")[0] ?? "there";
  const greeting = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  const sendBlocked = blockedReason(res, "sendInvitation") ?? "Not available.";
  const open = (p: Preview) => {
    if (p === "request") setAttempted(true);
    setPreview(p);
  };
  const startIso = parsePacific(draft.starts);
  const endIso = parsePacific(draft.expires);
  const known = (iso: string | null, text: string) => (iso ? `${text} (${dateTime(iso)})` : "Not set");

  return (
    <>
      <LeaveGuard dirty={dirty} />
      <PageTitle id="inv-title" title="One precise request. A verifiable outcome." subtitle="TikTok Affiliate Center · Target Collaboration · @studio.rae · synthetic draft">
        <SourceButton label="Open Affiliate Center" title="Open Affiliate Center" width={192} />
        <Button aria-haspopup="dialog" style={{ minWidth: 196 }} onClick={() => open("request")}>Review exact request</Button>
      </PageTitle>
      <NavButtons current="Prepare invitation" items={[
        { label: "Social Cat dashboard", to: "/creators/social-cat?view=dashboard" },
        { label: "SC scorecard", to: assessmentPath() },
        { label: "Recruitment queue", to: "/creators/social-cat/recruitment" },
        { label: "TikTok dashboard", to: "/creators/tiktok?view=dashboard" },
        { label: "Prior TikTok score", to: assessmentPath("tt") },
        { label: "Prepare invitation", to: "/creators/tiktok/invitations/new" },
      ]} />
      <ContextBox title="Commission-only acquisition" text="New invitations have no guaranteed content fee. Use TikTok Shop checkout evidence and the unpublished v3 model; sample approval and native standard / Shop Ads commission terms remain separate.">
        <div className={creators.contextActions}>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to={evidencePath} style={{ minWidth: 223.5 }}>Review lifestyle evidence</LinkButton>
        </div>
      </ContextBox>
      <div className={creators.row}>
        <Badge tone="warning" width={252}>Shop eligibility: to validate</Badge>
        <Badge tone="violet" width={252}>Prior {data.priorScore.model} · {data.priorScore.value}</Badge>
        <span className={acquisition.small}>If Shop is unavailable, use the separate website-creator lane. Never assume product eligibility.</span>
      </div>
      <StaleNotice res={res} />
      <KpiRow align="start">
        <Kpi label="Creator fit score" context="Prior v2 · read-only · hard gates pending" testId="metric-Creator fit score">{data.priorScore.value} / 100</Kpi>
        <Kpi label="Live quota remaining" context="Read current seller / creator-tier quota" testId="metric-Live quota remaining">{data.quota.state === "unknown" ? "N/A" : "Known"}</Kpi>
        <Kpi label="Conditional Shop samples" context="First-wave allocation · eligibility required" testId="metric-Conditional Shop samples">{data.plannedSamples} planned</Kpi>
        <Kpi label="Sample decision" context="Invitation acceptance is not sample approval" testId="metric-Sample decision">Manual review</Kpi>
      </KpiRow>

      <div className={creators.pairWide}>
        <section className={`${creators.panel} ${styles.form}`} aria-labelledby="inv-terms-title">
          <h2 id="inv-terms-title" className={acquisition.h2}>Make every term explicit.</h2>
          <p className={acquisition.small}>Product, commission, sample terms, dates and message form one versioned action.</p>
          <div className={styles.fields}>
            <TextField label="Creator" helpText="Verify profile and suppression state" value={draft.creator} error={shown("creator")} onChange={set("creator")} />
            <TextField label="Product" helpText="Listing / category / market eligibility unverified" value={draft.product} error={shown("product")} onChange={set("product")} />
            <TextField label="Commission" helpText="Validate contribution and approved campaign limits" value={draft.commission} error={shown("commission")} onChange={set("commission")} />
            <TextField label="Sample" helpText="One native sample order after approval" value={draft.sample} error={shown("sample")} onChange={set("sample")} />
            <TextField label="Invitation starts" helpText="Exact timestamp is part of the final action" placeholder="Set before approval" value={draft.starts} error={shown("starts")} onChange={set("starts")} />
            <TextField label="Invitation expires" helpText="Actual end date required before sending" placeholder="7-day validity · proposed" value={draft.expires} error={shown("expires")} onChange={set("expires")} />
          </div>
          <div className={styles.notice}>
            <p className={styles.noticeTitle}>Native Automate Invitations: {data.automateInvitations}</p>
            <p className={acquisition.small}>Verify account availability first. It shares outreach quota and may apply a suggested sample decision after three days without intervention. No silent enablement.</p>
          </div>
        </section>
        <section className={`${creators.panel} ${creators.panelDark} ${creators.panelBare}`} aria-labelledby="inv-msg-title">
          <Badge tone="warning" width={272}>Draft {data.draftVersion} · not authorized</Badge>
          <h2 id="inv-msg-title" className={acquisition.h2} style={{ color: "var(--color-onDark)" }}>A request worth responding to.</h2>
          <p className={styles.message} data-testid="draft-message">
            Hi {greeting}! We'd love to collaborate on a clear, everyday-routine demonstration of the Farda bottle and companion app. The proposed commission is {rate === null ? "[add a valid rate]" : `${rate}%`}, with a free sample subject to separate approval. Please review the product, supported setup guidance and terms in this Target Collaboration request.
          </p>
          <p id="send-pending" className={acquisition.small}>Pending: verified listing, source quota, final validity dates and exact-action approval.</p>
          <Button aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => open("request")}>Review exact request</Button>
          <Button style={{ width: "100%" }} disabledReason={sendBlocked} reasonFor="send-pending">Send request · blocked</Button>
          <p className={styles.micro}>Prototype only · no account connected and no request sent.</p>
        </section>
      </div>

      <section className={`${creators.panel}`} aria-labelledby="inv-flow-title" style={{ gap: 18 }}>
        <h2 id="inv-flow-title" className={acquisition.h2}>From approval to source evidence.</h2>
        <Steps label="Approval to source evidence" steps={["Approve exact v2", "Recheck live gates", "Send in browser", "Capture invite ID", "Commit receipt", "Track response"]} />
        <p className={acquisition.small}>The browser verifies the account and recipient, reads quota capacity and sends once. An uncertain outcome stops replay until the source invitation list is reconciled.</p>
        <div className={styles.buttons}>
          <Button aria-haspopup="dialog" style={{ minWidth: "min(360px, 100%)" }} onClick={() => open("confirmed")}>Preview confirmed invitation</Button>
          <LinkButton variant="secondary" to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: "min(360px, 100%)" }}>Explore uncertain invitation</LinkButton>
          <LinkButton variant="secondary" to="/settings/connections" style={{ minWidth: "min(360px, 100%)" }}>View connection readiness</LinkButton>
        </div>
      </section>

      <section className={creators.panel} aria-labelledby="inv-sample-title" style={{ gap: 18 }}>
        <h2 id="inv-sample-title" className={acquisition.h2}>Approve samples inside TikTok.</h2>
        <p style={{ margin: 0, color: "var(--color-muted)" }}>When the API or Zapier connector cannot perform the action, route the approved decision to the browser in Affiliate Center / Sample Requests.</p>
        <div className={styles.sampleGrid}>
          <div className={styles.sampleInfo}>
            <Badge tone="violet" width={324}>Execution route: Browser fallback</Badge>
            <dl className={styles.sampleList}>
              <div className={styles.sampleRow}><dt>Sample request</dt><dd>{data.sampleRequest.id} · {data.sampleRequest.handle}</dd></div>
              <div className={styles.sampleRow}><dt>Native deadline</dt><dd>{data.sampleRequest.nativeDeadline}</dd></div>
              <div className={styles.sampleRow}><dt>Last source read</dt><dd>{data.sampleRequest.lastRead}</dd></div>
            </dl>
            <p className={acquisition.small}>Hourly checks feed an urgent queue. Refresh the actual native deadline before acting; keep approval, budget, one-sample allocation and stock gates intact.</p>
          </div>
          <div className={styles.sampleBox}>
            <Badge tone="warning" width={260}>Due in 5h 20m · demo</Badge>
            <h3 className={creators.h3}>Source evidence closes the step.</h3>
            <p className={acquisition.small}>Capture native decision status + receipt. Unknown result → reconcile. Login, MFA or UI changes → human takeover.</p>
            <LinkButton to="/approvals">Review sample decision</LinkButton>
            <Button variant="secondary" aria-haspopup="dialog" onClick={() => open("sample")}>Preview sample receipt</Button>
          </div>
        </div>
      </section>

      <section className={`${creators.panel} ${creators.panelViolet}`} aria-labelledby="inv-accept-title">
        <h2 id="inv-accept-title" className={acquisition.h2}>Acceptance unlocks the next review, not a free sample.</h2>
        <Steps label="After acceptance" steps={["Accepted", "Sample approved", "Native order", "Delivered", "Live verified", "Reconciled"]} />
        <p style={{ margin: 0, color: "var(--color-muted)" }}>Follow the real sample order and native posting due date. Verify product linkage, source-window attribution, refunds, commission and settlement before proposing repeat content.</p>
        <div className={styles.buttons}>
          <LinkButton variant="secondary" to="/inventory" style={{ minWidth: "min(280px, 100%)" }}>View sample handoff</LinkButton>
          <LinkButton to="/content" style={{ minWidth: "min(280px, 100%)" }}>Open content monitor</LinkButton>
          <LinkButton variant="secondary" to={`/finance/settlements/${DEMO_SETTLEMENT_ID}`} style={{ minWidth: "min(280px, 100%)" }}>Review settlement</LinkButton>
        </div>
      </section>

      <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="inv-native-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="inv-native-title" className={acquisition.h2}>Approve terms before native commitment.</h2>
          <p className={acquisition.small}>Standard vs Shop Ads rate, active vs proposed/effective terms and flat-fee funding are separate fields.</p>
        </div>
        <p className={acquisition.small}>Open PENDING samples may use the documented review API with verified seller scope. Target or other unverified actions use a validated browser route; neither route bypasses permissions, stock or exact-action <br className="wide-break" />approval.</p>
        <div className={styles.buttons}>
          <LinkButton to={`/finance/settlements/${DEMO_SETTLEMENT_ID}`} style={{ minWidth: 262 }}>Native settlement & rates</LinkButton>
          <LinkButton variant="secondary" to={`/batches/${DEMO_BATCH_ID}`} style={{ minWidth: 208 }}>Bulk operations</LinkButton>
          <LinkButton variant="secondary" to="/settings/capabilities" style={{ minWidth: 190 }}>Channel access</LinkButton>
        </div>
      </section>

      <Dialog open={preview === "request"} title="Review exact request" badge="Draft · not authorized" onClose={() => setPreview(null)}>
        <dl className={styles.reviewList} data-testid="review-request">
          <div><dt>Creator</dt><dd>{draft.creator}{checks.creator.ok ? " · exact profile, suppression clear" : ""}</dd></div>
          <div><dt>Product</dt><dd>{draft.product} · listing unverified</dd></div>
          <div><dt>Commission</dt><dd>{rate === null ? "No valid rate" : `${rate}% per eligible sale`} · $0 guaranteed</dd></div>
          <div><dt>Sample</dt><dd>{draft.sample}</dd></div>
          <div><dt>Starts</dt><dd>{known(startIso, draft.starts)}</dd></div>
          <div><dt>Expires</dt><dd>{known(endIso, draft.expires)}</dd></div>
          <div><dt>Provider</dt><dd>TikTok Affiliate Center · Target Collaboration · no account connected</dd></div>
          <div><dt>Policy</dt><dd>commission-only@demo · version {data.draftVersion}</dd></div>
        </dl>
        <div role="alert" aria-label="What still blocks this request">
          <ul className={styles.blockers}>
            {invalid.map(([key, c]) => <li key={key}>{key}: {c.ok ? "" : c.error}</li>)}
            <li>Source capability is unverified, and live quota is unknown (N/A).</li>
            <li>No approval has been requested for this exact version.</li>
          </ul>
        </div>
        <p>This is a preview, not an approval or a send. Editing any term makes a new version that needs its own approval.</p>
        <Button variant="secondary" onClick={() => setPreview(null)}>Close preview</Button>
      </Dialog>
      <Dialog open={preview === "confirmed"} title="Confirmed invitation · synthetic" badge="Demo" onClose={() => setPreview(null)}>
        <p>What a source receipt will show once TikTok confirms a send: the invitation ID, the exact recipient and account, and the time it was read. Only that receipt means sent. This one is an example, and nothing was sent.</p>
        <dl className={styles.reviewList}><div><dt>Invite ID</dt><dd>INV-DEMO-0001 · example</dd></div><div><dt>Recipient</dt><dd>@studio.rae</dd></div><div><dt>Read at</dt><dd>29 Oct, 10:40 PT · example</dd></div></dl>
        <Button variant="secondary" onClick={() => setPreview(null)}>Close preview</Button>
      </Dialog>
      <Dialog open={preview === "sample"} title="Sample receipt · synthetic" badge="Demo" onClose={() => setPreview(null)}>
        <p>A native decision status and receipt close this step. This is an example: no sample was approved, and no TikTok account is connected.</p>
        <dl className={styles.reviewList}><div><dt>Request</dt><dd>{data.sampleRequest.id} · example</dd></div><div><dt>Decision</dt><dd>Not recorded</dd></div></dl>
        <Button variant="secondary" onClick={() => setPreview(null)}>Close preview</Button>
      </Dialog>
    </>
  );
}
