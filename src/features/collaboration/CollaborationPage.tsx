import { SourceReadGrant } from "@/components/SourceReadGrant";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { ActionResponse, ReadResponse } from "@/adapter/contract";
import type { CommandPayload } from "@/adapter/demoCollaboration";
import { useAction } from "@/adapter/useAction";
import { scopeKey, useScope } from "@/adapter/scope";
import type { NativeCollaborationData } from "@/creator-agent/collaborationWorkflowSchema";
import { NativeCollaboration } from "./NativeCollaboration";
import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Drawer } from "@/components/Drawer";
import { Panel } from "@/components/PageKit";
import { AdapterError, mustClearProtectedData } from "@/adapter/errors";
import { CollaborationEvidence } from "./CollaborationEvidence";
import { EmptyState } from "@/components/EmptyState";
import { SelectField, TextField } from "@/components/Field";
import { formatMoney } from "@/components/MetricValue";
import { SectionTabs } from "@/components/SectionTabs";
import { ActionError } from "@/features/approvals/shared";
import { PageTitle, Pending, SourceButton, StaleNotice } from "@/features/creators/creatorsShared";
import { BareTitle, ContextBox, acquisition, assessmentPath, creators } from "@/features/recruitment/recruitmentShared";
import { approvalBlocker, postingTiming, revisionsRemaining, type CollaborationData } from "@/fixtures/collaboration";
import { DEMO_OFFER_ID } from "@/fixtures/ids";
import styles from "./Collaboration.module.css";

type Tab = "overview" | "brief" | "content" | "messages" | "payments" | "rights";
const TABS: Tab[] = ["overview", "brief", "content", "messages", "payments", "rights"];
const parseTab = (raw: string | null): Tab => (TABS.includes(raw as Tab) ? (raw as Tab) : "overview");

const longDate = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const EVENT_TONE: Record<string, BadgeTone> = { Completed: "success", Running: "violet", Pending: "neutral" };
const RESULT_TONE: Record<string, BadgeTone> = { Pass: "success", "Needs review": "warning", "Missing license": "warning", Pending: "neutral" };

/** Collaboration detail (Figma 9:299, `?tab=overview`) and content review and rights (9:436, `?tab=content`). Owner THO-295. Every command only queues a request for approval. */
export function CollaborationPage() {
  const { collaborationId = "" } = useParams();
  const [search] = useSearchParams();
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const tab = parseTab(search.get("tab"));
  const context = useScope();
  const {adapter}=context;
  const query = useView<{ collaborationId: string }, CollaborationData|NativeCollaborationData>("collaborationDetail", { collaborationId });
  const raw = query.isError ? null : query.data?.data;
  const native = raw && "kind" in raw && raw.collaborationRef === collaborationId ? raw : null;
  const fixture = raw && !("kind" in raw) && (adapter.kind === "demo" || raw.datasetKey === "collaboration-demo") && raw.collaborationId === collaborationId ? raw : null;
  const hasDetails = Boolean((native || fixture) && query.data?.dataState !== "empty");
  const accessDenied = query.error instanceof AdapterError && mustClearProtectedData(query.error.category);
  const drawerOpen = evidenceId === collaborationId && hasDetails && !accessDenied;
  return (
    <SourceReadGrant validUntil={native?.readAccess?.validUntil} title="One collaboration. The whole story." titleId="collab-title" refresh={()=>void query.refetch()}><section aria-labelledby="collab-title" data-figma-source={tab === "content" ? "9:436" : "9:299"} className={acquisition.page}>
      {!query.isPending && !raw && <BareTitle id="collab-title" title="One collaboration. The whole story." />}
      <Pending query={query} subject="the collaboration">
        {fixture && adapter.kind!=="demo" && <p role="status">Illustrative collaboration fixture returned by this adapter.</p>}
        {query.data && (native ? <NativeCollaboration key={JSON.stringify([scopeKey(context),collaborationId])} data={native} res={query.data} tab={tab} openEvidence={() => setEvidenceId(collaborationId)} reload={()=>query.refetch()}/> : fixture && query.data.dataState !== "empty" ? <Body res={query.data as ReadResponse<CollaborationData>} data={fixture} tab={tab} openEvidence={() => setEvidenceId(collaborationId)} /> : <EmptyState state="Empty" title="No collaboration record"><p>The source responded, but this collaboration has no record.</p></EmptyState>)}
      </Pending>
      {!query.isPending && !hasDetails && !accessDenied &&
        <Panel title="Saved collaboration evidence" headingId="saved-evidence-heading">
          <CollaborationEvidence key={collaborationId} collaborationId={collaborationId} />
        </Panel>}
      <Drawer open={drawerOpen} title="Saved collaboration evidence" onClose={() => setEvidenceId(null)}>
        {drawerOpen && <CollaborationEvidence key={collaborationId} collaborationId={collaborationId} />}
      </Drawer>
    </section></SourceReadGrant>
  );
}

type Spec = {
  key: string;
  title: string;
  intro: string;
  submit: string;
  actionKind: string;
  notes: string[];
  fields: { key: string; label: string; kind: "text" | "textarea" | "select"; options?: { value: string; label: string }[]; initial?: string; help?: string; required?: boolean }[];
  list?: { title: string; items: string[] };
  blocked?: string | null;
  payload: (values: Record<string, string>) => Omit<CommandPayload, "collaborationId">;
};

function Body({ res, data, tab, openEvidence }: { res: ReadResponse<CollaborationData>; data: CollaborationData; tab: Tab; openEvidence: () => void }) {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [ack, setAck] = useState<ActionResponse | null>(null);
  const [gifted, setGifted] = useState(false);
  const contentView = tab === "content" || tab === "rights";
  const { content, terms } = data;
  const remaining = revisionsRemaining(terms.revisionRounds);
  const baseSpecs: Record<string, Spec> = {
    next: { key: "next", title: "Queue next action", intro: `The server decides which actions are allowed for ${data.handle}. Choosing one queues a request for approval; it doesn't send anything.`, submit: "Queue for approval", actionKind: "queueNextAction", notes: ["Applicable obligations and suppression are checked before this is queued.", "Nothing is sent until a person approves the exact action."], fields: [{ key: "actionKey", label: "Next action", kind: "select", required: true, initial: data.allowedActions[0]?.key ?? "", options: data.allowedActions.map((a) => ({ value: a.key, label: a.label })) }], payload: (v) => ({ actionKey: v.actionKey! }) },
    close: { key: "close", title: "Close collaboration", intro: "Choose the outcome and say why. This requests the terminal transition; history and outstanding costs stay.", submit: "Request closure", actionKind: "closeCollaboration", notes: ["Opt-out blocks future outreach. Reopening needs an explicit reason, and a new brief starts a new collaboration.", "The retained sample cost stays on record."], list: { title: "Unresolved obligations", items: data.unresolved }, fields: [{ key: "outcome", label: "Outcome", kind: "select", required: true, initial: "", options: [{ value: "", label: "Choose an outcome" }, ...data.closureOutcomes.map((o) => ({ value: o, label: o }))] }, { key: "reason", label: "Reason", kind: "textarea", required: true, initial: "" }], payload: (v) => ({ outcome: v.outcome!, reason: v.reason! }) },
    suppress: { key: "suppress", title: "Suppress outreach", intro: `Stops outreach to ${data.handle} on this identity. Historical collaboration facts are kept.`, submit: "Request suppression", actionKind: "suppressOutreach", notes: ["Browser tasks are canceled or paused before another outbound action is allowed."], fields: [{ key: "reason", label: "Reason", kind: "textarea", required: true, initial: "" }], payload: (v) => ({ reason: v.reason! }) },
    create: { key: "create", title: "Create new collaboration", intro: `A new opportunity linked to ${data.handle}. It needs fresh commission-only terms and approval; the earlier acceptance, fee and rights are not copied.`, submit: "Propose new collaboration", actionKind: "createCollaboration", notes: ["Suppression is preserved. Nothing is offered until the new terms are approved."], fields: [{ key: "reason", label: "Why a new collaboration", kind: "textarea", required: true, initial: "" }], payload: (v) => ({ reason: v.reason! }) },
  };
  // Feedback, revision and rejection act on a submission. With none, they do not exist rather than being disabled copies.
  const contentSpecs: Record<string, Spec> = content ? {
    feedback: { key: "feedback", title: "Queue feedback", intro: `Feedback on ${content.version} of ${content.title.split(" / ")[0]}. It becomes a new approval payload version; a changed message needs a new human decision.`, submit: "Queue feedback", actionKind: "queueFeedback", notes: ["Queued feedback is not a confirmed message. Only a source receipt confirms it was sent."], fields: [{ key: "text", label: "Feedback", kind: "textarea", required: true, initial: content.proposedFeedback }], payload: (v) => ({ text: v.text!, submissionVersion: content.version }) },
    revision: { key: "revision", title: "Request revision", intro: `Targets ${content.version}. ${remaining} revision ${remaining === 1 ? "round remains" : "rounds remain"} under the accepted terms.`, submit: "Request revision", actionKind: "requestRevision", notes: ["This queues an approval-bound request. Only a source receipt confirms delivery to the creator."], blocked: remaining === 0 ? "The agreed revision rounds are used. Another round needs new terms." : null, fields: [{ key: "text", label: "What should change", kind: "textarea", required: true, initial: "", help: "Be specific about the opening, claims or license." }], payload: (v) => ({ text: v.text!, submissionVersion: content.version }) },
    reject: { key: "reject", title: "Reject with reason", intro: `Rejects ${content.version}. The draft and its evidence are kept; nothing is deleted.`, submit: "Request rejection", actionKind: "rejectContent", notes: ["Rejecting doesn't end the collaboration or remove its accepted obligations."], fields: [{ key: "reason", label: "Reason", kind: "textarea", required: true, initial: "" }], payload: (v) => ({ reason: v.reason!, submissionVersion: content.version }) },
  } : {};
  const specs: Record<string, Spec> = { ...baseSpecs, ...contentSpecs };
  const open = (key: string) => { setAck(null); setSpec(specs[key]!); };
  const tabs = contentView
    ? [{ label: "Collaboration", to: `/collaborations/${data.collaborationId}?tab=overview` }, { label: "Content review", to: `/collaborations/${data.collaborationId}?tab=content` }, { label: "Rights", to: `/collaborations/${data.collaborationId}?tab=rights` }, { label: "Payments", to: `/collaborations/${data.collaborationId}?tab=payments` }]
    : [{ label: "Overview", to: `/collaborations/${data.collaborationId}?tab=overview` }, { label: "Brief", to: `/collaborations/${data.collaborationId}?tab=brief` }, { label: "Content", to: `/collaborations/${data.collaborationId}?tab=content` }, { label: "Messages", to: `/collaborations/${data.collaborationId}?tab=messages` }, { label: "Payments", to: `/collaborations/${data.collaborationId}?tab=payments` }];
  const currentLabel = { overview: "Overview", brief: "Brief", content: "Content review", messages: "Messages", payments: "Payments", rights: "Rights" }[tab];

  return (
    <>
      {contentView ? (
        <PageTitle id="collab-title" title="A draft becomes a usable asset." subtitle={`${data.handle} · ${data.ref} · ${content ? `content ${content.version}` : "no content submitted"} · rights and review stay attached to the source`}>
          <SourceButton label="Open original draft" title="Open original draft" width={172} />
          <Button aria-haspopup="dialog" style={{ minWidth: 166 }} disabledReason={content ? null : "Nothing has been submitted to give feedback on."} onClick={() => open("feedback")}>Queue feedback</Button>
        </PageTitle>
      ) : (
        <PageTitle id="collab-title" title="One collaboration. The whole story." subtitle={`${data.ref} · ${data.handle} · ${data.channel} · live creator record in Notion`}>
          <SourceButton label="Open Social Cat" title="Open Social Cat" width={172} />
          <Button aria-haspopup="dialog" style={{ minWidth: 166 }} onClick={() => open("next")}>Queue next action</Button>
        </PageTitle>
      )}
      <div className={creators.row}>
        <SectionTabs label="Collaboration views" gap={12} tabs={tabs.map((t) => ({ ...t, width: 146, current: t.label === currentLabel || (t.label === "Content" && tab === "content") }))} />
        <span className={creators.spacer} style={{ "--spacer": contentView ? "330px" : "210px" } as React.CSSProperties} aria-hidden="true" />
        <Badge tone="violet" width={contentView ? 182 : 116}>{contentView ? (content ? `Draft ${content.version} · in review` : "No submission") : data.stage}</Badge>
      </div>
      <ContextBox title={contentView ? "Existing content and rights obligations" : terms.posting.kind === "voluntary" ? "Existing collaboration · gifted sample, no posting obligation" : "Existing collaboration · accepted historical terms"} text={terms.agreedFee === null ? `${data.ref} is a gifted sample. Its accepted terms commit the creator to no post and no fee, so any content that appears is voluntary and is observed, never chased. New commission-only acquisition does not change it.` : contentView ? `This ${data.ref} review fulfills an earlier accepted agreement. New commission-only acquisition does not erase its revisions, usage limits, fee or settlement obligations.` : `${data.ref} retains its agreed ${formatMoney(terms.agreedFee)} content fee and original obligations. Repeating or recruiting again creates a new commission-only offer, with a fresh assessment and approval.`}>
        <div className={creators.contextActions}>
          <LinkButton variant="secondary" to={`/offers/${DEMO_OFFER_ID}`} style={{ minWidth: 208.5 }}>Current affiliate terms</LinkButton>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
          <Button variant="secondary" aria-haspopup="dialog" onClick={openEvidence}>Saved evidence</Button>
        </div>
      </ContextBox>
      <StaleNotice res={res} />
      {ack && <p className={styles.ack} role="status" data-testid="action-ack">Queued for approval as {ack.payloadVersion}. Nothing has been sent, closed or suppressed; a queued request is not an approved one.</p>}
      {data.requests.length > 0 && (
        <section className={creators.panel} aria-labelledby="queued-title" data-testid="queued-requests">
          <h2 id="queued-title" className={creators.h3}>Requests awaiting approval</h2>
          <ul className={styles.requests}>{data.requests.map((r) => <li key={r.id}>{r.summary} · {r.version} · awaiting approval</li>)}</ul>
          <LinkButton variant="secondary" to="/approvals" style={{ alignSelf: "flex-start" }}>Open approvals</LinkButton>
        </section>
      )}

      {tab === "overview" && <Overview data={data} onOpen={open} onGifted={() => setGifted(true)} />}
      {tab === "content" && (content ? <ContentReview data={data} content={content} onOpen={open} blocker={approvalBlocker(data)} remaining={remaining} /> : <NoSubmission data={data} />)}
      {tab === "rights" && <RightsPanel data={data} />}
      {tab === "brief" && <BriefPanel data={data} />}
      {tab === "messages" && <NoSource title="Messages" text="Provider-scoped message history and pending drafts belong here. Reading never sends. This demo has no message history, and this tab has no Figma source yet." />}
      {tab === "payments" && <NoSource title="Payments" text={terms.agreedFee === null ? `${data.ref} has no agreed fee and no payable. The retained sample cost is an economic cost on record, not a payment owed to the creator. This tab has no Figma source yet.` : `The agreed ${formatMoney(terms.agreedFee)} fee is a historical, accepted liability. It settles in its own record, and no new upfront fee can be created from here. This tab has no Figma source yet.`}>{terms.agreedFee !== null && <LinkButton variant="secondary" to="/finance/payables/demo-payable-1" style={{ alignSelf: "flex-start" }}>Open the payable</LinkButton>}</NoSource>}

      <CommandDialog spec={spec} data={data} version={res.dataVersion} onClose={() => setSpec(null)} onDone={(r) => { setAck(r); setSpec(null); }} />
      <Dialog open={gifted} title="Gifted closure · history" onClose={() => setGifted(false)}>
        <p>Gifted closure is read-only history: a gifted collaboration that ended without content keeps its sample cost, with no automatic clawback. This view can't create a new gifted-only offer.</p>
        <Button variant="secondary" onClick={() => setGifted(false)}>Close</Button>
      </Dialog>
    </>
  );
}

function Overview({ data, onOpen, onGifted }: { data: CollaborationData; onOpen: (k: string) => void; onGifted: () => void }) {
  const { terms, eligibility } = data;
  const timing = postingTiming(terms, data.asOf);
  const sampleCost = terms.posting.kind === "voluntary" ? terms.posting.sampleCost : null;
  return (
    <>
      <div className={creators.pairWide}>
        <section className={creators.panel} aria-labelledby="rel-title" style={{ gap: 20 }}>
          <h2 id="rel-title" className={acquisition.h2}>{data.handle}</h2>
          <p style={{ margin: 0, color: "var(--color-muted)" }}>{timing.obligation === "voluntary" ? "Gifted sample · no posting obligation · any post is voluntary" : `Paid UGC collaboration · 1 original video · ${terms.revisionRounds.used} revision round`}</p>
          <div className={styles.props}>
            <dl className={styles.kvList}>
              <div className={styles.kv}><dt>Channel</dt><dd>{data.channel}</dd></div>
              <div className={styles.kv}><dt>Owner</dt><dd>{data.owner}</dd></div>
              <div className={styles.kv}><dt>Deliverable</dt><dd>{terms.deliverable}</dd></div>
              <div className={styles.kv}><dt>Agreed fee</dt><dd data-testid="agreed-fee">{terms.agreedFee === null ? "None · gifted sample" : `${terms.agreedFee.currency} ${terms.agreedFee.minorUnits / 100}`}</dd></div>
            </dl>
            {timing.obligation === "committed" && terms.posting.kind === "committed" ? (
              <dl className={styles.kvList} data-testid="posting-terms" data-obligation="committed">
                <div className={styles.kv}><dt>Posting due</dt><dd>{longDate(timing.due)} <span data-testid="posting-status" data-phase={timing.phase} title={timing.label}>· {timing.short}</span></dd></div>
                <div className={styles.kv}><dt>Grace period</dt><dd>{terms.posting.graceDays} days</dd></div>
                <div className={styles.kv}><dt>Review after</dt><dd data-testid="review-after">{longDate(timing.reviewAfter)}</dd></div>
                <div className={styles.kv}><dt>Source record</dt><dd>{terms.sourceRecord}</dd></div>
              </dl>
            ) : timing.obligation === "voluntary" ? (
              <dl className={styles.kvList} data-testid="posting-terms" data-obligation="voluntary">
                <div className={styles.kv}><dt>Posting obligation</dt><dd data-testid="posting-obligation">None under the accepted terms</dd></div>
                <div className={styles.kv}><dt>Observation window</dt><dd data-testid="observation-window">Until {longDate(timing.observeUntil)}</dd></div>
                <div className={styles.kv}><dt>Timing status</dt><dd data-testid="posting-status">{timing.label}</dd></div>
                <div className={styles.kv}><dt>Retained sample cost</dt><dd data-testid="sample-cost">{sampleCost ? `${formatMoney(sampleCost)} · retained, no clawback` : "Unknown"}</dd></div>
                <div className={styles.kv}><dt>Source record</dt><dd>{terms.sourceRecord}</dd></div>
              </dl>
            ) : null}
          </div>
          <div className={styles.rule} />
          <h2 className={acquisition.h2} style={{ margin: 0 }}>Relationship timeline</h2>
          <ol className={styles.timeline} data-testid="timeline">
            {data.timeline.map((e) => (
              <li key={e.title} className={styles.event}>
                <Badge tone={EVENT_TONE[e.state]} width={124}>{e.state}</Badge>
                <div className={styles.eventText}><p className={styles.eventTitle}>{e.title}</p><p className={acquisition.small}>{e.note}</p></div>
              </li>
            ))}
          </ol>
        </section>
        <div className={styles.column}>
          <section className={`${creators.panel} ${creators.panelViolet}`} aria-labelledby="next-title">
            {data.content ? (
              <>
                <h2 id="next-title" className={acquisition.h2}>Review draft {data.content.version}</h2>
                <p style={{ margin: 0, font: "var(--text-body)" }}>Check the draft, capture a decision, and queue any feedback for Slack approval.</p>
                <LinkButton to={`/collaborations/${data.collaborationId}?tab=content`} style={{ width: "100%" }}>Open content review</LinkButton>
              </>
            ) : (
              <>
                <h2 id="next-title" className={acquisition.h2}>{timing.phase === "window-ended" ? "Close this collaboration" : "Observe, then close"}</h2>
                <p style={{ margin: 0, font: "var(--text-body)" }} data-testid="observe-branch">No draft has been submitted and none is owed. {timing.phase === "window-ended" ? "The observation window has ended, so this can be closed with its sample cost retained." : "The linked profile is only observed until the window ends; no reminder is sent."}</p>
                <LinkButton to={`/collaborations/${data.collaborationId}?tab=content`} variant="secondary" style={{ width: "100%" }}>See content status</LinkButton>
              </>
            )}
          </section>
          <section className={creators.panel} aria-labelledby="life-title">
            <h2 id="life-title" className={creators.h3}>Keep the lifecycle explicit.</h2>
            <p className={acquisition.small}>Choose an outcome and capture the reason in the source record.</p>
            <Button variant="secondary" aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => onOpen("close")}>Close collaboration</Button>
            <Button variant="secondary" aria-haspopup="dialog" style={{ width: "100%" }} disabledReason={eligibility.suppressed ? "Outreach is already suppressed." : null} onClick={() => onOpen("suppress")}>Suppress outreach</Button>
            <Button variant="ghost" aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => onOpen("create")}>Create new collaboration</Button>
            <p className={acquisition.small}>Outcomes: {data.closureOutcomes.map((o) => o.toLowerCase()).join(" · ")}</p>
            <p className={acquisition.small}>Opt-out blocks future outreach. Reopening a closed collaboration requires an explicit reason; a new brief starts a new collaboration.</p>
          </section>
        </div>
      </div>
      <section className={creators.panel} aria-labelledby="elig-title">
        <h2 id="elig-title" className={acquisition.h2}>Outreach eligibility</h2>
        <dl className={styles.eligibility}>
          <div className={styles.kv} style={{ "--label": "164px" } as React.CSSProperties}><dt>Current eligibility</dt><dd>{eligibility.current}</dd></div>
          <div className={styles.kv} style={{ "--label": "164px" } as React.CSSProperties}><dt>Suppression</dt><dd>{eligibility.suppression}</dd></div>
          <div className={styles.kv} style={{ "--label": "164px" } as React.CSSProperties}><dt>Last decision</dt><dd>{eligibility.lastDecision}</dd></div>
        </dl>
        <p className={acquisition.small}>Closing, suppressing, or reopening changes the Notion creator record. Browser tasks are canceled or paused before another outbound action is allowed.</p>
      </section>
      <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="deal-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="deal-title" className={acquisition.h2}>Close according to the accepted deal.</h2>
          <p className={acquisition.small}>{terms.agreedFee === null ? "The selected collaboration is a gifted sample with no committed post. Closing it keeps the sample cost; content that appears later is voluntary." : `The selected collaboration is a Paid ${formatMoney(terms.agreedFee)} content example; Gifted closure is a separate outcome.`}</p>
        </div>
        <ul className={creators.settle}>
          <li><Badge width={140}>Closed without content</Badge><p className={creators.settleName}>Gifted · no content published</p><p className={acquisition.small}>Retain sample cost; no automatic clawback. Record reliability and suppression</p></li>
          <li><Badge tone="violet" width={140}>Review accepted terms</Badge><p className={creators.settleName}>Paid / Hybrid obligations</p><p className={acquisition.small}>Content fee, rights and commission entitlement stay separate</p></li>
          <li><Badge width={140}>New contract version</Badge><p className={creators.settleName}>Repeat proposed</p><p className={acquisition.small}>Reassess evidence/economics and approve new terms; never reopen immutable paid records</p></li>
        </ul>
        <div className={creators.contextActions} style={{ gap: 16 }}>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 244 }} onClick={onGifted}>Inspect gifted closure</Button>
          <LinkButton variant="secondary" to="/finance/commissions" style={{ minWidth: 218 }}>Commission ledger</LinkButton>
          <LinkButton to={`/offers/${DEMO_OFFER_ID}`} style={{ minWidth: 220 }}>Configure new offer</LinkButton>
        </div>
      </section>
    </>
  );
}

function RightsRegister({ data, withLink }: { data: CollaborationData; withLink: boolean }) {
  if (!data.content) return <NoSubmission data={data} />;
  const blocked = !data.content.licenseSigned;
  return (
    <section className={`${creators.panel} ${creators.panelSubtle}`} aria-labelledby="rights-title" data-testid="rights-register">
      <h2 id="rights-title" className={acquisition.h2}>Use only what is cleared.</h2>
      <dl className={`${styles.kvList} ${styles.loose}`}>
        {data.content.rights.map((r) => <div key={r.key} className={styles.kv} style={{ "--label": "197px" } as React.CSSProperties}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
      </dl>
      {blocked && <Badge tone="warning" width={250}>Usage blocked until cleared</Badge>}
      <p className={acquisition.small}>Expiry pauses reuse and opens a renewal task. Paid usage requires an explicit grant linked to this asset.</p>
      {withLink && <LinkButton variant="secondary" to={`/collaborations/${data.collaborationId}?tab=rights`} style={{ width: "100%" }}>Open rights record</LinkButton>}
    </section>
  );
}

function ContentReview({ data, content, onOpen, blocker, remaining }: { data: CollaborationData; content: NonNullable<CollaborationData["content"]>; onOpen: (k: string) => void; blocker: string | null; remaining: number }) {
  return (
    <>
      <div className={styles.split}>
        <section className={creators.panel} aria-labelledby="art-title" style={{ gap: 20 }}>
          <h2 id="art-title" className={acquisition.h2}>{content.title}</h2>
          <p style={{ margin: 0, color: "var(--color-muted)" }}>One 30–45 second original video · received {content.receivedAt}</p>
          <div className={styles.darkBox}>
            <h2 className={acquisition.h2}>Review the original in Social Cat.</h2>
            <p style={{ font: "var(--text-body)" }}>The video remains in its owning platform. Open the original draft, then save the reviewed version and decision here.</p>
            <SourceButton label="Open draft in Social Cat" title="Open draft in Social Cat" width={320} />
            <p className={acquisition.small}>Source: {data.ref} / draft-{content.version} · receipt pending review</p>
          </div>
          <h3 className={creators.h3} style={{ margin: 0 }}>Review checklist</h3>
          <ul className={styles.criteria} data-testid="checklist">
            {content.checklist.map((c) => (
              <li key={c.label} className={styles.criterion}><span>{c.label}</span><Badge tone={RESULT_TONE[c.result]} width={186}>{c.result}</Badge></li>
            ))}
          </ul>
          <div className={styles.rule} />
          <h3 className={creators.h3} style={{ margin: 0 }}>Revision history</h3>
          <ul className={styles.history}>{content.revisions.map((r) => <li key={r}>{r}</li>)}</ul>
        </section>
        <div className={styles.column}>
          <RightsRegister data={data} withLink />
          <section className={creators.panel} aria-labelledby="decision-title">
            <h2 id="decision-title" className={creators.h3}>Record the next decision.</h2>
            <p style={{ margin: 0, color: "var(--color-muted)" }} id="approve-blocker">{blocker ?? "Applicable obligations, rights and approval authority support acceptance."}</p>
            <Button style={{ width: "100%" }} disabledReason={blocker} reasonFor="approve-blocker">Approve content</Button>
            <Button aria-haspopup="dialog" style={{ width: "100%" }} disabledReason={remaining === 0 ? "The agreed revision rounds are used." : null} onClick={() => onOpen("revision")}>Request revision</Button>
            <Button variant="secondary" aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => onOpen("reject")}>Reject with reason</Button>
            <p className={acquisition.small}>Feedback is drafted first. Any creator-facing message enters the Slack approval queue before the browser agent sends it.</p>
          </section>
        </div>
      </div>
      <section className={creators.panel} aria-labelledby="fb-title">
        <h2 id="fb-title" className={acquisition.h2}>Proposed feedback</h2>
        <p style={{ margin: 0, font: "var(--text-body)" }} data-testid="proposed-feedback">{content.proposedFeedback}</p>
        <Badge tone="warning" width={182}>Draft only · not sent</Badge>
        <p className={acquisition.small}>Queue feedback creates a new approval payload version. A changed message requires a new human decision.</p>
      </section>
    </>
  );
}

function RightsPanel({ data }: { data: CollaborationData }) {
  return (
    <>
      <RightsRegister data={data} withLink={false} />
      <p className={acquisition.small}>This tab has no Figma source yet; it shows the same register as content review.</p>
    </>
  );
}

function BriefPanel({ data }: { data: CollaborationData }) {
  const { terms } = data;
  return (
    <section className={creators.panel} aria-labelledby="brief-title">
      <h2 id="brief-title" className={acquisition.h2}>Brief and accepted terms</h2>
      <dl className={styles.kvList}>
        <div className={styles.kv}><dt>Deliverable</dt><dd>{terms.deliverable}</dd></div>
        <div className={styles.kv}><dt>Agreed fee</dt><dd>{terms.agreedFee === null ? "None · gifted sample" : `${formatMoney(terms.agreedFee)} · historical, read-only`}</dd></div>
        <div className={styles.kv}><dt>Posting</dt><dd>{terms.posting.kind === "committed" ? `Due ${longDate(terms.posting.due)}` : "Not required · a post would be voluntary"}</dd></div>
        <div className={styles.kv}><dt>Revision rounds</dt><dd>{terms.revisionRounds.used} of {terms.revisionRounds.allowed} used</dd></div>
      </dl>
      <p className={acquisition.small}>Approved brief accepted in Social Cat. This tab has no Figma source yet, and a brief here can't create a new fee.</p>
      <LinkButton variant="secondary" to={assessmentPath()} style={{ alignSelf: "flex-start" }}>Prior content score</LinkButton>
    </section>
  );
}

/** A voluntary collaboration may never produce content. That is a branch of the deal, not a failed or missing review. */
function NoSubmission({ data }: { data: CollaborationData }) {
  const timing = postingTiming(data.terms, data.asOf);
  return (
    <section className={creators.panel} aria-labelledby="nosub-title" data-testid="no-submission">
      <h2 id="nosub-title" className={acquisition.h2}>No content submitted</h2>
      <p className={acquisition.small}>{timing.obligation === "voluntary" ? "The accepted terms ask for no post, so there is no draft to review, no revision round and no usage license to chase. Rights and reuse actions apply only if content appears." : "Nothing has been submitted yet."}</p>
      <p className={acquisition.small}>{timing.label}</p>
    </section>
  );
}

function NoSource({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <section className={creators.panel} aria-labelledby="nosrc-title">
      <h2 id="nosrc-title" className={acquisition.h2}>{title}</h2>
      <p className={acquisition.small}>{text}</p>
      {children}
    </section>
  );
}

function CommandDialog({ spec, data, version, onClose, onDone }: { spec: Spec | null; data: CollaborationData; version: string; onClose: () => void; onDone: (r: ActionResponse) => void }) {
  return (
    <Dialog open={spec !== null} title={spec?.title ?? ""} onClose={onClose}>
      {spec && <CommandForm key={spec.key} spec={spec} data={data} version={version} onClose={onClose} onDone={onDone} />}
    </Dialog>
  );
}

function CommandForm({ spec, data, version, onClose, onDone }: { spec: Spec; data: CollaborationData; version: string; onClose: () => void; onDone: (r: ActionResponse) => void }) {
  const action = useAction<CommandPayload>();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.key, f.initial ?? ""])));
  const [attempted, setAttempted] = useState(false);
  const missing = spec.fields.filter((f) => f.required && !(values[f.key] ?? "").trim());
  const submit = () => {
    setAttempted(true);
    if (missing.length > 0 || spec.blocked) return;
    action.mutate({ operation: "requestApproval", actionKind: spec.actionKind, entityRefs: [], expectedVersion: version, approvalRef: null, manifestRef: null, payload: { collaborationId: data.collaborationId, ...spec.payload(values) } }, { onSuccess: onDone });
  };
  return (
    <>
      <div className={styles.form}>
        <p>{spec.intro}</p>
        {spec.list && <><p style={{ font: "var(--text-label)" }}>{spec.list.title}</p><ul>{spec.list.items.map((i) => <li key={i}>{i}</li>)}</ul></>}
        {spec.fields.map((f) => {
          const error = attempted && missing.includes(f) ? `${f.label} is required.` : null;
          return f.kind === "select"
            ? <SelectField key={f.key} label={f.label} helpText={f.help} error={error} value={values[f.key] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} options={f.options ?? []} />
            : <TextField key={f.key} label={f.label} helpText={f.help} error={error} multiline={f.kind === "textarea"} rows={4} value={values[f.key] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />;
        })}
        <ul>{spec.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        {action.error && <ActionError error={action.error} />}
        {spec.blocked && <p role="alert">{spec.blocked}</p>}
      </div>
      <Button loading={action.isPending} disabledReason={spec.blocked ?? null} onClick={submit}>{spec.submit}</Button>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
    </>
  );
}
