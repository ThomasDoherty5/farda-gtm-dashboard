import { useState } from "react";
import { Button, LinkButton } from "@/components/Button";
import { Page, PageHeader, Small } from "@/components/PageKit";
import { LoadingBones, StatePanel, stateStyles } from "@/components/StatePanel";
import { InfoDialog } from "@/features/settings/shared";
import styles from "./StateGallery.module.css";

type Example = "clear-filters" | "take-over";

/**
 * Recovery state gallery (Figma source 12:534, owner THO-306). A development reference only: every card is an example of a pattern
 * the real screens use, with the next step it must offer. No state here is real, and no control changes anything.
 */
export function StateGalleryPage() {
  const [example, setExample] = useState<Example | null>(null);
  const [kept, setKept] = useState(false);
  const close = () => setExample(null);
  const open = (e: Example) => ({ "aria-haspopup": "dialog" as const, onClick: () => setExample(e) });

  return (
    <Page labelledBy="states-title" source="12:534">
      <PageHeader id="states-title" title="Every state has a next step" subtitle="Implementation states · consistent feedback, safe recovery, clear ownership." />

      <div className={styles.row}>
        <StatePanel badge="Loading" title="Loading your orders" testId="state-loading" busy actions={<><LoadingBones /><span id="loading-status" role="status" className="visually-hidden">Loading your orders</span><Button disabledReason="Loading your orders" reasonFor="loading-status" style={{ minWidth: 184 }}>Loading…</Button></>}>
          Keep structure stable while data loads. Announce loading once; do not show stale zeros.
        </StatePanel>
        <StatePanel badge="First use" tone="violet" title="Connect your operations" testId="state-first-use" actions={<LinkButton to="/settings/connections" style={{ minWidth: 184 }}>Open connections</LinkButton>}>
          No source data yet. Connect the warehouse, then verify the first successful sync.
        </StatePanel>
        <StatePanel badge="No results" title="No orders match these filters" testId="state-no-results" actions={<Button variant="secondary" style={{ minWidth: 184 }} {...open("clear-filters")}>Clear filters</Button>}>
          Keep the active filters visible. Clearing filters restores the full queue.
        </StatePanel>
      </div>

      <div className={styles.row}>
        <StatePanel badge="Refresh failed" tone="danger" title="Couldn’t refresh the warehouse" testId="state-refresh-failed" actions={<LinkButton variant="secondary" to="/runs/demo-run-uncertain" style={{ minWidth: 184 }}>View failed run</LinkButton>}>
          Last successful data is preserved. Error code <span style={{ whiteSpace: "nowrap" }}>SYNC-013</span> and run ID are available in details.
        </StatePanel>
        <StatePanel badge="Stale data" tone="warning" title="These numbers may be out of date" testId="state-stale" actions={<LinkButton variant="secondary" to="/settings/connections" style={{ minWidth: 184 }}>Open source health</LinkButton>}>
          Show the last success and source timestamp. Unknown is never presented as healthy.
        </StatePanel>
        <StatePanel badge="Access denied" tone="warning" title="This action needs a founder" testId="state-denied" actions={<LinkButton variant="secondary" to="/approvals/demo-approval-founder" style={{ minWidth: 204 }}>View approval request</LinkButton>}>
          Pay approvals require a founder. Viewing the request does not authorize a payment.
        </StatePanel>
      </div>

      <div className={styles.row}>
        <StatePanel badge="Source changed" tone="warning" title="The source record changed" testId="state-conflict" actions={<LinkButton to="/approvals/demo-approval-conflict" style={{ minWidth: 196 }}>Reload source record</LinkButton>}>
          Refresh the record, compare the approved revision, and request approval again if content changed.
        </StatePanel>
        <StatePanel
          badge="Uncertain outcome"
          tone="danger"
          title="Confirm the send before retrying"
          testId="state-uncertain"
          bodyId="uncertain-reason"
          actions={
            <>
              <Button variant="primary" disabledReason="Retry stays off until the outcome is reconciled with source evidence." reasonFor="uncertain-reason" style={{ minWidth: 184 }} className={styles.retry}>Retry disabled</Button>
              <LinkButton to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: 188 }}>Reconcile in source</LinkButton>
            </>
          }
        >
          The browser lost confirmation after Send. Reconcile source evidence; a duplicate send is possible.
        </StatePanel>
        <StatePanel badge="Sign-in required" tone="warning" title="Browser paused for sign-in" testId="state-signin" actions={<Button style={{ minWidth: 184 }} {...open("take-over")}>Take over browser</Button>}>
          The user completes login or MFA in the source session. Never paste credentials into this UI.
        </StatePanel>
      </div>

      <div className={styles.row}>
        <StatePanel
          badge="Confirmation"
          title="Cancel this queued task?"
          testId="state-confirm"
          actions={
            <>
              <Button variant="secondary" style={{ minWidth: 184 }} onClick={() => setKept(true)}>Keep task</Button>
              {kept && <p role="status" className={stateStyles.status} data-testid="kept-status">Task kept. Nothing was canceled, and your edits are unchanged.</p>}
            </>
          }
        >
          Cancellation stops future execution. An already submitted action must still be reconciled.
        </StatePanel>
        <StatePanel badge="Success" tone="success" title="Action confirmed in source" testId="state-success" actions={<LinkButton variant="secondary" to="/runs/demo-run-approval?tab=approval" style={{ minWidth: 184 }}>View receipt</LinkButton>}>
          Receipt TEST-ACT-018 · Social Cat · message confirmed · approval revision 3.
        </StatePanel>
        <StatePanel badge="Validation" tone="danger" title="Choose a valid launch date" testId="state-validation" actions={<LinkButton variant="secondary" to="/launch?view=control" style={{ minWidth: 184 }}>Review launch plan</LinkButton>}>
          The launch date must follow readiness review. Show an inline error and preserve the entered value.
        </StatePanel>
      </div>
      <Small>Development reference · these are examples of patterns, not live states. No control here changes any record.</Small>

      <InfoDialog open={example === "clear-filters"} title="Clear filters" demo onClose={close}>
        <p>In a real screen this resets the filters to their documented defaults, restores the full list and keeps the active scope. Here there are no filters, so nothing changes.</p>
      </InfoDialog>
      <InfoDialog open={example === "take-over"} title="Take over browser" demo onClose={close}>
        <p>In a real run the person signs in inside the source session. No password, code or session is ever entered or stored in this app, and a takeover needs a server-confirmed assignment. Here there is no session, so nothing happens.</p>
      </InfoDialog>
    </Page>
  );
}
