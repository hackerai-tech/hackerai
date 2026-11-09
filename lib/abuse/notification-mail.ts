import nodemailer from "nodemailer";

export type NotificationOutcome = "sent" | "retry" | "failed" | "uncertain";

/** Only reference metadata leaves case storage; recipients and headers are fixed. */
export async function sendAbuseNotification(
  reference: string,
): Promise<NotificationOutcome> {
  const password = process.env.ABUSE_SMTP_PASSWORD;
  let origin: string;
  try {
    const url = new URL(process.env.ABUSE_NOTIFICATION_REVIEW_URL ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !(
        url.hostname === "hackerai.co" ||
        url.hostname.endsWith("-hackerai.vercel.app")
      )
    )
      return "failed";
    origin = url.origin;
  } catch {
    return "failed";
  }
  if (
    !password ||
    password.length > 4096 ||
    /[\r\n]/.test(password) ||
    !/^AB-[a-f0-9-]{36}$/.test(reference)
  )
    return "failed";
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
  try {
    const result = await transport.sendMail({
      from: { name: "HackerAI Abuse Reports", address: "abuse@hackerai.co" },
      to: "abuse@hackerai.co",
      messageId: `<abuse-${reference.toLowerCase()}@hackerai.co>`,
      subject: `HackerAI report received: ${reference}`,
      text: `A new report or appeal has been saved.\n\nCase reference: ${reference}\nReview: ${origin}/abuse/operations\n\nSign in with an authorized operator account and open this reference. Report contents remain in restricted case storage. This notification confirms receipt, not an investigation result.\n`,
    });
    return result.accepted?.includes("abuse@hackerai.co") ? "sent" : "failed";
  } catch (error) {
    // SMTP acknowledgement loss is ambiguous. Fixed Message-ID aids reconciliation,
    // but SMTP does not provide an exactly-once delivery contract.
    const { responseCode, command } = error as {
      responseCode?: number;
      command?: string;
    };
    if (responseCode && responseCode >= 400)
      return responseCode < 500 ? "retry" : "failed";
    return [
      "CONN",
      "EHLO",
      "HELO",
      "STARTTLS",
      "AUTH",
      "MAIL FROM",
      "RCPT TO",
    ].includes(command ?? "")
      ? "retry"
      : "uncertain";
  } finally {
    transport.close();
  }
}
