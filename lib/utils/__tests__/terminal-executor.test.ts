import { createTerminalHandler } from "../terminal-executor";
import { safeCountTokens, TOOL_DEFAULT_MAX_TOKENS } from "@/lib/token-utils";

describe("createTerminalHandler", () => {
  test("returns bounded head/tail output after a large-output timeout", async () => {
    jest.useFakeTimers();
    const content = `start\n${"\u0001".repeat(150_000)}\nend`;
    let result:
      | ReturnType<ReturnType<typeof createTerminalHandler>["getResult"]>
      | undefined;
    const handler = createTerminalHandler(() => {}, {
      timeoutSeconds: 1,
      onTimeout: () => {
        result = handler.getResult(123, { timeoutMessage: "\npaused session" });
      },
    });
    try {
      handler.stdout(content);
      await jest.advanceTimersByTimeAsync(1000);

      expect(result?.output).toContain("start");
      expect(result?.output).toContain("end\npaused session");
      expect(safeCountTokens(result!.output!)).toBeLessThanOrEqual(
        TOOL_DEFAULT_MAX_TOKENS,
      );
      expect(handler.wasTruncated()).toBe(true);
      expect(handler.getFullOutput()).toBe(content);
    } finally {
      handler.cleanup();
      jest.useRealTimers();
    }
  });

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
