import { waitForAgentUiStream } from "../consume-agent-ui-stream";

describe("Agent realtime stream completion", () => {
  it("discards the local copy without changing remote records or bypassing delivery confirmation", async () => {
    const chunks = [
      { type: "reasoning-delta", delta: "reasoning" },
      { type: "tool-output-available", output: { result: "saved" } },
      { type: "abort" },
    ];
    const source = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const [remote, local] = source.tee();
    const received: unknown[] = [];
    const delivered = (async () => {
      for await (const chunk of remote) received.push(chunk);
    })();
    let confirmDelivery!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      confirmDelivery = resolve;
    });
    let completed = false;
    const completion = waitForAgentUiStream({
      stream: local,
      waitUntilComplete: async () => {
        await delivered;
        await confirmation;
      },
    }).then(() => {
      completed = true;
    });

    await delivered;
    expect(received).toEqual(chunks);
    expect(completed).toBe(false);
    confirmDelivery();
    await completion;

    const reader = local.getReader();
    try {
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } finally {
      reader.releaseLock();
    }
  });

  it("does not retain a long local stream after the remote writer finishes", async () => {
    let produced = 0;
    const source = new ReadableStream({
      pull(controller) {
        if (produced === 1_000) {
          controller.close();
          return;
        }
        controller.enqueue({ sequence: produced++, delta: "x".repeat(1_024) });
      },
    });
    const [remote, local] = source.tee();
    let received = 0;
    const delivered = (async () => {
      for await (const chunk of remote) {
        expect(chunk.sequence).toBe(received++);
      }
    })();

    await waitForAgentUiStream({
      stream: local,
      waitUntilComplete: () => delivered,
    });
    expect(received).toBe(1_000);
    const reader = local.getReader();
    try {
      expect((await reader.read()).done).toBe(true);
    } finally {
      reader.releaseLock();
    }
  });

  it("preserves a remote transport failure", async () => {
    const error = new Error("remote transport failed");
    await expect(
      waitForAgentUiStream({
        stream: new ReadableStream({
          start: (controller) => controller.close(),
        }),
        waitUntilComplete: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it("does not turn a local stream error into successful completion", async () => {
    const error = new Error("local stream failed");
    await expect(
      waitForAgentUiStream({
        stream: new ReadableStream({
          start: (controller) => controller.error(error),
        }),
        waitUntilComplete: async () => undefined,
      }),
    ).rejects.toBe(error);
  });
});
