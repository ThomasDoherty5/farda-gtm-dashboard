import { useState } from "react";
import type { OperationsReportingScope } from "@/adapter/viewSchemas/nativeOperations";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Field } from "@/components/Field";
import styles from "./Operations.module.css";
export function OperationsPeriodControl({ scope, onApply }: { scope: OperationsReportingScope | null | undefined; onApply: (startAt: string, endAt: string) => void }) {
  const [open, setOpen] = useState(false);
  return <><Button variant="secondary" disabledReason={scope ? undefined : "A source-bound reporting period was not supplied."} aria-haspopup="dialog" onClick={() => setOpen(true)}>Reporting period</Button><Dialog open={open} title="Reporting period" onClose={() => setOpen(false)}>{scope && open && <PeriodFields key={`${scope.startAt}:${scope.endAt}:${scope.timezone}`} scope={scope} apply={(start, end) => { onApply(start, end); setOpen(false); }} />}<Button variant="secondary" onClick={() => setOpen(false)}>Cancel period change</Button></Dialog></>;
}
function PeriodFields({ scope, apply }: { scope: OperationsReportingScope; apply: (start: string, end: string) => void }) {
  const [start, setStart] = useState(new Date(scope.startAt).toISOString().slice(0, -1));
  const [end, setEnd] = useState(new Date(scope.endAt).toISOString().slice(0, -1));
  const startTime = Date.parse(`${start}Z`), endTime = Date.parse(`${end}Z`);
  const error = !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime ? "Enter a valid start before the end." : undefined;
  return <div className={styles.stack}><p>Times below are UTC. The source reporting timezone remains {scope.timezone}; home remains {scope.home}. The source must verify this exact reporting window before showing results.</p><Field label="Start (UTC)">{props => <input {...props} type="datetime-local" step="0.001" value={start} onChange={event => setStart(event.target.value)} />}</Field><Field label="End (UTC)" error={error}>{props => <input {...props} type="datetime-local" step="0.001" value={end} onChange={event => setEnd(event.target.value)} />}</Field><Button disabledReason={error} onClick={() => { if (!error) apply(new Date(startTime).toISOString(), new Date(endTime).toISOString()); }}>Apply reporting period</Button></div>;
}
