import { createAgentPartialSaveQueue } from "../agent-partial-save-queue";

describe("Agent partial saves", () => {
  it("joins an in-flight save before continuing and deduplicates successful saves", async () => {
    const queue = createAgentPartialSaveQueue();
    let finish!: (response: { ok: boolean; status: number }) => void;
    const write = jest.fn(
      () =>
        new Promise<{ ok: boolean; status: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const first = queue.save("chat-1", "message-1", write);
    expect(queue.save("chat-1", "message-1", write)).toBe(first);
    const continued = jest.fn();
    const flush = queue.flush("chat-1").then(continued);
    await Promise.resolve();
    expect(continued).not.toHaveBeenCalled();
    finish({ ok: true, status: 200 });
    await flush;
    await queue.save("chat-1", "message-1", write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(continued).toHaveBeenCalledTimes(1);
  });

  it("retains the captured write after failure and blocks recovery until acknowledged", async () => {
    const queue = createAgentPartialSaveQueue();
    const write = jest
      .fn<Promise<{ ok: boolean; status: number }>, []>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue({ ok: true, status: 200 });
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

it.each([400, 401, 403, 413])(
  "reports terminal rejection %s without blocking subsequent recovery",
  async (status) => {
    const queue = createAgentPartialSaveQueue();
    const write = jest.fn(async () => ({ ok: false, status }));
    await queue.save("chat-1", "message-1", write);
    expect(await queue.flush("chat-1")).toBe(true);
    expect(await queue.flush("chat-1")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  },
);
it.each([408, 429, 500, 503])(
  "retries transient status %s before acknowledging progress",
  async (status) => {
    const queue = createAgentPartialSaveQueue();
    const write = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status })
      .mockResolvedValue({ ok: true, status: 200 });
    await expect(queue.save("chat-1", "message-1", write)).rejects.toThrow();
    expect(await queue.flush("chat-1")).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
  },
);
