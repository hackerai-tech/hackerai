import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
} from "@/lib/analytics/client";
import {
  DESKTOP_STREAM_CANCEL_NONCONFIRMATION_EVENT,
  DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION,
  isDesktopStreamCancelCommandId,
  isDesktopStreamCancelOwner,
  type DesktopStreamCancelCaller,
  type DesktopStreamCancelNonconfirmation,
  type DesktopStreamCancelOutcome,
} from "@/lib/analytics/desktop-stream-cancel-diagnostic";

export type { DesktopStreamCancelCaller };

type CancelInvoke = <T>(
  cmd: "cancel_stream_command",
  args: { commandId: string },
) => Promise<T>;

/** Only a Windows command with a UUID ID, registered under an identified
 * analytics owner, carries one. Each caller reports at most once. */
interface CancelReceiptScope {
  readonly owner: string;
  readonly reported: Set<DesktopStreamCancelCaller>;
}

interface DesktopCommandOwner {
  chatId?: string;
  runId?: string;
  cancelReceipt?: CancelReceiptScope;
}

/** One registration's native cancels still awaiting settlement. A later
 * registration of the same ID supersedes it for good, even if that
 * replacement is gone again before these cancels settle. */
interface PendingCancelReceipts {
  readonly entry: DesktopCommandOwner;
  inFlight: number;
  superseded: boolean;
}

// Native processes outlive relay connections. Keep their owners and Stop fences
// outside a bridge instance so replacing a disconnected bridge cannot lose them.
const commands = new Map<string, DesktopCommandOwner>();
const stoppedRuns = new Map<string, Set<string>>();
// Holds an ID only while one of its owned cancels is in flight.
const pendingReceipts = new Map<string, PendingCancelReceipts>();

/** `cancelReceiptOwner` is the identified analytics owner of a Windows
 * command at registration; any other command passes none. */
export function registerDesktopCommand(
  commandId: string,
  chatId?: string,
  runId?: string,
  cancelReceiptOwner?: string | null,
): () => void {
  const owner: DesktopCommandOwner = { chatId, runId };
  if (
    isDesktopStreamCancelOwner(cancelReceiptOwner) &&
    isDesktopStreamCancelCommandId(commandId)
  )
    owner.cancelReceipt = { owner: cancelReceiptOwner, reported: new Set() };
  const prior = pendingReceipts.get(commandId);
  if (prior) {
    prior.superseded = true;
    pendingReceipts.delete(commandId);
  }
  commands.set(commandId, owner);
  return () => {
    if (commands.get(commandId) === owner) commands.delete(commandId);
  };
}

/** Best effort and never throws. The original owner may already have
 * unregistered after ordinary settlement. */
function reportNonconfirmation(
  commandId: string,
  pending: PendingCancelReceipts,
  caller: DesktopStreamCancelCaller,
  outcome: DesktopStreamCancelOutcome,
): void {
  try {
    const scope = pending.entry.cancelReceipt;
    if (!scope || pending.superseded || scope.reported.has(caller)) return;
    const current = commands.get(commandId);
    if (current !== undefined && current !== pending.entry) return;
    scope.reported.add(caller);
    if (
      getPermittedAnalyticsUserId() !== scope.owner ||
      getIdentifiedAnalyticsUserId() !== scope.owner
    )
      return;
    const properties: DesktopStreamCancelNonconfirmation = {
      version: DESKTOP_STREAM_CANCEL_NONCONFIRMATION_VERSION,
      command_id: commandId,
      caller,
      outcome,
    };
    captureAuthenticatedEvent(
      DESKTOP_STREAM_CANCEL_NONCONFIRMATION_EVENT,
      properties,
    );
  } catch {
    // Telemetry must never affect cancellation.
  }
}

/** Track one dispatched cancel of the still-current owned registration until
 * its own promise settles. Never throws and never replaces that promise. */
function observeCancel(
  commandId: string,
  entry: DesktopCommandOwner,
  caller: DesktopStreamCancelCaller,
  result: Promise<boolean>,
): void {
  try {
    // Removed or replaced before dispatch: fail closed for telemetry.
    if (!entry.cancelReceipt || commands.get(commandId) !== entry) return;
    let pending = pendingReceipts.get(commandId);
    if (pending?.entry !== entry) {
      if (pending) pending.superseded = true;
      pending = { entry, inFlight: 0, superseded: false };
      pendingReceipts.set(commandId, pending);
    }
    const receipts = pending;
    receipts.inFlight++;
    const settle = (outcome: DesktopStreamCancelOutcome | null) => {
      try {
        if (outcome)
          reportNonconfirmation(commandId, receipts, caller, outcome);
      } finally {
        receipts.inFlight--;
        if (
          receipts.inFlight === 0 &&
          pendingReceipts.get(commandId) === receipts
        )
          pendingReceipts.delete(commandId);
      }
    };
    void Promise.resolve(result)
      .then(
        (canceled) => settle(canceled === false ? "returned_false" : null),
        () => settle("invoke_rejected"),
      )
      .catch(() => {});
  } catch {
    // Telemetry must never affect cancellation.
  }
}

function cancelWith(
  commandId: string,
  entry: DesktopCommandOwner | undefined,
  caller: DesktopStreamCancelCaller,
): (invoke: CancelInvoke) => Promise<boolean> {
  return (invoke) => {
    const result = invoke<boolean>("cancel_stream_command", { commandId });
    if (entry) observeCancel(commandId, entry, caller, result);
    return result;
  };
}

/**
 * Call synchronously, before any await, to capture the command's current
 * registration. The returned function performs the exact existing native
 * cancel and returns its own unmodified promise. An unregistered ID captures
 * nothing and never reports.
 */
export function prepareDesktopStreamCancel(
  commandId: string,
  caller: DesktopStreamCancelCaller,
): (invoke: CancelInvoke) => Promise<boolean> {
  return cancelWith(commandId, commands.get(commandId), caller);
}

export function wasDesktopRunStopped(chatId?: string, runId?: string): boolean {
  return Boolean(chatId && runId && stoppedRuns.get(chatId)?.has(runId));
}

/** Cancel the captured run through IPC without waiting for HTTP or the relay. */
export async function cancelDesktopRunLocally(
  chatId: string,
  runId: string,
): Promise<void> {
  // Retain until WebView teardown: a stopped worker may deliver commands late.
  let stopped = stoppedRuns.get(chatId);
  if (!stopped) stoppedRuns.set(chatId, (stopped = new Set()));
  stopped.add(runId);
  const cancels = [...commands]
    .filter(([, owner]) => owner.chatId === chatId && owner.runId === runId)
    .map(([id, owner]) => cancelWith(id, owner, "local_run_stop"));
  if (!cancels.length) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const results = await Promise.allSettled(
    cancels.map(async (cancel) => {
      const canceled = await cancel(invoke);
      if (!canceled) throw new Error("Native command cancellation failed");
    }),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Could not stop every local command");
  }
}
