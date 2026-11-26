import { AGENT_LOCAL_AUTO_CONTINUE_ENDPOINT } from "@/lib/api/agent-endpoints";

/**
 * Delays between reports of one return. The worker records a stop a few
 * seconds after its recovery window ends, so a return at that moment can
 * arrive first; the later reports cover it. The server is idempotent.
 */
export const DESKTOP_RETURN_REPORT_DELAYS_MS = [
  0, 3_000, 10_000, 30_000, 60_000,
] as const;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Tells the server when this page's Desktop bridge is connected again after
 * an outage, so a run that outage stopped can continue once (HAC-275). It
 * only reports; the server decides. State lives for the page: a reload or a
 * relaunch is a new native session no stop can match, so the page's first
 * connection is never reported.
 */
export function createDesktopReturnReporter({
  report,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (timer) => clearTimeout(timer),
}: {
  report: (connectionId: string) => Promise<unknown>;
  schedule?: (run: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
}) {
  let connectedBefore = false;
  let interrupted = false;
  let timers: Timer[] = [];
  const stopReporting = () => {
    for (const timer of timers) cancel(timer);
    timers = [];
  };
  return {
    /** Every bridge connection state, with the connection it belongs to. */
    onState(state: string, connectionId: string | null | undefined) {
      if (state !== "connected") {
        if (connectedBefore) interrupted = true;
        // The server may still list the old connection as connected; a
        // report now could claim a stop while this computer is away.
        stopReporting();
        return;
      }
      if (!connectedBefore) {
        connectedBefore = true;
        return;
      }
      if (!interrupted || !connectionId) return;
      interrupted = false;
      stopReporting();
      timers = DESKTOP_RETURN_REPORT_DELAYS_MS.map((delay) =>
        schedule(() => {
          void report(connectionId).catch(() => undefined);
        }, delay),
      );
    },
    /** The bridge ended; its replacement's connection is a return. */
    onTerminated() {
      if (connectedBefore) interrupted = true;
      stopReporting();
    },
    /** Sign-out: nothing from this account may be reported for the next. */
    reset() {
      connectedBefore = false;
      interrupted = false;
      stopReporting();
    },
  };
}

export async function reportDesktopReturn(connectionId: string) {
  const response = await fetch(AGENT_LOCAL_AUTO_CONTINUE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "return", connectionId }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Return report failed: ${response.status}`);
}

const CANCEL_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export class LocalAutoContinueCancelError extends Error {
  constructor() {
    super("The automatic continuation could not be cancelled.");
    this.name = "LocalAutoContinueCancelError";
  }
}

/**
 * The user acted first in this chat; nothing may continue automatically.
 * Resolves only once the server stored that. Network failures and 5xx
 * responses retry briefly; then it rejects, so the caller can tell the user
 * and offer a retry. A 4xx is a final refusal. Each call is one user action:
 * its retries share one ID, so the server applies the action once and a
 * retry cannot block a run the user started after acting.
 */
export async function cancelLocalAutoContinue(
  chatId: string,
  reason: "environment_switched" | "user_stop",
  { sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<void> {
  const actionId = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    const status = await fetch(AGENT_LOCAL_AUTO_CONTINUE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel", chatId, reason, actionId }),
      cache: "no-store",
    }).then(
      (response) => response.status,
      () => undefined,
    );
    if (status !== undefined && status >= 200 && status < 300) return;
    const retryable = status === undefined || status >= 500;
    const delay = CANCEL_RETRY_DELAYS_MS[attempt];
    if (!retryable || delay === undefined)
      throw new LocalAutoContinueCancelError();
    await sleep(delay);
  }
}
