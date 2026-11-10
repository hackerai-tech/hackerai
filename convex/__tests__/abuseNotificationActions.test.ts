jest.mock("../lib/serviceFunctions", () => ({
  internalAction: (definition: unknown) => definition,
  internalMutation: (definition: unknown) => definition,
}));
const sendMail = jest.fn();
const verify = jest.fn();
jest.mock("nodemailer", () => ({
  __esModule: true,
  default: {
    createTransport: () => ({ sendMail, verify, close: jest.fn() }),
  },
}));
import { getFunctionName } from "convex/server";
import { deliver } from "../abuseNotificationActions";
import * as notifications from "../abuseNotifications";
import { encryptAbuseEvidence } from "../../lib/abuse/evidence-crypto";

const original = { ...process.env };
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const report = {
  submissionId: reference.slice(3),
  kind: "abuse",
  email: "reporter@example.test",
  target: "https://target.example.test",
  description: "Synthetic full report for delivery integration coverage.",
  evidence: "Synthetic submitted evidence for the email body.",
};
beforeEach(() => {
  process.env.ABUSE_SMTP_PASSWORD = "synthetic-password";
  process.env.ABUSE_NOTIFICATION_REVIEW_URL = "https://reports.example.test";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  verify.mockReset().mockResolvedValue(true);
  sendMail.mockReset().mockResolvedValue({ accepted: ["abuse@hackerai.co"] });
});
afterEach(() => {
  process.env = { ...original };
});

function fixture() {
  const row: any = {
    caseId: "case",
    status: "pending",
    attempts: 0,
  };
  const saved: any = {
    reference,
    ciphertext: encryptAbuseEvidence(reference, report),
    createdAt: Date.UTC(2026, 10, 9),
  };
  const ctx: any = {
    db: {
      get: async (id: string) => (id === "notification" ? row : saved),
      patch: async (_id: string, change: unknown) => Object.assign(row, change),
    },
    scheduler: { runAfter: jest.fn() },
    runMutation: jest.fn(async (ref: any, args: any) => {
      const name = getFunctionName(ref).split(":")[1];
      return (notifications as any)[name].handler(ctx, args);
    }),
  };
  return { row, saved, ctx };
}

test("the actual claim, decrypt, send and finish pipeline delivers report details only once", async () => {
  const { row, ctx } = fixture();
  await (deliver as any).handler(ctx, { notificationId: "notification" });
  await (deliver as any).handler(ctx, { notificationId: "notification" });
  expect(row).toMatchObject({ status: "sent", attempts: 1 });
  expect(sendMail).toHaveBeenCalledTimes(1);
  const message = sendMail.mock.calls[0][0];
  expect(message.to).toBe("abuse@hackerai.co");
  for (const value of [
    report.email,
    report.target,
    report.description,
    report.evidence,
  ])
    expect(message.text).toContain(value);
  const scheduled = JSON.stringify(ctx.scheduler.runAfter.mock.calls);
  expect(scheduled).not.toContain(report.email);
  expect(scheduled).not.toContain(report.description);
});

test.each(["missing key", "wrong key", "corrupt ciphertext"])(
  "fails closed before SMTP for %s without logging report contents",
  async (failure) => {
    const { row, saved, ctx } = fixture();
    if (failure === "missing key") delete process.env.ABUSE_EVIDENCE_KEYS;
    else if (failure === "wrong key")
      process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
        active: "test",
        keys: { test: "22".repeat(32) },
      });
    else saved.ciphertext += "corrupt";
    await (deliver as any).handler(ctx, { notificationId: "notification" });
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(verify).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  },
);
