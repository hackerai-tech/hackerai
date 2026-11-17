import {
  createTerminalHandler,
  truncateTerminalOutput,
} from "../terminal-executor";
import { safeCountTokens, TOOL_DEFAULT_MAX_TOKENS } from "@/lib/token-utils";
import * as tokenUtils from "@/lib/token-utils";

jest.mock("@/lib/token-utils", () => {
  const actual = jest.requireActual("@/lib/token-utils");
  return {
    ...actual,
    safeCountTokens: jest.fn(actual.safeCountTokens),
    sliceByTokens: jest.fn(actual.sliceByTokens),
    truncateContent: jest.fn(actual.truncateContent),
  };
});

const hasLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    text,
  );

// Large outputs make Jest's string diff unreadable; compare a compact summary
// (JSON escapes lone surrogates) before exact equality.
const expectSameText = (actual: string | undefined, expected: string) => {
  const summary = (text: string) => ({
    length: text.length,
    loneSurrogate: hasLoneSurrogate(text),
    start: JSON.stringify(text.slice(0, 8)),
    end: JSON.stringify(text.slice(-8)),
  });
  expect(summary(actual ?? "")).toEqual(summary(expected));
  expect(actual === expected).toBe(true);
};

describe("truncateTerminalOutput", () => {
  // The tokenizer-bound preview keeps 25% head and 75% tail of this budget.
  const contentChars = 128 * 1024 - tokenUtils.TRUNCATION_MESSAGE.length;
  const headChars = Math.floor(contentChars * 0.25);
  const tailChars = contentChars - headChars;

  test("keeps exact ASCII head and tail sizes in the 128KiB preview", () => {
    const content = "h" + " ".repeat(200_000) + "t";

    expectSameText(
      truncateTerminalOutput(content).output,
      "h" +
        " ".repeat(headChars - 1) +
        tokenUtils.TRUNCATION_MESSAGE +
        " ".repeat(tailChars - 1) +
        "t",
    );
  });

  test("omits a pair the head cut would split", () => {
    const content = " ".repeat(headChars - 1) + "😀" + " ".repeat(200_000);

    expectSameText(
      truncateTerminalOutput(content).output,
      " ".repeat(headChars - 1) +
        tokenUtils.TRUNCATION_MESSAGE +
        " ".repeat(tailChars),
    );
  });

  test("omits a pair the tail cut would split", () => {
    const content = " ".repeat(200_000) + "😀" + " ".repeat(tailChars - 1);

    expectSameText(
      truncateTerminalOutput(content).output,
      " ".repeat(headChars) +
        tokenUtils.TRUNCATION_MESSAGE +
        " ".repeat(tailChars - 1),
    );
  });
});

describe("createTerminalHandler", () => {
  test("bounds tokenizer input for a huge chunk and final result while preserving saved output", async () => {
    const count = jest.mocked(tokenUtils.safeCountTokens);
    const slice = jest.mocked(tokenUtils.sliceByTokens);
    const truncate = jest.mocked(tokenUtils.truncateContent);
    const content = `start\n${"\u0001".repeat(2 * 1024 * 1024)}\nend`;
    const writes: string[] = [];
    const handler = createTerminalHandler((output) => {
      writes.push(output);
    });
    try {
      handler.stdout(content);
      // The transport callback is void; allow the preview and marker writes to finish.
      await Promise.resolve();
      await Promise.resolve();
      const result = handler.getResult();
      expect(handler.getFullOutput()).toBe(content);
      expect(handler.wasFullOutputCapped()).toBe(false);
      expect(handler.wasTruncated()).toBe(true);
      expect(writes.join("")).toContain(tokenUtils.TRUNCATION_MESSAGE);
      expect(result.output).toContain("start");
      expect(result.output).toContain("end");
      expect(safeCountTokens(result.output!)).toBeLessThanOrEqual(
        TOOL_DEFAULT_MAX_TOKENS,
      );
      for (const spy of [count, slice, truncate]) {
        expect(spy).toHaveBeenCalled();
        expect(
          Math.max(...spy.mock.calls.map(([input]) => input.length)),
        ).toBeLessThanOrEqual(128 * 1024);
      }
    } finally {
      handler.cleanup();
    }
  });

  test("marks the character cap even when whitespace fits the token budget", async () => {
    const content = " ".repeat(200_000);
    const writes: string[] = [];
    const handler = createTerminalHandler((output) => {
      writes.push(output);
    });
    try {
      handler.stdout(content);
      await Promise.resolve();
      await Promise.resolve();
      expect(handler.wasTruncated()).toBe(true);
      expect(writes.join("")).toContain(tokenUtils.TRUNCATION_MESSAGE);
      expect(truncateTerminalOutput(content).output).toContain(
        tokenUtils.TRUNCATION_MESSAGE,
      );
      expect(handler.getFullOutput()).toBe(content);
    } finally {
      handler.cleanup();
    }
  });

  test("preserves short Unicode output without truncation", () => {
    const content = "結果: café 🐛\n";
    const writes: string[] = [];
    const handler = createTerminalHandler((output) => {
      writes.push(output);
    });
    handler.stdout(content);
    expect(writes).toEqual([content]);
    expect(handler.getResult().output).toBe(content);
    expect(handler.wasTruncated()).toBe(false);
    handler.cleanup();
  });

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

  test("streams a 128KiB preview without splitting a surrogate pair", async () => {
    const previewChars = 128 * 1024;
    const kept = "x" + " ".repeat(previewChars - 2);
    const writes: string[] = [];
    const handler = createTerminalHandler((output) => {
      writes.push(output);
    });
    try {
      handler.stdout(kept + "😀 after");
      await Promise.resolve();
      await Promise.resolve();

      expect(writes).toHaveLength(2);
      expectSameText(writes[0], kept);
      expect(writes[1]).toBe(tokenUtils.TRUNCATION_MESSAGE);
    } finally {
      handler.cleanup();
    }
  });

  test("caps the saved buffer before a pair that would cross 5MiB", async () => {
    const maxChars = 5 * 1024 * 1024;
    const first = "a" + " ".repeat(maxChars - 2);
    const handler = createTerminalHandler(() => {});
    try {
      handler.stdout(first);
      handler.stdout("😀 after the cap");
      await Promise.resolve();
      await Promise.resolve();

      expect(handler.wasFullOutputCapped()).toBe(true);
      expectSameText(handler.getFullOutput(), first);
      expect(handler.getBufferedCharCount()).toBe(first.length);
    } finally {
      handler.cleanup();
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
