import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { OperationsScope } from "./operations.ts";

function scopedKey(scope: OperationsScope, secret: string, purpose: string) {
  return createHmac("sha256", secret).update(JSON.stringify(["saved-operations.v2", purpose, scope.workspaceId, scope.accountId, scope.environment])).digest();
}

export function sealOperationsToken(scope: OperationsScope, secret: string, purpose: string, value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scopedKey(scope, secret, purpose), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}

export function openOperationsToken(scope: OperationsScope, secret: string, purpose: string, token: string): unknown {
  if (!/^[a-zA-Z0-9_-]{39,4100}$/.test(token)) throw new Error("INVALID_TOKEN");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) throw new Error("INVALID_TOKEN");
  const decipher = createDecipheriv("aes-256-gcm", scopedKey(scope, secret, purpose), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"));
}
