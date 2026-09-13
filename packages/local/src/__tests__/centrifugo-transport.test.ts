import {
  CentrifugoMessageReassembler,
  CentrifugoPublishQueue,
  fragmentCentrifugoMessage,
  fragmentMatchesCorrelation,
  isCentrifugoTransportFragment,
} from "../centrifugo-transport";

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("Centrifugo transport fragmentation", () => {
  it("keeps small messages backward compatible", () => {
    const message = {
      type: "stdout",
      commandId: "command-1",
      data: "hello",
    };

    expect(fragmentCentrifugoMessage(message)).toEqual([message]);
  });

  it("fragments and losslessly reassembles oversized UTF-8 messages", () => {
    const message = {
      type: "file_read_result",
      requestId: "request-1",
      path: "/tmp/large.txt",
      sizeBytes: 180_000,
      totalLines: 1,
      content: '\u0000🙂"\\'.repeat(30_000),
    };
    const fragments = fragmentCentrifugoMessage(message);

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.every(isCentrifugoTransportFragment)).toBe(true);
    expect(
      fragments.every((fragment) => byteLength(fragment) < 64 * 1024),
    ).toBe(true);
    expect(
      fragments.every(
        (fragment) =>
          isCentrifugoTransportFragment(fragment) &&
          fragment.requestId === "request-1",
      ),
    ).toBe(true);

    const reassembler = new CentrifugoMessageReassembler();
    let result: unknown = null;
    for (const fragment of [...fragments].reverse()) {
      result = reassembler.accept(fragment) ?? result;
    }

    expect(result).toEqual(message);
  });

  it("filters fragments before allocating unrelated transfers", () => {
    const [fragment] = fragmentCentrifugoMessage({
      type: "stdout",
      commandId: "command-1",
      data: "x".repeat(40 * 1024),
    });

    expect(fragmentMatchesCorrelation(fragment, "commandId", "command-1")).toBe(
      true,
    );
    expect(fragmentMatchesCorrelation(fragment, "commandId", "command-2")).toBe(
      false,
    );
    expect(fragmentMatchesCorrelation(fragment, "requestId", "request-1")).toBe(
      false,
    );
  });

  it("rejects messages that exceed the fragment-count limit", () => {
    expect(() =>
      fragmentCentrifugoMessage({
        type: "stdout",
        commandId: "command-too-large",
        data: "x".repeat(2_400_000),
      }),
    ).toThrow("maximum is 128");
  });

  it("drops new transfers after the active-transfer limit is reached", () => {
    const reassembler = new CentrifugoMessageReassembler();
    const firstFragments = Array.from({ length: 16 }, (_, index) => ({
      type: "transport_fragment" as const,
      transferId: `transfer-${index}`,
      index: 0,
      total: 2,
      data: "e3",
    }));

    for (const fragment of firstFragments) {
      expect(reassembler.accept(fragment)).toBeNull();
    }

    expect(
      reassembler.accept({
        type: "transport_fragment",
        transferId: "transfer-over-limit",
        index: 0,
        total: 2,
        data: "e3",
      }),
    ).toBeNull();
    expect(
      reassembler.accept({
        type: "transport_fragment",
        transferId: "transfer-over-limit",
        index: 1,
        total: 2,
        data: "0=",
      }),
    ).toBeNull();

    expect(
      reassembler.accept({
        type: "transport_fragment",
        transferId: "transfer-0",
        index: 1,
        total: 2,
        data: "0=",
      }),
    ).toEqual({});
  });

  it("serializes fragments and later messages in FIFO order", async () => {
    let activePublishes = 0;
    let maxActivePublishes = 0;
    const published: unknown[] = [];
    const publish = jest.fn(async (message: unknown) => {
      activePublishes += 1;
      maxActivePublishes = Math.max(maxActivePublishes, activePublishes);
      await Promise.resolve();
      published.push(message);
      activePublishes -= 1;
    });
    const queue = new CentrifugoPublishQueue(publish);

    const output = queue.publish({
      type: "stdout",
      commandId: "command-1",
      data: "x".repeat(80 * 1024),
    });
    const exit = queue.publish({
      type: "exit",
      commandId: "command-1",
      exitCode: 0,
    });

    await Promise.all([output, exit]);

    expect(maxActivePublishes).toBe(1);
    expect(isCentrifugoTransportFragment(published[published.length - 1])).toBe(
      false,
    );
    expect(published[published.length - 1]).toEqual({
      type: "exit",
      commandId: "command-1",
      exitCode: 0,
    });
  });

  it("recovers the queue after a publish rejection", async () => {
    const publish = jest
      .fn<Promise<void>, [unknown]>()
      .mockRejectedValueOnce({ code: 11, message: "connection closed" })
      .mockResolvedValue(undefined);
    const queue = new CentrifugoPublishQueue(publish);

    await expect(
      queue.publish({ type: "stdout", commandId: "command-1", data: "one" }),
    ).rejects.toThrow("connection closed");
    await expect(
      queue.publish({ type: "exit", commandId: "command-1", exitCode: 1 }),
    ).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
