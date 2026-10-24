// Native processes outlive relay connections. Keep their owners and Stop fences
// outside a bridge instance so replacing a disconnected bridge cannot lose them.
const commands = new Map<string, { chatId?: string; runId?: string }>();
const stoppedRuns = new Map<string, Set<string>>();

export function registerDesktopCommand(
  commandId: string,
  chatId?: string,
  runId?: string,
): () => void {
  const owner = { chatId, runId };
  commands.set(commandId, owner);
  return () => {
    if (commands.get(commandId) === owner) commands.delete(commandId);
  };
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
  const commandIds = [...commands]
    .filter(([, owner]) => owner.chatId === chatId && owner.runId === runId)
    .map(([id]) => id);
  if (!commandIds.length) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const results = await Promise.allSettled(
    commandIds.map(async (commandId) => {
      const canceled = await invoke<boolean>("cancel_stream_command", {
        commandId,
      });
      if (!canceled) throw new Error("Native command cancellation failed");
    }),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Could not stop every local command");
  }
}
