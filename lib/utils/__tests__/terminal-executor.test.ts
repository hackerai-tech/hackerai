import { createTerminalHandler } from "../terminal-executor";

describe("createTerminalHandler", () => {
  test("does not buffer output that arrives after timeout", async () => {
    const writes: string[] = [];
    const onTimeout = jest.fn();
    const handler = createTerminalHandler(
      (output) => {
        writes.push(output);
      },
      {
        timeoutSeconds: 0.01,
        onTimeout,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    handler.stdout("late noisy output\n");

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(handler.getBufferedCharCount()).toBe(0);
    expect(handler.getFullOutput()).toBe("");

    handler.cleanup();
  });
});
