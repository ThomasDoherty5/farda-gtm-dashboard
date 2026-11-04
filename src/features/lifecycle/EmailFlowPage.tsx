import { useState } from "react";
import { AdapterError } from "@/adapter/errors";
import { useScope } from "@/adapter/scope";
import { useSave } from "@/adapter/useSave";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Field, SelectField, TextField } from "@/components/Field";
import { ContextLine, Page, PageHeader, Small, kit } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { ActionError, blockedReason, LeaveGuard } from "@/features/approvals/shared";
import { InfoDialog } from "@/features/settings/shared";
import { TIMING_OPTIONS, type EmailFlowData, type FlowKey } from "@/fixtures/lifecycle";
import { validateFlowDraft, type FlowDraft } from "./flowDraft";
import { FlowSteps, LockedPolicies } from "./shared";
import styles from "./Lifecycle.module.css";

const SOURCE: Record<Exclude<FlowKey, "setup">, string> = { "early-access": "11:372", "abandoned-checkout": "11:498", "review-request": "11:624" };
const TITLES: Record<Exclude<FlowKey, "setup">, string> = { "early-access": "A welcome that leads to launch.", "abandoned-checkout": "Recover intent, without over-sending.", "review-request": "Ask after the product arrives." };

/**
 * Early access, abandoned checkout and review request flows (Figma 11:372, 11:498, 11:624, owner THO-304). The draft is versioned and
 * saving it never enables a flow or sends anything. The three consent, suppression and duplicate policies are locked: the server enforces them.
 */
export function EmailFlowPage({ flow }: { flow: Exclude<FlowKey, "setup"> }) {
  const { adapter } = useScope();
  const query = useView<{ flow: string }, EmailFlowData>("emailFlow", { flow });
  const data = query.data?.data ?? null;
  const demo = adapter.kind === "demo";
  // `edit` is null until the user changes something. A draft that differs from the server's is kept, even when the server moves on.
  const [edit, setEdit] = useState<FlowDraft | null>(null);
  const [dialog, setDialog] = useState<"provider" | "preview" | null>(null);
  const [shown, setShown] = useState(false);
  const save = useSave<FlowDraft, FlowDraft>();
  const dirty = data !== null && edit !== null && JSON.stringify(edit) !== JSON.stringify(data.draft);
  const draft = dirty ? edit : data?.draft ?? null;
  const serverErrors = save.error instanceof AdapterError ? save.error.body.fieldErrors ?? {} : {};
  const errors = { ...serverErrors, ...(shown && draft ? validateFlowDraft(flow, draft) : {}) };
  const blocked = query.data ? blockedReason(query.data, "saveFlowDraft") : "Available once the flow has loaded.";
  const noChange = save.data?.reasonCodes.includes("NO_CHANGE");

  const onSave = () => {
    setShown(true);
    if (!data || !draft || Object.keys(validateFlowDraft(flow, draft)).length) return;
    save.mutate({ resourceKind: "configurationDraft", resourceRef: `flow-${flow}`, expectedVersion: data.draftVersion, payload: draft });
  };

  return (
    <Page labelledBy="flow-title" source={SOURCE[flow]}>
      <LeaveGuard dirty={dirty && !save.isPending} />
      <PageHeader id="flow-title" title={data?.title ?? TITLES[flow]} subtitle={data?.subtitle ?? "The flow configuration."}>
        <LinkButton variant="secondary" to="/customers/lifecycle" style={{ minWidth: 184 }}>Back to lifecycle</LinkButton>
        <Button style={{ minWidth: 160 }} loading={save.isPending} disabledReason={blocked} onClick={onSave}>Save draft</Button>
      </PageHeader>
      <ReadState res={query.data} subject="This email flow" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading the flow…" />}
      {query.isError && <ViewError error={query.error} subject="This email flow" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data && draft ? (
        <>
          <ContextLine badge={data.context.badge} width={180} trailing={<button type="button" className={styles.inlineLink} aria-haspopup="dialog" onClick={() => setDialog("preview")}>Preview template</button>}>{data.context.text}</ContextLine>
          {(save.data || data.draftVersion !== "v1") && (
            <p role="status" className={kit.status} data-testid="save-status">
              {noChange ? "Nothing to save: the draft matches version " : "Saved as version "}{data.draftVersion.replace("v", "")}. A saved draft doesn't enable the flow, publish it or send anything.
            </p>
          )}
          {save.error && !Object.keys(serverErrors).length && <ActionError error={save.error} />}
          <Body data={data} draft={draft} errors={errors} setDraft={setEdit} openProvider={() => setDialog("provider")} />
          <Small>{data.footnote}</Small>
          <InfoDialog open={dialog === "provider"} title="Provider setup" demo={demo} onClose={() => setDialog(null)}>
            <p>No email provider is selected. The provider owns contact records, consent, suppression and delivery, and an automation owner sets this flow up there.</p>
            <p>Nothing is connected, configured or sent from here. Enabling stays blocked until a provider is connected and the checks above pass.</p>
          </InfoDialog>
          <InfoDialog open={dialog === "preview"} title="Template preview" demo={demo} onClose={() => setDialog(null)}>
            <div className={styles.synthetic} data-testid="template-preview">
              <p><strong>Subject:</strong> {data.preview.subject}</p>
              {data.preview.body.map((line) => <p key={line}>{line}</p>)}
            </div>
            <p>Synthetic content for the saved template "{data.draft.template}". Variables are shown as placeholders, no recipient exists, and this can't be sent.</p>
          </InfoDialog>
        </>
      ) : (
        <EmptyState state="Empty" title="No flow yet"><p>The source responded, but this flow is not configured.</p></EmptyState>
      ))}
    </Page>
  );
}

function Body({ data, draft, errors, setDraft, openProvider }: { data: EmailFlowData; draft: FlowDraft; errors: Record<string, string>; setDraft: (d: FlowDraft) => void; openProvider: () => void }) {
  return (
    <>
      <div className={styles.split832}>
        <section className={`${kit.card}`} aria-labelledby="steps-title" data-testid="flow-steps">
          <h2 id="steps-title" className={kit.heading2}>Every entry has a defined exit</h2>
          <FlowSteps steps={data.steps} />
        </section>
        <section className={`${kit.card} ${kit.cardLarge}`} aria-labelledby="settings-title" data-testid="flow-settings">
          <h2 id="settings-title" className={kit.heading2}>Flow settings</h2>
          <Field label="Entry event" helpText={data.entryEvent.help}>
            {(props) => <input {...props} type="text" readOnly aria-readonly="true" value={data.entryEvent.value} />}
          </Field>
          <SelectField label="Timing" value={draft.timing} onChange={(v) => setDraft({ ...draft, timing: v })} error={errors.timing ?? null} helpText={data.timing.help} options={TIMING_OPTIONS[data.key].map((t) => ({ value: t, label: t }))} />
          <TextField label="Message template" value={draft.template} onChange={(v) => setDraft({ ...draft, template: v })} error={errors.template ?? null} helpText={data.template.help} />
          <LockedPolicies />
          <Button variant="secondary" aria-haspopup="dialog" onClick={openProvider}>Review provider setup</Button>
        </section>
      </div>

      <section className={`${kit.card} ${kit.cardLarge}`} aria-labelledby="tests-title" data-testid="tests">
        <h2 id="tests-title" className={kit.heading2}>Test before enabling</h2>
        <ul className={styles.tests}>
          {data.tests.map((t) => (
            <li key={t.title} className={styles.test}>
              <p>{t.title}</p>
              <Badge width={240}>{t.result}</Badge>
            </li>
          ))}
        </ul>
        <Small>Required evidence: eligible delivery, unsubscribe behavior, suppression and duplicate protection. Enabling stays blocked until these checks pass. The results above are the outcomes expected; no sandbox test has been run.</Small>
      </section>
    </>
  );
}
