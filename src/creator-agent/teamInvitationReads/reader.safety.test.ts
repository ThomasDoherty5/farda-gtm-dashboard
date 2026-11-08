// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTeamInvitationReadReader, TeamInvitationReadError } from "./reader";
import type { TeamInvitationReadSourceReader } from "./source";
import type { TeamInvitationReadViewKey } from "./contract";
import { teamInvitationSnapshot, teamInvitationRecord, teamInvitationTestScope } from "./fixtures.testkit";

const principal = { principalRef: "agent-reader", role: "reader" as const };
const clock = () => Date.parse("2026-11-06T12:00:00.000Z");
const make = (source: TeamInvitationReadSourceReader, now = clock) => createTeamInvitationReadReader({ scope: teamInvitationTestScope, secret: "synthetic-current-source-fence-key-000000000000", source, now });
const filtersFor = (_key: TeamInvitationReadViewKey) => ({});
const viewKey = "invitationDraft" as const;
const fixed = (patch: Record<string, unknown> = {}): TeamInvitationReadSourceReader => ({ read: async () => teamInvitationSnapshot(viewKey, patch), assertCurrent() {} });

describe("teamInvitationReads current-authority and native boundary", () => {
  it.each(["permission", "version"] as const)("rejects %s changed while a source read is pending", async change => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let revoked = false, advanced = false;
    const source: TeamInvitationReadSourceReader = {
      async read() { const captured = teamInvitationSnapshot(viewKey); entered(); await gate; return captured; },
      assertCurrent(s, binding) {
        expect(binding).toEqual({ scope: teamInvitationTestScope, principal, request: { viewKey, filters: filtersFor(viewKey) } });
        expect(s.permissionVersion).toBe("synthetic-permission-v1");
        if (revoked) throw new TeamInvitationReadError("private-source-denial", 403);
        if (advanced) throw new TeamInvitationReadError("private-source-revision", 409);
      },
    };
    const pending = make(source).read(viewKey, filtersFor(viewKey), principal);
    await started;
    revoked = change === "permission"; advanced = change === "version"; release();
    await expect(pending).rejects.toMatchObject({ code: revoked ? "SOURCE_AUTHORITY_DENIED" : "SOURCE_VERSION_CHANGED", status: revoked ? 403 : 409 });
  });

  it("retains a final synchronous fence for publication and freezes its captured basis", async () => {
    const answer = teamInvitationSnapshot(viewKey); let allowed = true, assertions = 0;
    const source: TeamInvitationReadSourceReader = { read: async () => answer, assertCurrent(s, binding) {
      assertions++;
      expect(Object.isFrozen(s)).toBe(true); expect(Object.isFrozen(binding.request.filters)).toBe(true);
      if (!allowed) throw new TeamInvitationReadError("denied", 403);
    } };
    const result = await make(source).read(viewKey, filtersFor(viewKey), principal);
    expect(assertions).toBeGreaterThanOrEqual(2);
    answer.version = "mutated-external-object";
    expect(JSON.stringify(result)).not.toContain("mutated-external-object");
    allowed = false;
    expect(() => result.assertCurrent()).toThrow("SOURCE_AUTHORITY_DENIED");
    expect(JSON.stringify(result)).not.toContain("synthetic-permission-v1");
    expect(JSON.stringify(result)).not.toContain("principalRef");
  });

  it("rejects a missing, asynchronous or non-void final assertion", async () => {
    for (const assertion of [undefined, async () => undefined, () => true]) {
      const source = { read: async () => teamInvitationSnapshot(viewKey), assertCurrent: assertion } as unknown as TeamInvitationReadSourceReader;
      await expect(make(source).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_UNVERIFIED", status: 503 });
    }
  });

  it("rejects a snapshot for another principal and missing permission proof", async () => {
    await expect(make(fixed({ principalRef: "another-principal" })).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_AUTHORITY_DENIED" });
    await expect(make(fixed({ permissionVersion: undefined })).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  });

  it("accepts explicit synthetic native evidence and refuses demo identities or inconsistent evidence markers", async () => {
    const native = await make(fixed()).read(viewKey, filtersFor(viewKey), principal);
    expect(native.data).toMatchObject({ datasetKey: "invitation-native", synthetic: true, provenance: { evidenceStage: "synthetic" } });
    for (const patch of [{ datasetKey: "invitation-demo" }, { synthetic: false }, { provenance: undefined }]) {
      const malformed = { ...teamInvitationRecord(viewKey) as object, ...patch };
      await expect(make(fixed({ record: malformed })).read(viewKey, filtersFor(viewKey), principal)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    }
  });
});
