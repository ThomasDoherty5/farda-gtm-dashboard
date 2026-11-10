import {digest} from "./config.ts";
import {assertSynchronousVoid} from "./sourceFence.ts";
import {OperationsAuthorityError,type OperationsControlAuthority} from "./operationsControlAuthority.ts";
import type {OperationsControlServiceReaders} from "./operationsControls.ts";
import type {createRuntimeApi} from "./jobs/runtimeApi.ts";
import type {SlackReportingService} from "./slackReporting/service.ts";

/** Read-only composition of existing services. Browser actors never acquire worker authority. */
export function createOperationsControlServiceReaders(options:{authority:OperationsControlAuthority;
  runtime?:()=>ReturnType<typeof createRuntimeApi>|undefined;reporting?:()=>SlackReportingService|undefined}):OperationsControlServiceReaders{
  return {async read(reference,principal){
    const proof=await options.authority.resolve(principal),frozen=structuredClone(reference);
    const assertAssociation=()=>{
      proof.assertCurrent();
      if(!proof.authority.serviceRefs.some(row=>digest(row)===digest(frozen)))throw new OperationsAuthorityError("OPERATIONS_SERVICE_BINDING_CHANGED",403);
    };
    assertAssociation();
    const unavailable=()=>({reference:frozen,unavailableReason:"OPERATIONS_SERVICE_UNCONFIGURED",assertCurrent:assertAssociation});
    if(reference.kind==="report"){
      const reporting=options.reporting?.();if(!reporting)return unavailable();
      const evidence=await reporting.readEvidence(reference.reportRef,{assertCurrent:assertAssociation});
      if(evidence.data.reportRef!==reference.reportRef)throw new OperationsAuthorityError("OPERATIONS_SERVICE_BINDING_CHANGED");
      const assertCurrent=()=>{assertAssociation();assertSynchronousVoid(evidence.assertCurrent);assertAssociation();};
      assertCurrent();return {reference:frozen,data:evidence.data,assertCurrent};
    }
    const runtime=options.runtime?.();if(!runtime)return unavailable();
    const evidence=reference.kind==="runtimeRun"
      ?await runtime.readRunEvidence(runtime.runRef(reference.runId),principal.principalRef)
      :await runtime.readRegistrationEvidence(runtime.registrationRef(reference.registrationRef),principal.principalRef);
    const binding=evidence.binding;
    if(binding.registrationRef!==reference.registrationRef||binding.registrationVersion!==reference.registrationVersion||
      (reference.kind==="runtimeRun"&&(!("runId"in binding)||binding.runId!==reference.runId))||
      (reference.kind==="runtimeRegistration"&&(!("jobId"in binding)||binding.jobId!==reference.jobId||binding.jobVersion!==reference.jobVersion)))
      throw new OperationsAuthorityError("OPERATIONS_SERVICE_BINDING_CHANGED");
    const assertCurrent=()=>{assertAssociation();assertSynchronousVoid(evidence.assertCurrent);assertAssociation();};
    assertCurrent();return {reference:frozen,data:evidence.data,assertCurrent};
  }};
}
