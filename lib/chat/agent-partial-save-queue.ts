/** Acknowledges fallback saves before a continuation loads persisted history. */
type SaveResponse = Pick<Response, "ok" | "status">;

export function createAgentPartialSaveQueue() {
  type Save = {
    chatId: string;
    write?: () => Promise<SaveResponse>;
    pending?: Promise<void>;
    settled: boolean;
    rejected: boolean;
  };
  const saves = new Map<string, Save>();
  const run = (save: Save): Promise<void> => {
    if (save.settled) return Promise.resolve();
    if (save.pending) return save.pending;
    save.pending = Promise.resolve()
      .then(save.write)
      .then((response) => {
        if (!response) throw new Error("Missing partial-save response.");
        if (
          !response.ok &&
          !(
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
          )
        ) {
          throw new Error("Could not save Agent progress.");
        }
        // Invalid/expired requests cannot be repaired by replaying their body.
        // Surface this outcome to recovery instead of blocking the chat forever.
        save.rejected = !response.ok;
        save.settled = true;
        save.write = undefined; // Release captured message content and correlation.
      })
      .finally(() => {
        save.pending = undefined;
      });
    return save.pending;
  };
  return {
    save(chatId: string, key: string, write: () => Promise<SaveResponse>) {
      let save = saves.get(key);
      if (!save) {
        save = { chatId, write, settled: false, rejected: false };
        saves.set(key, save);
      }
      return run(save);
    },
    async flush(chatId: string) {
      const chatSaves = [...saves.values()].filter(
        (save) => save.chatId === chatId,
      );
      await Promise.all(chatSaves.map(run));
      return chatSaves.some((save) => save.rejected);
    },
  };
}
