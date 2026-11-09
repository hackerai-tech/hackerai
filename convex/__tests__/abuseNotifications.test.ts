jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: (x: unknown) => x,
}));
import * as notifications from "../abuseNotifications";
const original = { ...process.env };
const run = (name: keyof typeof notifications, ctx: any, args: any) =>
  (notifications[name] as any).handler(ctx, args);
function fixture() {
  const row: any = {
    _id: "notification",
    caseId: "case",
    status: "pending",
    attempts: 0,
  };
  const report: any = {
    reference: "AB-123e4567-e89b-42d3-a456-426614174000",
    ciphertext: "encrypted",
  };
  const ctx: any = {
    db: {
      query: () => ({
        withIndex: () => ({
          take: async () => (row.status === "paused" ? [row] : []),
        }),
      }),
      get: async (id: string) => (id === "notification" ? row : report),
      patch: async (_id: string, patch: any) => Object.assign(row, patch),
    },
    scheduler: { runAfter: jest.fn() },
  };
  return { row, report, ctx };
}
beforeEach(() => {
  process.env.ABUSE_NOTIFICATIONS_ENABLED = "true";
});
afterEach(() => {
  process.env = { ...original };
});
test("claims once; concurrent invocation and completed jobs cannot resend", async () => {
  const { row, ctx } = fixture();
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toMatchObject({ attempt: 1 });
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
  await run("finish", ctx, {
    notificationId: "notification",
    attempt: 1,
    outcome: "sent",
  });
  expect(row.status).toBe("sent");
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
});
test("retries explicit failures with a bounded backoff, then retains failure", async () => {
  const { row, ctx } = fixture();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await run("claim", ctx, { notificationId: "notification" });
    await run("finish", ctx, {
      notificationId: "notification",
      attempt,
      outcome: "retry",
    });
    expect(row.status).toBe(attempt < 5 ? "pending" : "failed");
  }
  expect(
    ctx.scheduler.runAfter.mock.calls.filter(
      ([delay]: [number]) => delay === 60_000,
    ),
  ).toHaveLength(1);
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
});
test("a crashed or ambiguous send is retained for reconciliation without automatic resend", async () => {
  const { row, ctx } = fixture();
  await run("claim", ctx, { notificationId: "notification" });
  await run("expireClaim", ctx, { notificationId: "notification", attempt: 1 });
  expect(row.status).toBe("uncertain");
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
  await run("finish", ctx, {
    notificationId: "notification",
    attempt: 1,
    outcome: "retry",
  });
  expect(row.status).toBe("uncertain");
});
test.each(["disabled", "erased"])("does not transmit %s work", async (mode) => {
  const { row, report, ctx } = fixture();
  if (mode === "disabled") delete process.env.ABUSE_NOTIFICATIONS_ENABLED;
  else delete report.ciphertext;
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
  expect(row.status).toBe(mode === "disabled" ? "paused" : "failed");
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
});
test("paused work survives disabling and resumes once after re-enabling", async () => {
  const { row, ctx } = fixture();
  delete process.env.ABUSE_NOTIFICATIONS_ENABLED;
  await run("claim", ctx, { notificationId: "notification" });
  expect(row.status).toBe("paused");
  expect(row.attempts).toBe(0);
  await run("resumePaused", ctx, {});
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  process.env.ABUSE_NOTIFICATIONS_ENABLED = "true";
  await run("resumePaused", ctx, {});
  await run("resumePaused", ctx, {});
  expect(row.status).toBe("pending");
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toMatchObject({ attempt: 1 });
});
