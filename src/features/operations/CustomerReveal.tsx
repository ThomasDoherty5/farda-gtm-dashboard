import { useScope } from "@/adapter/scope";
import { useState } from "react";
import type { OrderCustomerData } from "@/adapter/demoOps";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextField } from "@/components/Field";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import styles from "./Operations.module.css";

/**
 * A role-gated, audited look at one order's customer details (FE09-03). Nothing is mirrored by default. The server decides who may reveal,
 * a reason is required, the reveal is logged, and the values are synthetic placeholders in the demo.
 */
export function CustomerReveal({ orderRef }: { orderRef: string }) {
  const { adapter } = useScope();
  return adapter.kind === "demo" ? <DemoCustomerReveal key={orderRef} orderRef={orderRef} /> : <NativeCustomerPrivacy key={orderRef} orderRef={orderRef} />;
}

/** Disclosure requires its own purpose-bound source authority; a coarse read role is never enough. */
function NativeCustomerPrivacy({ orderRef }: { orderRef: string }) {
  const query = useView<{ orderId: string }, { datasetKey: "operations-native"; synthetic: boolean; access: { state: string; reason: string | null } }>("orderCustomer", { orderId: orderRef });
  const [open, setOpen] = useState(false);
  return <>
    <span>No customer details are mirrored</span>{" · "}<button type="button" className={styles.link} style={{ font: "inherit", padding: 0, background: "none", border: 0, cursor: "pointer", textDecoration: "underline" }} aria-haspopup="dialog" onClick={() => setOpen(true)}>Customer details (restricted)</button>
    <Dialog open={open} title="Customer details" badge={query.data?.data?.synthetic ? "Synthetic source evidence" : "Restricted"} onClose={() => setOpen(false)}>
      <p data-testid="customer-denied">Customer details are withheld. A current, purpose-bound disclosure permission and source audit are required; this screen has no authorized reveal action.</p>
      <p role="status">{query.isPending ? "Checking source access…" : query.isError ? "Source access could not be verified. No customer values are displayed." : "Opening this review has not revealed customer details or submitted a disclosure request."}</p>
      <Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh source access</Button><Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
    </Dialog>
  </>;
}

function DemoCustomerReveal({ orderRef }: { orderRef: string }) {
  const query = useView<{ orderId: string }, OrderCustomerData>("orderCustomer", { orderId: orderRef });
  const action = useAction<{ orderRef: string; reason: string }>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const data = query.data?.data ?? null;
  const blocked = query.data ? blockedReason(query.data, "revealCustomerDetails") : "Available once the order has loaded.";
  const fieldError = action.error && "body" in action.error ? ((action.error as { body: { fieldErrors?: Record<string, string> } }).body.fieldErrors ?? {}) : {};
  const submit = () => {
    setShown(true);
    if (reason.trim().length < 10) return;
    action.mutate({ operation: "controlRun", actionKind: "revealCustomerDetails", entityRefs: [], expectedVersion: query.data?.dataVersion ?? "", approvalRef: null, manifestRef: null, payload: { orderRef, reason } });
  };
  return (
    <>
      <span>No customer details are mirrored</span>
      {" · "}
      <button type="button" className={styles.link} style={{ font: "inherit", lineHeight: "inherit", padding: 0, background: "none", border: 0, cursor: "pointer", textDecoration: "underline" }} aria-haspopup="dialog" onClick={() => setOpen(true)}>Customer details (restricted)</button>
      <Dialog open={open} title="Customer details" badge="Demo" onClose={() => setOpen(false)}>
        {data?.revealed ? (
          <div data-testid="customer-revealed">
            <p>Synthetic placeholder values for {orderRef}. This view was logged.</p>
            <dl>
              <div><dt>Name</dt><dd>{data.revealed.name}</dd></div>
              <div><dt>Email</dt><dd>{data.revealed.email}</dd></div>
              <div><dt>City</dt><dd>{data.revealed.city}</dd></div>
            </dl>
          </div>
        ) : blocked ? (
          <p data-testid="customer-denied">{blocked} Customer details are not shown to your role, and nothing was revealed or logged.</p>
        ) : (
          <>
            <p>Only the operations and founder roles can see these. Say why you need them; the reveal is logged with your role and the reason.</p>
            <TextField label="Reason" value={reason} onChange={setReason} error={shown && reason.trim().length < 10 ? "Say why in at least 10 characters." : (fieldError.reason ?? null)} />
            {action.error && !fieldError.reason && <ActionError error={action.error} />}
            <Button loading={action.isPending} onClick={submit}>Reveal customer details</Button>
          </>
        )}
        {data && data.audit.length > 0 && (
          <ul aria-label="Reveal log" data-testid="customer-audit">
            {data.audit.map((a) => <li key={a.id}>{a.id} · {a.role} · {a.reason}</li>)}
          </ul>
        )}
        <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
      </Dialog>
    </>
  );
}
