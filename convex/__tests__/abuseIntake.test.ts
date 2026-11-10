jest.mock("../lib/serviceFunctions", () => ({
  mutation: (definition: unknown) => definition,
  query: (definition: unknown) => definition,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test-service") throw Error("Unauthorized");
  },
}));
jest.mock("server-only", () => ({}));
import { receive } from "../abuseIntake";
import { receive as legacyReceive } from "../abuseCases";
import {
  abuseFingerprints,
  encryptAbuseEvidence,
} from "../../lib/abuse/evidence";
import { database } from "../../__mocks__/abuse-database";
const invoke = (_name: string, ctx: any, args: any) =>
  (receive as any).handler(ctx, args);
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const intake = {
  serviceKey: "test-service",
  reference,
  digests: ["1".repeat(64)],
  sourceHashes: ["2".repeat(64)],
  emailHashes: ["3".repeat(64)],
  kind: "abuse",
  ciphertext: "v1.test.nonce.tag.encrypted",
};
const original = { ...process.env };
beforeEach(() => {
  process.env.ABUSE_INTAKE_ENABLED = "true";
  process.env.ABUSE_SMTP_PASSWORD = "synthetic";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
});
afterEach(() => {
  process.env = { ...original };
});
test("receipts survive key rotation; changed retries conflict and do not duplicate evidence", async () => {
  const ctx = database();
  const report = { private: "synthetic" };
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "old",
    keys: { old: "11".repeat(32) },
  });
  const digests = abuseFingerprints("submission", JSON.stringify(report));
  await invoke("receive", ctx, {
    ...intake,
    digests,
    ciphertext: encryptAbuseEvidence(reference, report),
  });
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "new",
    keys: { old: "11".repeat(32), new: "22".repeat(32) },
  });
  expect(
    await invoke("receive", ctx, {
      ...intake,
      digests: abuseFingerprints("submission", JSON.stringify(report)),
    }),
  ).toEqual({ outcome: "received", reference });
  expect(
    await invoke("receive", ctx, {
      ...intake,
      digests: abuseFingerprints("submission", "changed"),
    }),
  ).toEqual({ outcome: "conflict" });
  expect(ctx.tables.abuse_cases ?? []).toHaveLength(0);
  expect(ctx.tables.abuse_notifications).toHaveLength(1);
  expect(ctx.tables.abuse_rate_limits.every((row) => row.count === 1)).toBe(
    true,
  );
});
test("an accepted report atomically queues one notification across receipt retries", async () => {
  process.env.ABUSE_SMTP_PASSWORD = "synthetic-smtp-password";
  const ctx = { ...database(), scheduler: { runAfter: jest.fn() } };
  await invoke("receive", ctx, intake);
  await invoke("receive", ctx, intake);
  expect(ctx.tables.abuse_cases ?? []).toHaveLength(0);
  expect(ctx.tables.abuse_notifications).toHaveLength(1);
  expect(ctx.tables.abuse_notifications[0]).toMatchObject({
    status: "pending",
    attempts: 0,
    reference,
    ciphertext: intake.ciphertext,
  });
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
});
test.each([undefined, ""])(
  "rejects new submissions without SMTP configuration (%s)",
  async (password) => {
    if (password === undefined) delete process.env.ABUSE_SMTP_PASSWORD;
    else process.env.ABUSE_SMTP_PASSWORD = password;
    const ctx = database();
    await expect(invoke("receive", ctx, intake)).rejects.toThrow(
      "delivery unavailable",
    );
    expect(ctx.tables.abuse_notifications ?? []).toHaveLength(0);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  },
);
test("intake alone never restricts an account and per-email limits cannot be bypassed by rotating a retained key", async () => {
  const ctx = database();
  for (let i = 0; i < 3; i++)
    await invoke("receive", ctx, {
      ...intake,
      reference: `AB-123e4567-e89b-42d3-a456-42661417400${i}`,
    });
  expect(
    await invoke("receive", ctx, {
      ...intake,
      reference: "AB-123e4567-e89b-42d3-a456-426614174009",
      emailHashes: ["4".repeat(64), ...intake.emailHashes],
    }),
  ).toEqual({ outcome: "rate_limited" });
  expect(ctx.tables.user_suspensions).toBeUndefined();
});
test("persists bounded maximum-length non-Latin evidence after encryption", async () => {
  const ctx = database();
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  const encoded = encryptAbuseEvidence(reference, {
    description: "報".repeat(6000),
    evidence: "證".repeat(6000),
    target: "例".repeat(500),
  });
  expect(encoded.length).toBeGreaterThan(48_000);
  await expect(
    invoke("receive", ctx, { ...intake, ciphertext: encoded }),
  ).resolves.toEqual({ outcome: "received", reference });
});

test("the old RPC name shares the new queue and cannot create or duplicate cases", async () => {
  const ctx = database();
  await (legacyReceive as any).handler(ctx, intake);
  await invoke("receive", ctx, intake);
  expect(ctx.tables.abuse_cases ?? []).toHaveLength(0);
  expect(ctx.tables.abuse_events ?? []).toHaveLength(0);
  expect(ctx.tables.abuse_notifications).toHaveLength(1);
});
test("legacy receipts remain idempotent without creating a second delivery", async () => {
  const ctx = database();
  await ctx.db.insert("abuse_cases", { reference, digest: intake.digests[0] });
  expect(await invoke("receive", ctx, intake)).toEqual({
    outcome: "received",
    reference,
  });
  expect(ctx.tables.abuse_notifications ?? []).toHaveLength(0);
});
test("an expired delivery cannot return a new success receipt or be silently resent", async () => {
  const ctx = database();
  await invoke("receive", ctx, intake);
  const row = ctx.tables.abuse_notifications[0];
  await ctx.db.patch(row._id, { payloadExpiresAt: Date.now() - 1 });
  expect(await invoke("receive", ctx, intake)).toEqual({ outcome: "expired" });
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
});

test("an uncertain receipt with an expired erased payload requires an explicit new submission", async () => {
  const ctx = database();
  await invoke("receive", ctx, intake);
  await ctx.db.patch(ctx.tables.abuse_notifications[0]._id, {
    status: "uncertain",
    ciphertext: undefined,
    payloadExpiresAt: undefined,
  });
  expect(await invoke("receive", ctx, intake)).toEqual({ outcome: "expired" });
  expect(ctx.tables.abuse_notifications).toHaveLength(1);
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
});
