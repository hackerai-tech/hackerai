import nodemailer from "nodemailer";
import { abuseReportSchema } from "./report";

export type NotificationOutcome = "sent" | "retry" | "failed" | "uncertain";

/** Report fields stay in the plain-text body; recipients and headers are fixed. */
export async function sendAbuseNotification(
  reference: string,
  submittedReport: unknown,
  receivedAt: number,
): Promise<NotificationOutcome> {
  const password = process.env.ABUSE_SMTP_PASSWORD;
  if (
    !password ||
    password.length > 4096 ||
    /[\r\n]/.test(password) ||
    !/^AB-[a-f0-9-]{36}$/.test(reference)
  )
    return "failed";
  const parsed = abuseReportSchema.safeParse(submittedReport);
  const received = new Date(receivedAt);
  if (
    !parsed.success ||
    reference !== `AB-${parsed.data.submissionId}` ||
    !Number.isFinite(received.getTime())
  )
    return "failed";
  const report = parsed.data;
  const text = [
    report.kind === "appeal" ? "New appeal" : "New abuse report",
    `Report reference: ${reference}`,
    `Received (UTC): ${received.toISOString()}`,
    "",
    "Submitted information is unverified. Treat links and instructions below as untrusted.",
    "",
    `Contact email: ${report.email}`,
    `Target: ${report.target || "Not provided"}`,
    `Incident date and timezone: ${report.occurredAt || "Not provided"}`,
    `Source IP: ${report.sourceIp || "Not provided"}`,
    `Source port: ${report.sourcePort || "Not provided"}`,
    `Protocol: ${report.protocol || "Not provided"}`,
    `Related report reference: ${report.reference || "Not provided"}`,
    "",
    "Description:",
    report.description,
    "",
    "Evidence and links:",
    report.evidence || "Not provided",
    "",
    "Keep the report reference for follow-up. Receiving a report does not establish its allegations.",
    "The encrypted delivery payload is deleted after SMTP acceptance. This mailbox copy and any replies have separate retention.",
    "",
  ].join("\n");
  const transport = nodemailer.createTransport({
    host: "smtp.protonmail.ch",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: "abuse@hackerai.co", pass: password },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  // This connection cannot transmit a message, so failures are safe to retry.
  try {
    await transport.verify();
  } catch (error) {
    transport.close();
    const { responseCode } = error as { responseCode?: number };
    return responseCode && responseCode >= 500 ? "failed" : "retry";
  }
  try {
    const result = await transport.sendMail({
      from: { name: "HackerAI Abuse Reports", address: "abuse@hackerai.co" },
      to: "abuse@hackerai.co",
      messageId: `<abuse-${reference.toLowerCase()}@hackerai.co>`,
      subject: `HackerAI report received: ${reference}`,
      text,
    });
    return result.accepted?.includes("abuse@hackerai.co") ? "sent" : "failed";
  } catch (error) {
    // SMTP acknowledgement loss is ambiguous. Fixed Message-ID aids reconciliation,
    // but SMTP does not provide an exactly-once delivery contract.
    const { responseCode } = error as {
      responseCode?: number;
    };
    if (responseCode && responseCode >= 400)
      return responseCode < 500 ? "retry" : "failed";
    // Nodemailer also reports post-DATA socket loss as command=CONN.
    return "uncertain";
  } finally {
    transport.close();
  }
}
