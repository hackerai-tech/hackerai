const sendMail = jest.fn(),
  verify = jest.fn(),
  close = jest.fn(),
  createTransport = jest.fn(() => ({ sendMail, verify, close }));
jest.mock("nodemailer", () => ({
  __esModule: true,
  default: {
    createTransport: (...args: unknown[]) => createTransport(...args),
  },
}));
import { sendAbuseNotification } from "../notification-mail";
const original = { ...process.env };
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const report = {
  submissionId: reference.slice(3),
  kind: "abuse",
  email: "reporter@example.test",
  target: "https://target.example.test",
  occurredAt: "2026-11-09 16:30 UTC",
  description: "Synthetic report description with sufficient detail.",
  sourceIp: "192.0.2.42",
  sourcePort: "443",
  protocol: "HTTPS",
  reference: "AB-related-case",
  evidence: "Synthetic evidence\nhttps://evidence.example.test/detail",
};
const receivedAt = Date.UTC(2026, 10, 9, 16, 31);
const notify = (value: string) =>
  sendAbuseNotification(value, report, receivedAt);
beforeEach(() => {
  verify.mockReset().mockResolvedValue(true);
  process.env.ABUSE_SMTP_PASSWORD = "synthetic-smtp-password";
  process.env.ABUSE_NOTIFICATION_REVIEW_URL =
    "https://hackerai-git-test-hackerai.vercel.app";
  sendMail.mockReset().mockResolvedValue({ accepted: ["abuse@hackerai.co"] });
});
afterEach(() => {
  process.env = { ...original };
});
test("sends the complete submitted report in plain text with fixed headers and mandatory STARTTLS", async () => {
  expect(await notify(reference)).toBe("sent");
  expect(createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      host: "smtp.protonmail.ch",
      port: 587,
      requireTLS: true,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    }),
  );
  const message = sendMail.mock.calls[0][0];
  expect(message.to).toBe("abuse@hackerai.co");
  expect(message.text).toContain(reference);
  expect(message.text).toContain(
    "https://hackerai-git-test-hackerai.vercel.app/abuse/operations",
  );
  for (const value of Object.values(report))
    expect(message.text).toContain(value);
  expect(message.text).toContain("2026-11-09T16:31:00.000Z");
  expect(message.text).toContain("does not delete this mailbox copy");
  expect(message.subject).toBe(`HackerAI report received: ${reference}`);
  expect(message.from.address).toBe("abuse@hackerai.co");
  expect(message).not.toHaveProperty("html");
  expect(message).not.toHaveProperty("replyTo");
  expect(message).not.toHaveProperty("attachments");
  expect(close).toHaveBeenCalled();
});
test.each([
  "http://hackerai.co",
  "https://user:password@example.test",
  "https://example.test/abuse/operations",
  "https://example.test/#fragment",
  "not-a-url",
  "",
  "https://hackerai.co/?secret=x",
])("rejects invalid review origins before SMTP: %s", async (url) => {
  process.env.ABUSE_NOTIFICATION_REVIEW_URL = url;
  expect(await notify(reference)).toBe("failed");
  expect(sendMail).not.toHaveBeenCalled();
});
test("rejects missing credentials and malformed references without transmission", async () => {
  delete process.env.ABUSE_SMTP_PASSWORD;
  expect(await notify(reference)).toBe("failed");
  process.env.ABUSE_SMTP_PASSWORD = "synthetic";
  expect(await notify(reference + "\r\nBcc: x@example.test")).toBe("failed");
  expect(sendMail).not.toHaveBeenCalled();
});
test.each([
  [{ command: "CONN", code: "ETIMEDOUT" }, "uncertain"],
  [{ command: "RCPT TO", responseCode: 450 }, "retry"],
  [{ command: "AUTH", responseCode: 535 }, "failed"],
  [{ command: "DATA", responseCode: 451 }, "retry"],
  [{ command: "DATA", code: "ECONNRESET" }, "uncertain"],
  [{ message: "PRIVATE_PROVIDER_DETAILS" }, "uncertain"],
])(
  "classifies delivery uncertainty without propagating provider details: %j",
  async (error, outcome) => {
    sendMail.mockRejectedValue(error);
    expect(await notify(reference)).toBe(outcome);
    expect(close).toHaveBeenCalled();
  },
);
test("a preflight network failure is safely retried without sending a message", async () => {
  verify.mockRejectedValue({ command: "CONN", code: "ETIMEDOUT" });
  expect(await notify(reference)).toBe("retry");
  expect(sendMail).not.toHaveBeenCalled();
});
test.each(["https://hackerai.co", "https://reports.example.org"])(
  "uses the configured HTTPS review origin without a separate environment setting: %s",
  async (origin) => {
    process.env.ABUSE_NOTIFICATION_REVIEW_URL = origin;
    expect(await notify(reference)).toBe("sent");
    expect(sendMail.mock.calls[0][0].text).toContain(
      `${origin}/abuse/operations`,
    );
  },
);

test.each([
  { ...report, submissionId: "123e4567-e89b-42d3-a456-426614174001" },
  { ...report, description: "short" },
  { ...report, evidence: "x".repeat(6001) },
  { ...report, privateKey: "must not be emailed" },
])(
  "rejects mismatched, unbounded or unknown report data before SMTP",
  async (invalid) => {
    expect(await sendAbuseNotification(reference, invalid, receivedAt)).toBe(
      "failed",
    );
    expect(sendMail).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);
test("includes appeal details and leaves supplied markup as text", async () => {
  const appeal = {
    ...report,
    kind: "appeal",
    target: "",
    evidence:
      '<img src="https://untrusted.example.test/track">\r\nBcc: attacker@example.test',
  };
  expect(await sendAbuseNotification(reference, appeal, receivedAt)).toBe(
    "sent",
  );
  const message = sendMail.mock.calls[0][0];
  expect(message.text).toContain("New appeal");
  expect(message.text).toContain(appeal.evidence);
  expect(message.to).toBe("abuse@hackerai.co");
  expect(message).not.toHaveProperty("html");
  expect(message).not.toHaveProperty("attachments");
});
