import { createAgentPartialSaveQueue } from "../agent-partial-save-queue";

describe("Agent partial saves", () => {
  it("joins an in-flight save before continuing and deduplicates successful saves", async () => {
    const queue = createAgentPartialSaveQueue();
    let finish!: () => void;
    const write = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = queue.save("chat-1", "message-1", write);
    expect(queue.save("chat-1", "message-1", write)).toBe(first);
    const continued = jest.fn();
    const flush = queue.flush("chat-1").then(continued);
    await Promise.resolve();
    expect(continued).not.toHaveBeenCalled();
    finish();
    await flush;
    await queue.save("chat-1", "message-1", write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(continued).toHaveBeenCalledTimes(1);
  });

  it("retains the captured write after failure and blocks recovery until acknowledged", async () => {
    const queue = createAgentPartialSaveQueue();
    const write = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue(undefined);
    await expect(queue.save("chat-1", "message-1", write)).rejects.toThrow(
      "offline",
    );
    await expect(queue.flush("chat-1")).rejects.toThrow("still offline");
    await queue.flush("chat-2");
    expect(write).toHaveBeenCalledTimes(2);
    await queue.flush("chat-1");
    expect(write).toHaveBeenCalledTimes(3);
  });
});
