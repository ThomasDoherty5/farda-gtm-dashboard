import { z } from "zod";
import type { OperationsScope } from "./operations.ts";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";

const canonical = z.string().trim().min(1).max(240);
const purpose = "creator-collaboration-route.v1";
const prefix = "collab1-";

/** This opaque route reference identifies only a record. A fresh scoped read must authorize its contents. */
export function sealCollaborationRef(scope: OperationsScope, secret: string, id: string): string {
  return prefix + sealOperationsToken(scope, secret, purpose, canonical.parse(id));
}
export function openCollaborationRef(scope: OperationsScope, secret: string, ref: string): string {
  if (!ref.startsWith(prefix)) throw new Error("INVALID_COLLABORATION_REFERENCE");
  try { return canonical.parse(openOperationsToken(scope, secret, purpose, ref.slice(prefix.length))); }
  catch { throw new Error("INVALID_COLLABORATION_REFERENCE"); }
}
