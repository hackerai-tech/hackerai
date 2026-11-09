const sendMail = jest.fn(),
  close = jest.fn(),
  createTransport = jest.fn(() => ({ sendMail, close }));
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
  "https://other.test",
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
  [{ command: "CONN", code: "ETIMEDOUT" }, "retry"],
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
