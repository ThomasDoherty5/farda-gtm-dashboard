import { approvalRefSchema } from "../approvals/contract.ts";
import { ActionServiceError } from "./contract.ts";

/** Trusted compiled routing. A request never chooses the native account or handler. */
export type RegisteredAction = { handlerRef: string; handlerRefsByAccount?: never } |
  { handlerRef?: never; handlerRefsByAccount: ReadonlyMap<string, string> };

export function copyRegisteredAction(value: RegisteredAction): RegisteredAction {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => key !== "handlerRef" && key !== "handlerRefsByAccount") ||
    (value.handlerRef !== undefined) === (value.handlerRefsByAccount !== undefined)) throw new Error("Action requires exactly one compiled handler routing mode.");
  if (value.handlerRef !== undefined) return Object.freeze({ handlerRef: approvalRefSchema.parse(value.handlerRef) });
  if (!(value.handlerRefsByAccount instanceof Map) || value.handlerRefsByAccount.size < 1 || value.handlerRefsByAccount.size > 100)
    throw new Error("Action requires a bounded exact account-handler map.");
  return Object.freeze({ handlerRefsByAccount: new Map([...value.handlerRefsByAccount].map(([account, handler]) =>
    [approvalRefSchema.parse(account), approvalRefSchema.parse(handler)])) });
}
export function registeredHandlerRefs(value: RegisteredAction): string[] {
  const copy = copyRegisteredAction(value);
  return copy.handlerRef !== undefined ? [copy.handlerRef] : [...copy.handlerRefsByAccount.values()];
}
export function registeredHandler(value: RegisteredAction, approvedAccount: string): string {
  const handler = value.handlerRef ?? value.handlerRefsByAccount?.get(approvedAccount);
  if (!handler) throw new ActionServiceError("SOURCE_ACTION_UNSUPPORTED", 409, "notApplied");
  return handler;
}
