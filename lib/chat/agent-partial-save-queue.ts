/** Acknowledges fallback saves before a continuation loads persisted history. */
export function createAgentPartialSaveQueue() {
  type Save = {
    chatId: string;
    write?: () => Promise<void>;
    pending?: Promise<void>;
    saved: boolean;
  };
  const saves = new Map<string, Save>();
  const run = (save: Save): Promise<void> => {
    if (save.saved) return Promise.resolve();
    if (save.pending) return save.pending;
    save.pending = Promise.resolve()
      .then(save.write)
      .then(() => {
        save.saved = true;
        save.write = undefined; // Release captured message content and correlation.
      })
      .finally(() => {
        save.pending = undefined;
      });
    return save.pending;
  };
  return {
    save(chatId: string, key: string, write: () => Promise<void>) {
      let save = saves.get(key);
      if (!save) {
        save = { chatId, write, saved: false };
        saves.set(key, save);
      }
      return run(save);
    },
    async flush(chatId: string) {
      await Promise.all(
        [...saves.values()].filter((save) => save.chatId === chatId).map(run),
      );
    },
  };
}
