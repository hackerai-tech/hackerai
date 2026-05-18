import { describe, expect, it } from "@jest/globals";
import { sanitizeForConvexValue } from "../convex-value-sanitizer";

describe("sanitizeForConvexValue", () => {
  it("converts Error instances in tool outputs into plain objects", () => {
    const error = new Error(
      "Local sandbox disconnected. Reconnect your desktop app or upgrade to Pro for cloud sandbox.",
    ) as Error & { code?: string; statusCode?: number };
    error.code = "SANDBOX_DISCONNECTED";
    error.statusCode = 503;

    const result = sanitizeForConvexValue({
      parts: [
        { type: "step-start" },
        {
          type: "tool-run_terminal_cmd",
          state: "output-available",
          output: error,
        },
      ],
    }) as {
      parts: Array<{ output?: { error?: string; code?: string } }>;
    };

    expect(result.parts[1].output).toEqual({
      error:
        "Local sandbox disconnected. Reconnect your desktop app or upgrade to Pro for cloud sandbox.",
      name: "Error",
      message:
        "Local sandbox disconnected. Reconnect your desktop app or upgrade to Pro for cloud sandbox.",
      code: "SANDBOX_DISCONNECTED",
      statusCode: 503,
    });
    expect(result.parts[1].output).not.toBe(error);
  });

  it("handles circular references without throwing", () => {
    const value: Record<string, unknown> = { ok: true };
    value.self = value;

    expect(sanitizeForConvexValue(value)).toEqual({
      ok: true,
      self: "[Circular]",
    });
  });

  it("normalizes unsupported scalar values nested in arrays and objects", () => {
    const result = sanitizeForConvexValue({
      array: [undefined, Number.NaN, Symbol("x")],
      object: {
        keep: "yes",
        drop: undefined,
      },
    });

    expect(result).toEqual({
      array: [null, null, "Symbol(x)"],
      object: {
        keep: "yes",
      },
    });
  });

  it("converts ArrayBuffer views into sliced ArrayBuffers", () => {
    const backingBuffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const view = new Uint8Array(backingBuffer, 1, 3);
    const dataView = new DataView(backingBuffer, 2, 2);

    const result = sanitizeForConvexValue({
      view,
      dataView,
    }) as { view: ArrayBuffer; dataView: ArrayBuffer };

    expect(result.view).toBeInstanceOf(ArrayBuffer);
    expect(result.view).not.toBe(backingBuffer);
    expect([...new Uint8Array(result.view)]).toEqual([2, 3, 4]);

    expect(result.dataView).toBeInstanceOf(ArrayBuffer);
    expect(result.dataView).not.toBe(backingBuffer);
    expect([...new Uint8Array(result.dataView)]).toEqual([3, 4]);
  });
});
