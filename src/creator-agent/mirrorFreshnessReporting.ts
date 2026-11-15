import { digest } from "./config.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import { HEALTHY_MIRROR_STATES } from "./mirrorFreshness.ts";
import type { MirrorFreshnessRuntime } from "./mirrorFreshnessRuntime.ts";
import { ReportError, reportEventSchema, type ReportEvent, type ReportLocator, type ReportingSource } from "./slackReporting/contract.ts";

export type MirrorReportingConfig = {
  producerRef: string;
  link: ReportEvent["link"];
  /** Resolve an exact, source-authorized run evidence URL. No guessed URL or client input. */
  runEvidenceUrl(runId: string): string | null;
};

/** Translates immutable journal entries into the existing reporter. It grants no send permission or new queue. */
export function mirrorReportEvent(runtime: MirrorFreshnessRuntime, eventRef: string, config: MirrorReportingConfig): ReportEvent {
  const record=runtime.event(eventRef);
  if(!record || record.incident.event==="suppressed") throw new ReportError("MIRROR_REPORT_EVENT_UNAVAILABLE",404);
  const i=record.incident,clear=i.event==="cleared";
  return reportEventSchema.parse({
    eventRef, eventVersion:i.policyVersion??"unadopted", producerRef:config.producerRef,
    occurredAt:clear?i.clearedAt:i.openedAt, severity:clear?"info":"red",
    identity:{kind:"incident",conditionRef:i.incidentId,generation:1,transition:clear?"clear":"breach",sequence:clear?2:1,previousClearEventRef:null},
    subject:{kind:"aggregate",category:"automation"},
    facts:[{label:"incidentStatus",value:clear?"cleared":"breached"},{label:"coverage",value:clear?"complete":i.state==="partial"?"partial":"unknown"}],
    nextAction:clear?"continueMonitoring":"reviewSource",link:config.link,
    mirror:{incident:i,runEvidenceUrl:i.latestRunId?config.runEvidenceUrl(i.latestRunId):null},
  });
}

/** Adds the actual incident/current-source fence to an already qualified reporting connection and owner policy. */
export function fenceMirrorReporting(runtime: MirrorFreshnessRuntime, delegate: ReportingSource, config: MirrorReportingConfig): ReportingSource {
  const canonical=(locator:ReportLocator)=>{
    const event=mirrorReportEvent(runtime,locator.eventRef,config);
    if(event.eventVersion!==locator.eventVersion)throw new ReportError("MIRROR_REPORT_VERSION_MISMATCH",409);
    return event;
  };
  return {
    async readEvent(locator){canonical(locator);return delegate.readEvent(locator);},
    assertCurrent(snapshot,purpose,now){
      assertSynchronousVoid(()=>delegate.assertCurrent(snapshot,purpose,now));
      const event=canonical(snapshot.event);
      if(digest(event)!==digest(snapshot.event))throw new ReportError("MIRROR_REPORT_EVENT_MISMATCH",409);
      if(purpose==="read")return;
      const i=event.mirror!.incident,approval=runtime.repository.approval;
      if(!approval || i.ownerRef!==approval.ownerRef || i.policyVersion!==approval.version)throw new ReportError("MIRROR_REPORT_POLICY_CHANGED",409);
      const summary=runtime.repository.evaluate().find(m=>m.mirrorId===i.mirrorId)!;
      const open=runtime.repository.openIncidents().some(value=>value.incidentId===i.incidentId);
      const current=i.event==="cleared"?!open&&HEALTHY_MIRROR_STATES.includes(summary.state):open&&summary.state===i.state;
      if(!summary.policy.runsBound || summary.policy.staleAfterMinutes===null || !current)throw new ReportError("MIRROR_REPORT_TRANSITION_SUPERSEDED",409);
    },
    authorizeAttempt:(snapshot,command)=>delegate.authorizeAttempt(snapshot,command),
    assertGrant:(grant,command,now)=>delegate.assertGrant(grant,command,now),
    deliver:(command,context)=>delegate.deliver(command,context),
    lookup:(command,context)=>delegate.lookup(command,context),
  };
}
