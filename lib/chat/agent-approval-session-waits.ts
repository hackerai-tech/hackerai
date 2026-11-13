export type AgentApprovalSessionWaitResult<T> =
  { ok: true; output: T } | { ok: false; error?: unknown };

// Wakes this task's own pending wait after Stop or task cleanup. It carries no
// approval identity or authorization, so it can never satisfy an approval.
export const AGENT_APPROVAL_WAIT_CANCELLATION_RECORD = Object.freeze({
  type: "agent-approval-wait-cancelled",
} as const);

export type AgentApprovalWaitCancellationRecord =
  typeof AGENT_APPROVAL_WAIT_CANCELLATION_RECORD;

/** The subset of a Trigger Session `.in` channel used by approval waits. */
export type AgentApprovalSessionInput<T> = {
  wait(): PromiseLike<AgentApprovalSessionWaitResult<T>>;
  send(record: AgentApprovalWaitCancellationRecord): Promise<unknown>;
};

export type AgentApprovalSessionWaitOutcome<T> =
  | { status: "input"; result: AgentApprovalSessionWaitResult<T> }
  | { status: "closed" }
  | { status: "aborted" };

export type AgentApprovalSessionWaits = {
  waitForApprovalInput<T>(
    input: AgentApprovalSessionInput<T>,
    signal: AbortSignal,
  ): Promise<AgentApprovalSessionWaitOutcome<T>>;
  /**
   * Runs one busy-slot retry delay (a durable `wait.for`). Returns false
   * without starting it once stopped or finished.
   */
  waitForApprovalSlot(
    startDelay: () => PromiseLike<unknown>,
    signal: AbortSignal,
  ): Promise<boolean>;
  isSessionClosed(): boolean;
  isFinished(): boolean;
  finish(): Promise<void>;
};

const isCloseTrigger = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { trigger?: unknown }).trigger === "close";

// Closing a Session notifies its live run with a message envelope, which
// `in.wait()` returns unchanged: `{ kind: "message", payload: { trigger:
// "close", ... } }`. Also accept the flat `{ trigger: "close" }` record.
const isSessionCloseRecord = (value: unknown): boolean =>
  isCloseTrigger(value) ||
  (typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "message" &&
    isCloseTrigger((value as { payload?: unknown }).payload));

/**
 * Owns every approval Session wait and slot delay started by one Trigger task.
 * Each holds a run-engine waitpoint. Settle it before submitting the task
 * result so completion uses the engine's current snapshot.
 * Await `finish()` before returning from the task. A Session wait settles only
 * when a record or close arrives, so a parent that owns the Session closes it
 * first in case the wake send failed.
 */
export const createAgentApprovalSessionWaits =
  (): AgentApprovalSessionWaits => {
    const scope = new AbortController();
    const startedWaits = new Set<Promise<void>>();
    let sessionClosed = false;
    let finished: Promise<void> | undefined;

    const track = <T>(operation: Promise<T>): (() => void) => {
      const started = operation.then(
        () => undefined,
        () => undefined,
      );
      startedWaits.add(started);
      return () => startedWaits.delete(started);
    };

    const waitForApprovalSlot = async (
      startDelay: () => PromiseLike<unknown>,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (signal.aborted || scope.signal.aborted) return false;
      const delay = new Promise<unknown>((resolve) => resolve(startDelay()));
      const untrack = track(delay);
      try {
        await delay;
        return true;
      } finally {
        untrack();
      }
    };

    const waitForApprovalInput = async <T>(
      input: AgentApprovalSessionInput<T>,
      signal: AbortSignal,
    ): Promise<AgentApprovalSessionWaitOutcome<T>> => {
      if (sessionClosed) return { status: "closed" };
      if (signal.aborted || scope.signal.aborted) return { status: "aborted" };

      let aborted = false;
      const abort = () => {
        if (aborted) return;
        aborted = true;
        // Dispatch the wake now, since the run may be snapshotted at any point,
        // then keep awaiting the wait below. Never await the send: appending to
        // an already closed Session retries before failing.
        try {
          void input
            .send(AGENT_APPROVAL_WAIT_CANCELLATION_RECORD)
            .catch(() => undefined);
        } catch {
          // The original wait is still awaited below.
        }
      };
      // Listen before starting the wait so an abort raised while it registers
      // still wakes it.
      signal.addEventListener("abort", abort, { once: true });
      scope.signal.addEventListener("abort", abort, { once: true });

      const settlement = new Promise<AgentApprovalSessionWaitResult<T>>(
        (resolve) => resolve(input.wait()),
      ).then(
        (result) => ({ rejected: false as const, result }),
        (error: unknown) => ({ rejected: true as const, error }),
      );
      const untrack = track(settlement);
      try {
        const settled = await settlement;
        const closed =
          !settled.rejected &&
          settled.result.ok &&
          isSessionCloseRecord(settled.result.output);
        // The close record is consumed by this wait; later requests sharing
        // the task must not wait on the closed Session again.
        if (closed) sessionClosed = true;
        if (aborted || signal.aborted || scope.signal.aborted) {
          return { status: "aborted" };
        }
        if (settled.rejected) throw settled.error;
        if (closed) return { status: "closed" };
        return { status: "input", result: settled.result };
      } finally {
        signal.removeEventListener("abort", abort);
        scope.signal.removeEventListener("abort", abort);
        untrack();
      }
    };

    return {
      waitForApprovalInput,
      waitForApprovalSlot,
      isSessionClosed: () => sessionClosed,
      isFinished: () => scope.signal.aborted,
      finish: () => {
        finished ??= (() => {
          scope.abort();
          return Promise.all(startedWaits).then(() => undefined);
        })();
        return finished;
      },
    };
  };
