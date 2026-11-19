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
    reference: "AB-123e4567-e89b-42d3-a456-426614174000",
    ciphertext: "encrypted",
    receivedAt: Date.now(),
    payloadExpiresAt: Date.now() + 7 * 86400000,
    expiresAt: Date.now() + 30 * 86400000,
    status: "pending",
    attempts: 0,
  };
  const report: any = {
    reference: "AB-123e4567-e89b-42d3-a456-426614174000",
    ciphertext: "encrypted",
    createdAt: 1_700_000_000_000,
  };
  const ctx: any = {
    db: {
      query: (table: string) => ({
        withIndex: (_name: string, callback: (q: any) => unknown) => {
          let matches = table === "abuse_notifications";
          const q: any = {
            eq: (field: string, value: unknown) => {
              matches = matches && row[field] === value;
              return q;
            },
            gt: (field: string, value: number) => {
              matches = matches && row[field] > value;
              return q;
            },
            lte: (field: string, value: number) => {
              matches = matches && row[field] <= value;
              return q;
            },
            lt: (field: string, value: number) => {
              matches = matches && row[field] < value;
              return q;
            },
          };
          callback(q);
          return { take: async () => (matches ? [row] : []) };
        },
      }),
      get: async (id: string) => (id === "notification" ? row : report),
      patch: async (_id: string, patch: any) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete row[key];
          else row[key] = value;
        }
      },
      delete: jest.fn(),
    },
    scheduler: { runAfter: jest.fn() },
  };
  return { row, report, ctx };
}
beforeEach(() => {
  process.env.ABUSE_SMTP_PASSWORD = "synthetic-smtp-password";
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
  if (mode === "disabled") delete process.env.ABUSE_SMTP_PASSWORD;
  else delete row.ciphertext;
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
  expect(row.status).toBe(mode === "disabled" ? "paused" : "failed");
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
});
test("paused work survives disabling and resumes once after re-enabling", async () => {
  const { row, ctx } = fixture();
  delete process.env.ABUSE_SMTP_PASSWORD;
  await run("claim", ctx, { notificationId: "notification" });
  expect(row.status).toBe("paused");
  expect(row.attempts).toBe(0);
  await run("resumePaused", ctx, {});
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  process.env.ABUSE_SMTP_PASSWORD = "synthetic-smtp-password";
  await run("resumePaused", ctx, {});
  await run("resumePaused", ctx, {});
  expect(row.status).toBe("pending");
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toMatchObject({ attempt: 1 });
});
test("an admin can retry a confirmed failure after repair, but cannot duplicate or resend uncertain work", async () => {
  const { row, ctx } = fixture();
  row.status = "failed";
  row.attempts = 1;
  await run("retryFailed", ctx, {
    notificationId: "notification",
    expectedAttempts: 1,
  });
  expect(row.status).toBe("pending");
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  await expect(
    run("retryFailed", ctx, {
      notificationId: "notification",
      expectedAttempts: 1,
    }),
  ).rejects.toThrow();
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toMatchObject({ attempt: 2 });
  await run("finish", ctx, {
    notificationId: "notification",
    attempt: 2,
    outcome: "sent",
  });
  expect(row.status).toBe("sent");
  row.status = "uncertain";
  await expect(
    run("retryFailed", ctx, {
      notificationId: "notification",
      expectedAttempts: 2,
    }),
  ).rejects.toThrow();
  row.status = "failed";
  await expect(
    run("retryFailed", ctx, {
      notificationId: "notification",
      expectedAttempts: 1,
    }),
  ).rejects.toThrow();
});
test("the sweep recovers a dropped pending action without advancing a legitimate delayed retry", async () => {
  const { row, ctx } = fixture();
  const now = Date.now();
  row.attempts = 4;
  row.updatedAt = now - 65 * 60_000;
  await run("resumePaused", ctx, {});
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  row.updatedAt = now - 70 * 60_000;
  await run("resumePaused", ctx, {});
  await run("resumePaused", ctx, {});
  expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  expect(row.status).toBe("pending");
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toMatchObject({ attempt: 5 });
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
});

test("confirmation erases a new delivery payload while keeping its receipt for deduplication", async () => {
  const { row, ctx } = fixture();
  await run("claim", ctx, { notificationId: "notification" });
  await run("finish", ctx, {
    notificationId: "notification",
    attempt: 1,
    outcome: "sent",
  });
  expect(row).not.toHaveProperty("ciphertext");
  expect(row).not.toHaveProperty("payloadExpiresAt");
  expect(row).toMatchObject({
    status: "sent",
    reference: "AB-123e4567-e89b-42d3-a456-426614174000",
    attempts: 1,
  });
});

test("an expired payload cannot be claimed or explicitly retried", async () => {
  const { row, ctx } = fixture();
  row.payloadExpiresAt = Date.now() - 1;
  expect(
    await run("claim", ctx, { notificationId: "notification" }),
  ).toBeNull();
  expect(row.status).toBe("expired");
  expect(row).not.toHaveProperty("ciphertext");
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  row.status = "failed";
  await expect(
    run("retryFailed", ctx, {
      notificationId: "notification",
      expectedAttempts: 0,
    }),
  ).rejects.toThrow("unavailable");
});

test("mailbox reconciliation can confirm acceptance without another send or permit a checked retry", async () => {
  const { row, ctx } = fixture();
  row.status = "uncertain";
  row.attempts = 1;
  await run("reconcileUncertain", ctx, {
    notificationId: "notification",
    expectedAttempts: 1,
    decision: "confirmed_sent",
  });
  expect(row.status).toBe("sent");
  expect(row).not.toHaveProperty("ciphertext");
  expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  const other = fixture();
  other.row.status = "uncertain";
  other.row.attempts = 1;
  await run("reconcileUncertain", other.ctx, {
    notificationId: "notification",
    expectedAttempts: 1,
    decision: "confirmed_not_sent",
  });
  expect(other.row.status).toBe("pending");
  expect(other.ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  await expect(
    run("reconcileUncertain", other.ctx, {
      notificationId: "notification",
      expectedAttempts: 1,
      decision: "confirmed_not_sent",
    }),
  ).rejects.toThrow("changed");
});
