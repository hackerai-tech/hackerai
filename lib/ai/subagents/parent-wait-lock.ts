const parentWaitTails = new Map<string, Promise<void>>();

export const serializeSubagentWaitForParent = async <T>(
  parentTriggerRunId: string,
  wait: () => Promise<T>,
): Promise<T> => {
  const previous = parentWaitTails.get(parentTriggerRunId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  parentWaitTails.set(parentTriggerRunId, tail);

  await previous.catch(() => undefined);
  try {
    return await wait();
  } finally {
    release();
    if (parentWaitTails.get(parentTriggerRunId) === tail) {
      parentWaitTails.delete(parentTriggerRunId);
    }
  }
};
