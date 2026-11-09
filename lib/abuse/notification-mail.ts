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
      !(process.env.ABUSE_NOTIFICATION_ENVIRONMENT === "production"
        ? url.hostname === "hackerai.co"
        : process.env.ABUSE_NOTIFICATION_ENVIRONMENT === "preview" &&
          /^hackerai-git-[a-z0-9-]+-hackerai\.vercel\.app$/.test(url.hostname))
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
      text: `A new report or appeal has been saved.\n\nCase reference: ${reference}\nReview: ${origin}/abuse/operations\n\nSign in with an authorized operator account and open this reference. Report contents remain in restricted case storage. This notification confirms receipt, not an investigation result.\n`,
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
