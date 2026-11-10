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
test("sends only fixed headers and a case reference through mandatory STARTTLS", async () => {
  expect(await sendAbuseNotification(reference)).toBe("sent");
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
  expect(await sendAbuseNotification(reference)).toBe("failed");
  expect(sendMail).not.toHaveBeenCalled();
});
test("rejects missing credentials and malformed references without transmission", async () => {
  delete process.env.ABUSE_SMTP_PASSWORD;
  expect(await sendAbuseNotification(reference)).toBe("failed");
  process.env.ABUSE_SMTP_PASSWORD = "synthetic";
  expect(
    await sendAbuseNotification(reference + "\r\nBcc: x@example.test"),
  ).toBe("failed");
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
    expect(await sendAbuseNotification(reference)).toBe(outcome);
    expect(close).toHaveBeenCalled();
  },
);
test("a preflight network failure is safely retried without sending a message", async () => {
  verify.mockRejectedValue({ command: "CONN", code: "ETIMEDOUT" });
  expect(await sendAbuseNotification(reference)).toBe("retry");
  expect(sendMail).not.toHaveBeenCalled();
});
test.each(["https://hackerai.co", "https://reports.example.org"])(
  "uses the configured HTTPS review origin without a separate environment setting: %s",
  async (origin) => {
    process.env.ABUSE_NOTIFICATION_REVIEW_URL = origin;
    expect(await sendAbuseNotification(reference)).toBe("sent");
    expect(sendMail.mock.calls[0][0].text).toContain(
      `${origin}/abuse/operations`,
    );
  },
);
