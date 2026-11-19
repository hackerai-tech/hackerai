jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: (definition: unknown) => definition,
}));
import { resumePaused } from "../abuseNotifications";
import { database } from "../../__mocks__/abuse-database";
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
test("the indexed sweep purges expired payloads, receipts and limiter hashes even while mail is disabled", async () => {
  delete process.env.ABUSE_SMTP_PASSWORD;
  const ctx = database();
  const now = Date.now();
  const failed = await ctx.db.insert("abuse_notifications", {
    reference: "failed",
    status: "failed",
    attempts: 5,
    ciphertext: "encrypted",
    payloadExpiresAt: now - 1,
    expiresAt: now + 86400000,
    updatedAt: now - 1000,
  });
  const receipt = await ctx.db.insert("abuse_notifications", {
    reference: "sent",
    status: "sent",
    attempts: 1,
    expiresAt: now - 1,
    updatedAt: now - 86400000,
  });
  const historical = await ctx.db.insert("abuse_notifications", {
    caseId: "historical-case",
    status: "failed",
    attempts: 1,
    updatedAt: now - 86400000,
  });
  const limit = await ctx.db.insert("abuse_rate_limits", {
    bucket: "hash-only",
    count: 1,
    expiresAt: now - 1,
  });
  await (resumePaused as any).handler(ctx, {});
  expect(await ctx.db.get(failed)).toMatchObject({ status: "expired" });
  expect(await ctx.db.get(failed)).not.toHaveProperty("ciphertext");
  expect(await ctx.db.get(receipt)).toBeNull();
  expect(await ctx.db.get(limit)).toBeNull();
  expect(await ctx.db.get(historical)).not.toBeNull();
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
});
test("a fresh in-flight send is not erased until its lease is stale, and acknowledgement uncertainty is preserved", async () => {
  delete process.env.ABUSE_SMTP_PASSWORD;
  const ctx = database();
  const now = Date.now();
  const id = await ctx.db.insert("abuse_notifications", {
    reference: "sending",
    status: "sending",
    attempts: 1,
    ciphertext: "encrypted",
    payloadExpiresAt: now - 1,
    expiresAt: now + 86400000,
    updatedAt: now,
  });
  await (resumePaused as any).handler(ctx, {});
  expect((await ctx.db.get(id)).ciphertext).toBe("encrypted");
  await ctx.db.patch(id, { updatedAt: now - 120001 });
  await (resumePaused as any).handler(ctx, {});
  expect(await ctx.db.get(id)).toMatchObject({ status: "uncertain" });
  expect(await ctx.db.get(id)).not.toHaveProperty("ciphertext");
});
