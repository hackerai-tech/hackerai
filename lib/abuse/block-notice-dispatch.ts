import { spawn } from "node:child_process";
import { api } from "@/convex/_generated/api";
import {
  BLOCK_NOTICE_TEMPLATE_VERSION,
  type NoticeResult,
} from "@/lib/abuse/egress-outcomes";
import { buildBlockNotice } from "@/lib/abuse/egress-enforcement";

// Local dispatcher for automated block notices. It claims one notice at a time
// from the expected deployment, resolves the exact account's verified address
// inside this process, hands one fixed message to the local mail helper over a
// stdio pipe, and acknowledges the result. Its receipts carry only case
// references, Message-IDs and closed enums: never an account ID or address.

/** Stop before the five-minute lease ends; the helper itself times out first. */
const LEASE_SAFETY_MS = 2 * 60_000;
export const HELPER_TIMEOUT_MS = 90_000;
const MAX_HELPER_OUTPUT = 4_096;
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export type DispatcherConvex = {
  mutation: (reference: unknown, args: Record<string, unknown>) => Promise<any>;
  query: (reference: unknown, args: Record<string, unknown>) => Promise<any>;
};

export type Recipient =
  | { status: "verified"; email: string }
  /** No user, a different user, or no verified address: never sent. */
  | { status: "unavailable" }
  /** The directory could not be reached; safe to retry. */
  | { status: "error" };

export type OutgoingNotice = {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
};

export type DispatchDeps = {
  convex: DispatcherConvex;
  serviceKey: string;
  resolveRecipient: (userId: string) => Promise<Recipient>;
  send: (notice: OutgoingNotice) => Promise<NoticeResult>;
  newLeaseToken: () => string;
  now: () => number;
};

export type DispatchReceipt = {
  status: "disabled" | "idle" | "processed";
  notices: Array<{
    reference: string;
    messageId: string;
    result: NoticeResult | "not_attempted";
    /** `stale` or `unconfirmed` means the backend kept the safe state. */
    ack: "recorded" | "stale" | "unconfirmed";
  }>;
};

/**
 * WorkOS is the source of the exact account's address. Only a verified
 * address of the same user ID is accepted; a lookup failure is retryable and
 * a missing or unverified user is never sent.
 */
export function workosRecipientResolver(workos: {
  userManagement: {
    getUser: (id: string) => Promise<{
      id: string;
      email: string;
      emailVerified: boolean;
    }>;
  };
}) {
  return async (userId: string): Promise<Recipient> => {
    try {
      const user = await workos.userManagement.getUser(userId);
      return user.id === userId &&
        user.emailVerified === true &&
        EMAIL.test(user.email)
        ? { status: "verified", email: user.email }
        : { status: "unavailable" };
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      return status === 404 ? { status: "unavailable" } : { status: "error" };
    }
  };
}

export async function dispatchNotices(
  deps: DispatchDeps,
  max = 5,
): Promise<DispatchReceipt> {
  const notices: DispatchReceipt["notices"] = [];
  for (let index = 0; index < max; index++) {
    const leaseToken = deps.newLeaseToken();
    const claimed = await deps.convex.mutation(api.abuseBlockNotices.claim, {
      serviceKey: deps.serviceKey,
      leaseToken,
    });
    if (claimed.status === "disabled")
      return { status: notices.length ? "processed" : "disabled", notices };
    if (claimed.status !== "claimed") break;
    const notice = claimed.notice;
    const ack = async (result: NoticeResult) => {
      try {
        const recorded = await deps.convex.mutation(api.abuseBlockNotices.ack, {
          serviceKey: deps.serviceKey,
          noticeId: notice.noticeId,
          leaseToken,
          result,
        });
        return recorded.outcome as "recorded" | "stale";
      } catch {
        // The lease expires into `uncertain`; nothing is resent automatically.
        return "unconfirmed" as const;
      }
    };
    const within = () => deps.now() < notice.leaseExpiresAt - LEASE_SAFETY_MS;
    const record = async (
      result: NoticeResult,
      attempted = result !== "not_sent",
    ) => {
      notices.push({
        reference: notice.reference,
        messageId: notice.messageId,
        result: attempted ? result : "not_attempted",
        ack: await ack(result),
      });
    };
    if (notice.templateVersion !== BLOCK_NOTICE_TEMPLATE_VERSION) {
      // A newer backend; this dispatcher must be updated before sending.
      await record("not_sent", false);
      break;
    }
    const recipient = await deps.resolveRecipient(notice.userId);
    if (recipient.status !== "verified") {
      await record(
        recipient.status === "unavailable"
          ? "recipient_unavailable"
          : "not_sent",
        false,
      );
      continue;
    }
    if (!within()) {
      await record("not_sent", false);
      continue;
    }
    const stillActive = await deps.convex
      .query(api.abuseBlockNotices.confirmClaim, {
        serviceKey: deps.serviceKey,
        noticeId: notice.noticeId,
        leaseToken,
      })
      .catch(() => false);
    if (stillActive !== true || !within()) {
      await record("not_sent", false);
      continue;
    }
    const message = buildBlockNotice({
      reference: notice.reference,
      blockedAt: notice.blockedAt,
    });
    let result: NoticeResult;
    try {
      result = await deps.send({
        messageId: notice.messageId,
        from: message.from,
        to: recipient.email,
        subject: message.subject,
        text: message.text,
      });
    } catch {
      result = "uncertain";
    }
    await record(result);
  }
  return { status: notices.length ? "processed" : "idle", notices };
}

const HELPER_RESULTS = new Set<NoticeResult>([
  "sent",
  "not_sent",
  "rejected",
  "uncertain",
]);

/**
 * Runs the local mail helper with one JSON message on stdin and reads one
 * JSON result from stdout. The child gets no inherited secrets, and the
 * address travels only through the pipe. Anything other than a well-formed
 * result after the message was handed over is `uncertain`.
 */
export function stdioMailSender(helper: {
  python: string;
  script: string;
  bridgeDir: string;
  timeoutMs?: number;
}) {
  return (notice: OutgoingNotice) =>
    new Promise<NoticeResult>((resolve) => {
      let settled = false;
      const finish = (result: NoticeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = spawn(
        helper.python,
        ["-I", "-B", helper.script, "--bridge-dir", helper.bridgeDir],
        {
          stdio: ["pipe", "pipe", "ignore"],
          // Deliberately minimal: no inherited credentials reach the child.
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: process.env.HOME ?? "",
          } as unknown as NodeJS.ProcessEnv,
        },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish("uncertain");
      }, helper.timeoutMs ?? HELPER_TIMEOUT_MS);
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > MAX_HELPER_OUTPUT) child.kill("SIGKILL");
      });
      // A child that cannot start never received the message.
      child.on("error", () => finish("not_sent"));
      child.on("close", () => {
        try {
          const parsed = JSON.parse(output.trim()) as { result?: unknown };
          finish(
            HELPER_RESULTS.has(parsed.result as NoticeResult)
              ? (parsed.result as NoticeResult)
              : "uncertain",
          );
        } catch {
          finish("uncertain");
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify({ version: 1, ...notice }));
    });
}

export async function noticeSummary(deps: {
  convex: DispatcherConvex;
  serviceKey: string;
}) {
  return deps.convex.query(api.abuseBlockNotices.summary, {
    serviceKey: deps.serviceKey,
  });
}
