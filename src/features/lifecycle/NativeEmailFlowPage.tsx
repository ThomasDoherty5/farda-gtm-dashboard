import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useSearchParams } from "react-router-dom";
import { scopeKey, useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { useSave } from "@/adapter/useSave";
import { AdapterError } from "@/adapter/errors";
import type { ReadResponse } from "@/adapter/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Field, SelectField, TextField } from "@/components/Field";
import { DetailRows, Page, PageHeader, Panel, Small, kit } from "@/components/PageKit";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { InfoDialog } from "@/features/settings/shared";
import { draftPayloadSchema, type FlowDraft, type FlowKey, type NativeEmailFlow, type SaveReceipt } from "@/creator-agent/lifecycle/contract";
import { CatalogSteps, CohortDetails, NativeLockedPolicies, ProviderDialog, ReadFeedback, SourceContext, countText } from "./nativeShared";
import { matchesDraftAck, prepareDraft, recoverDraft, sameDraft, type PendingDraft } from "./draftRecovery";
import styles from "./Lifecycle.module.css";

type EditableFlow = Exclude<FlowKey, "setup">;
const sources = { "early-access": "11:372", "abandoned-checkout": "11:498", "review-request": "11:624" };
const titles = { "early-access": "A welcome that leads to launch.", "abandoned-checkout": "Recover intent, without over-sending.", "review-request": "Ask after the product arrives." };
const validKey = (s: string | null) => s !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

export function NativeEmailFlowPage({ flow }: { flow: EditableFlow }) {
  const ctx = useScope(), client = useQueryClient(), [search, setSearch] = useSearchParams();
  const pendingKey = [...scopeKey(ctx), "lifecycle-draft-pending", flow];
  // Protected memory only. It survives in-app navigation, is removed on scope denial, and is never serialized to browser storage.
  const held = useQuery<PendingDraft | null>({ queryKey: pendingKey, queryFn: () => null, enabled: false, initialData: null, gcTime: Infinity });
  const urlKey = search.get("draftRequestKey"), requestKey = held.data?.requestKey ?? (validKey(urlKey) ? urlKey : null);
  const query = useView<{ flow: string; draftRequestKey?: string }, NativeEmailFlow>("emailFlow", { flow, ...(requestKey ? { draftRequestKey: requestKey } : {}) }, null, { keepPrevious: true });
  const data = query.data?.data ?? null;
  function remember(pending: PendingDraft | null) {
    client.setQueryData(pendingKey, pending);
    setSearch(prior => { const next = new URLSearchParams(prior); if (pending) next.set("draftRequestKey", pending.requestKey); else next.delete("draftRequestKey"); return next; }, { replace: true });
  }
  return <Page labelledBy="flow-title" source={sources[flow]}>
    <ReadFeedback query={query} subject="This email flow" />
    {data ? <NativeFlowEditor key={JSON.stringify([...scopeKey(ctx), flow, data.actorRef])} flow={flow} data={data} response={query.data!}
      requestKey={requestKey} invalidKey={urlKey !== null && !validKey(urlKey)} pending={held.data ?? null} remember={remember} refresh={() => void query.refetch()} />
      : <PageHeader id="flow-title" title={titles[flow]} subtitle="Read source policy and save a local configuration proposal."><LinkButton variant="secondary" to="/customers/lifecycle">Back to lifecycle</LinkButton></PageHeader>}
  </Page>;
}

function initialDraft(data: NativeEmailFlow): FlowDraft | null {
  if (data.draft) return data.draft.payload;
  const c = data.sourceConfig, event = c?.entryEvents[0], timing = c?.timingRules.find(t => t.entryEventRef === event?.ref), template = c?.templates[0];
  return event && timing && template ? { entryEventRef: event.ref, timingRuleRef: timing.ref, timezone: timing.timezone, templateRef: template.ref, templateVersion: template.version, templateName: template.label } : null;
}

function FlowLeaveGuard({ dirty, uncertain }: { dirty: boolean; uncertain: boolean }) {
  const comparable = (location: { pathname: string; search: string }) => { const s = new URLSearchParams(location.search); s.delete("draftRequestKey"); return location.pathname + s.toString(); };
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (dirty || uncertain) && comparable(currentLocation) !== comparable(nextLocation));
  useEffect(() => { if (!dirty && !uncertain) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty, uncertain]);
  return <Dialog open={blocker.state === "blocked"} title={uncertain ? "Check this save before leaving" : "Discard your edits?"} onClose={() => blocker.reset?.()}>
    <p>{uncertain ? "This request has no terminal acknowledgment. Keep the original request key and check its result before starting another edit." : "This flow has unsaved local edits."}</p>
    <Button onClick={() => blocker.reset?.()}>Keep editing</Button>{!uncertain && <Button variant="secondary" onClick={() => blocker.proceed?.()}>Discard and leave</Button>}
  </Dialog>;
}

function NativeFlowEditor({ flow, data, response, requestKey, invalidKey, pending, remember, refresh }: {
  flow: EditableFlow; data: NativeEmailFlow; response: ReadResponse<NativeEmailFlow>; requestKey: string | null; invalidKey: boolean;
  pending: PendingDraft | null; remember: (p: PendingDraft | null) => void; refresh: () => void;
}) {
  const [edit, setEdit] = useState<{ payload: FlowDraft; baseVersion: string } | null>(null), [dialog, setDialog] = useState<"provider" | "preview" | "events" | "history" | null>(null);
  const [error, setError] = useState<string | null>(null), [preparing, setPreparing] = useState(false), [shown, setShown] = useState(false);
  const scope = { workspaceId: response.scope.workspaceId, accountId: response.scope.accountIds[0] ?? "", environment: "sandbox" as const };
  const scopeId = JSON.stringify(scope);
  const [resolved, setResolved] = useState<Awaited<ReturnType<typeof recoverDraft>>>(null);
  const current = useRef(data), mounted = useRef(true);
  useLayoutEffect(() => { current.current = data; });
  // A different source read, request or pending original withdraws a prior recovery result until it is re-read.
  const [resolvedBasis, setResolvedBasis] = useState([data, requestKey, pending, scopeId] as const);
  if (resolvedBasis[0] !== data || resolvedBasis[1] !== requestKey || resolvedBasis[2] !== pending || resolvedBasis[3] !== scopeId) { setResolvedBasis([data, requestKey, pending, scopeId]); setResolved(null); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { let active = true; if (requestKey) void recoverDraft(JSON.parse(scopeId) as SaveReceipt["scope"], data, requestKey, pending).then(result => { if (active) setResolved(result); }); return () => { active = false; }; }, [data, requestKey, pending, scopeId]);
  const save = useSave<FlowDraft, SaveReceipt>(), catalog = data.sourceConfig, baseline = initialDraft(data), draft = edit?.payload ?? baseline;
  const effective = resolved?.pending ?? pending, uncertain = Boolean(requestKey && !resolved), dirty = !!edit && (!baseline || !sameDraft(edit.payload, baseline));
  const baseVersion = edit?.baseVersion ?? data.draftVersion, conflict = !!edit && baseVersion !== data.draftVersion;
  const schema = draftPayloadSchema.safeParse(draft), validation = schema.success || !shown ? {} : Object.fromEntries(schema.error.issues.map(i => [i.path[0], i.message]));
  const hold = response.scope.environment !== "sandbox" || response.scope.accountIds.length !== 1 ? "A single verified sandbox account is required for this draft service." : invalidKey ? "The recovery key is invalid. No new save is permitted." : requestKey ? "Finish reconciling the original request before starting another edit." :
    blockedReason(response, "saveFlowDraft") ?? (data.saveHoldReasons.join("; ") || null);
  const locked = !!requestKey || preparing || save.isPending || Boolean(hold);
  const selectedTemplate = catalog?.templates.find(t => t.ref === draft?.templateRef && t.version === draft?.templateVersion);
  const selectedTiming = catalog?.timingRules.find(t => t.ref === draft?.timingRuleRef);
  const update = (payload: FlowDraft) => { setEdit({ payload, baseVersion }); setShown(false); setError(null); };

  async function submit(original?: PendingDraft) {
    setShown(true); setError(null);
    if (!original && (hold || !draft || !schema.success || conflict)) return;
    setPreparing(true);
    try {
      const basis = current.current;
      const intent = original ?? await prepareDraft(scope, data.actorRef, `flow-${flow}`, baseVersion, schema.success ? schema.data : draft!);
      if (!mounted.current) return;
      if (current.current.actorRef !== intent.actorRef || !original && (current.current.draftVersion !== basis.draftVersion || current.current.sourceVersion !== basis.sourceVersion)) { setError("The source changed while preparing this draft. Reload and review its current version."); return; }
      remember(intent);
      save.mutate({ resourceKind: "configurationDraft", resourceRef: intent.resourceRef, expectedVersion: intent.expectedVersion, payload: intent.payload, idempotencyKey: intent.requestKey }, {
        onSuccess: ack => { if (!mounted.current) return; if (!matchesDraftAck(ack, intent)) setError("The acknowledgment did not match the exact request. Save outcome is unknown; check the original request."); else { setError(null); setResolved({ state: "recorded", pending: intent, receipt: ack.record }); } refresh(); },
        onError: () => { if (mounted.current) { setError("The request needs an authoritative result. A failed read or absent lookup does not authorize a new request."); refresh(); } },
      });
    } catch { if (mounted.current) setError("The draft could not be prepared. No new request was submitted."); }
    finally { if (mounted.current) setPreparing(false); }
  }
  function continueEditing() {
    if (!resolved) return;
    // Keep a rejected payload for correction; the recorded receipt is historical even if another revision has since superseded it.
    setEdit(resolved.state === "rejected" ? { payload: resolved.pending.payload, baseVersion: data.draftVersion } : null);
    remember(null); setResolved(null); setError(null); save.reset(); refresh();
  }
  return <><FlowLeaveGuard dirty={dirty} uncertain={uncertain} />
    <PageHeader id="flow-title" title={titles[flow]} subtitle="Read source policy and save a local configuration proposal.">
      <LinkButton variant="secondary" to="/customers/lifecycle" style={{ minWidth: 184 }}>Back to lifecycle</LinkButton>
      <Button style={{ minWidth: 160 }} loading={preparing || save.isPending} disabledReason={hold ?? (conflict ? "Review the newer draft version before saving." : !draft ? "No source configuration catalog." : null)} onClick={() => void submit()}>Save draft</Button>
    </PageHeader><SourceContext data={data} />
    <div className={kit.row}><button type="button" className={styles.inlineLink} aria-haspopup="dialog" onClick={() => setDialog("preview")}>Preview template</button><button type="button" className={styles.inlineLink} aria-haspopup="dialog" onClick={() => setDialog("events")}>Event handling</button><button type="button" className={styles.inlineLink} aria-haspopup="dialog" onClick={() => setDialog("history")}>Draft history</button></div>
    {requestKey && <Panel title={resolved?.state === "recorded" ? "Draft persistence confirmed" : resolved?.state === "rejected" ? "Original request rejected" : "Save outcome needs readback"} headingId="draft-result-title">
      {resolved?.receipt ? <p role="status">Saved local revision {resolved.receipt.record.revision}, {resolved.receipt.persistedAt}. This exact request was recorded; publication, activation and delivery were not changed.</p>
        : <p role="status">{resolved ? "The server recorded a terminal no-op for this exact original request. You can correct its draft." : "Keep the original request key. An absent record or failed read is not a terminal result."}</p>}
      <Button variant="secondary" onClick={refresh}>Check original request</Button>
      {resolved ? <Button onClick={continueEditing}>Continue editing</Button> : <Button disabledReason={!effective ? "The original payload is unavailable after reload. Keep checking its exact scoped request; a new key would risk a duplicate." : save.isPending ? "The original request is still pending." : null} onClick={() => effective && void submit(effective)}>Retry original request</Button>}
    </Panel>}
    {error && <p role="alert" className={kit.status}>{error}</p>}{save.error && <ActionError error={save.error} />}
    {invalidKey && <p role="alert">Invalid recovery key. No new request can be created from this URL.</p>}
    {conflict && !requestKey && <Panel title="A newer draft exists" headingId="draft-conflict-title"><p>Your edits retain their original version. Review the current source and local history before rebasing.</p><Button variant="secondary" onClick={() => draft && setEdit({ payload: draft, baseVersion: data.draftVersion })}>Rebase edits onto current version</Button></Panel>}
    {data.draft && !requestKey && <Small>Stored local revision {data.draft.revision}. {data.currentSourceMatch ? "Its catalog basis matches the current source." : "Its source basis is no longer current; review before reuse."} No provider action follows from this record.</Small>}
    <div className={styles.split832}><section className={kit.card} aria-labelledby="steps-title"><h2 id="steps-title" className={kit.heading2}>Every entry has a defined exit</h2><CatalogSteps catalog={catalog} /></section>
      <Panel title="Flow settings" headingId="settings-title" large>
        {draft && catalog ? <>
          {catalog.entryEvents.length === 1 ? <Field label="Entry event" helpText={`${catalog.entryEvents[0]!.trigger} · ${catalog.entryEvents[0]!.version} · ${catalog.purpose}`}>{props => <input {...props} readOnly aria-readonly="true" value={catalog.entryEvents.find(e => e.ref === draft.entryEventRef)?.label ?? "Stored entry event unavailable"} />}</Field>
            : <SelectField label="Entry event" disabled={locked} value={draft.entryEventRef} options={catalog.entryEvents.map(e => ({ value: e.ref, label: e.label }))} onChange={value => { const timing = catalog.timingRules.find(t => t.entryEventRef === value); if (timing) update({ ...draft, entryEventRef: value, timingRuleRef: timing.ref, timezone: timing.timezone }); }} />}
          <SelectField label="Timing" disabled={locked} value={draft.timingRuleRef} options={catalog.timingRules.filter(t => t.entryEventRef === draft.entryEventRef).map(t => ({ value: t.ref, label: `${t.label} · ${t.approval}` }))} error={validation.timingRuleRef} helpText={selectedTiming ? `${selectedTiming.timezone} · ${selectedTiming.version}; ${selectedTiming.launchAt ? `launch ${selectedTiming.launchAt}` : selectedTiming.delayMinutes !== null ? `${selectedTiming.delayMinutes} minutes after the qualified event` : "exact delay / launch date not supplied"}` : "The stored timing is absent from the current catalog."} onChange={value => { const t = catalog.timingRules.find(t => t.ref === value); if (t) update({ ...draft, timingRuleRef: value, timezone: t.timezone }); }} />
          <SelectField label="Message template" disabled={locked} value={draft.templateRef} options={catalog.templates.map(t => ({ value: t.ref, label: `${t.label} · ${t.version} · ${t.approval}` }))} helpText={selectedTemplate ? `Claim policy ${selectedTemplate.claimPolicyVersion}. Allowed variables: ${selectedTemplate.allowedVariables.join(", ") || "none"}.` : "The stored template version is absent from the current catalog."} onChange={value => { const t = catalog.templates.find(t => t.ref === value); if (t) update({ ...draft, templateRef: t.ref, templateVersion: t.version, templateName: t.label }); }} />
          <TextField label="Local draft title" disabled={locked} value={draft.templateName} onChange={v => update({ ...draft, templateName: v })} error={validation.templateName ?? (save.error instanceof AdapterError ? save.error.body.fieldErrors?.templateName : null)} helpText="A local label, not template copy or publication approval." />
        </> : <Small>No permitted source catalog is available. Entry event, timing and template are unknown; saving stays held.</Small>}
        <NativeLockedPolicies /><Button variant="secondary" aria-haspopup="dialog" onClick={() => setDialog("provider")}>Review provider setup</Button>
      </Panel></div>
    <Panel title="Test before enabling" headingId="tests-title" large><ul className={styles.tests}>{["eligible-delivery", "unsubscribe", "suppression", "deduplication"].map(kind => {
      const evidence = catalog?.evidence.find(e => e.kind === kind), b = evidence?.basis;
      const matches = !!draft && !!b && b.catalogVersion === catalog?.catalogVersion && b.policyVersion === catalog?.policyVersion && b.entryEventRef === draft.entryEventRef && b.timingRuleRef === draft.timingRuleRef && b.templateRef === draft.templateRef && b.templateVersion === draft.templateVersion;
      return <li key={kind} className={styles.test}><p>{kind}</p><Badge>{evidence && matches ? evidence.state : "Evidence unknown"}</Badge><Small>{evidence && matches ? evidence.receipt ?? evidence.missingReason : "No exact selected-version test receipt."}</Small></li>;
    })}</ul><Small>Test receipts are source observations. This screen cannot run a live test, publish, enable or send. Changing the selected basis invalidates matching readiness.</Small></Panel>
    <ProviderDialog open={dialog === "provider"} onClose={() => setDialog(null)} data={data} />
    <InfoDialog open={dialog === "preview"} title="Template preview" demo={false} onClose={() => setDialog(null)}>
      {selectedTemplate?.preview ? <><p>{selectedTemplate.preview.kind === "synthetic" ? "Synthetic preview" : "Approved generic preview"} · {selectedTemplate.label} · {selectedTemplate.version}</p><div className={styles.synthetic}><p><strong>Subject:</strong> {selectedTemplate.preview.subject}</p>{selectedTemplate.preview.lines.map((line, i) => <p key={i}>{line}</p>)}</div><p>No recipient exists here. This preview cannot be sent.</p></>
        : <p>No permitted generic preview is available for the exact selected template version.</p>}
    </InfoDialog>
    <InfoDialog open={dialog === "events"} title="How events are handled" demo={false} onClose={() => setDialog(null)}>
      <p>Eligibility and cancellation come from the exact source catalog. Missing, delayed or replayed events are held or reconciled by the execution owner; a local draft cannot prove a send.</p>
      <DetailRows rows={[["Eligibility", catalog?.eligibilityRules.join("; ") || "Unknown"], ["Cancellation", catalog?.cancellationRules.join("; ") || "Unknown"], ["Recovery owner", catalog?.recoveryOwner ?? "Not supplied"]]} />
      <DataTable caption="Source-owned flow outcomes" columns={[{ label: "STATE" }, { label: "COUNT" }, { label: "RECEIPT / REASON" }]} minWidth={520} rows={catalog?.outcomes?.rows.map(r => [r.state, countText(r.count), r.receipt ?? r.count.missingReason ?? r.reasonCode ?? "Unknown"]) ?? [["Unknown", "Unknown", "No source outcome snapshot."]]} /><CohortDetails cohort={catalog?.outcomes?.cohort ?? null} />
    </InfoDialog>
    <InfoDialog open={dialog === "history"} title="Local draft history" demo={false} onClose={() => setDialog(null)}>
      <p>{data.history.total} immutable local revisions. {data.history.truncated ? "Only the latest 20 are shown; this is not the complete history." : "All recorded revisions are shown."}</p>
      <DataTable caption="Immutable draft revisions" columns={[{ label: "REVISION" }, { label: "SAVED" }, { label: "LOCAL TITLE / BASIS" }]} minWidth={520} rows={data.history.rows.map(r => [String(r.revision), `${r.savedAt} · ${r.savedBy}`, `${r.payload.templateName} · ${r.catalogVersion} · ${r.policyVersion}`])} />
    </InfoDialog>
  </>;
}
