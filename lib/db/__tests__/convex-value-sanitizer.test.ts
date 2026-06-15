import { describe, expect, it } from "@jest/globals";
import { sanitizeForConvexValue } from "../convex-value-sanitizer";

const expectConvexCompatibleFieldNames = (value: unknown) => {
  if (!value || typeof value !== "object" || value instanceof ArrayBuffer) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(expectConvexCompatibleFieldNames);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expect(key.length).toBeLessThanOrEqual(1024);
    expect(key.startsWith("$")).toBe(false);
    for (let i = 0; i < key.length; i++) {
      const charCode = key.charCodeAt(i);
      expect(charCode).toBeGreaterThanOrEqual(32);
      expect(charCode).toBeLessThan(127);
    }
    expectConvexCompatibleFieldNames(child);
  }
};

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

  it("handles circular Error causes without throwing", () => {
    const first = new Error("first") as Error & { cause?: unknown };
    const second = new Error("second") as Error & { cause?: unknown };
    first.cause = second;
    second.cause = first;

    expect(sanitizeForConvexValue(first)).toEqual({
      error: "first",
      name: "Error",
      message: "first",
      cause: {
        error: "second",
        name: "Error",
        message: "second",
        cause: {
          error: "[Circular]",
          name: "Error",
          message: "[Circular]",
        },
      },
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

  it("keeps only Convex-compatible bigint values as bigint", () => {
    expect(sanitizeForConvexValue(-(1n << 63n))).toBe(-(1n << 63n));
    expect(sanitizeForConvexValue((1n << 63n) - 1n)).toBe((1n << 63n) - 1n);
    expect(sanitizeForConvexValue(1n << 63n)).toBe("9223372036854775808");
    expect(sanitizeForConvexValue(-(1n << 63n) - 1n)).toBe(
      "-9223372036854775809",
    );
  });

  it("normalizes invalid Date instances without throwing", () => {
    expect(sanitizeForConvexValue(new Date("2026-05-18T12:00:00.000Z"))).toBe(
      "2026-05-18T12:00:00.000Z",
    );
    expect(sanitizeForConvexValue(new Date(Number.NaN))).toBeNull();
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

  it("renames object fields Convex cannot persist", () => {
    const commandKey = `command'"cat > /tmp/patch3.py << 'PY'\nprint("hi")`;
    const longNonAsciiKey = `action_check_${"quietly_".repeat(140)}针头`;

    const result = sanitizeForConvexValue({
      parts: [
        {
          type: "tool-run_terminal_cmd",
          input: {
            [commandKey]: "echo hi",
            $reserved: true,
            [longNonAsciiKey]: "kept",
            command: "still exact",
          },
        },
      ],
    }) as {
      parts: Array<{
        input: Record<
          string,
          string | boolean | Array<{ storedKey: string; originalKey: string }>
        >;
      }>;
    };

    expectConvexCompatibleFieldNames(result);

    const input = result.parts[0].input;
    expect(input.command).toBe("still exact");

    const renamedFields = input._convex_renamed_fields as Array<{
      storedKey: string;
      originalKey: string;
    }>;
    expect(renamedFields).toHaveLength(3);

    const commandRename = renamedFields.find(
      (field) => field.originalKey === commandKey,
    );
    expect(commandRename?.storedKey).toMatch(/^field_command_/);
    expect(input[commandRename!.storedKey]).toBe("echo hi");

    const reservedRename = renamedFields.find(
      (field) => field.originalKey === "$reserved",
    );
    expect(input[reservedRename!.storedKey]).toBe(true);

    const longRename = renamedFields.find((field) =>
      field.originalKey.startsWith("action_check_"),
    );
    expect(longRename?.storedKey.length).toBeLessThanOrEqual(200);
    expect(longRename?.originalKey.endsWith("...")).toBe(true);
    expect(input[longRename!.storedKey]).toBe("kept");
  });

  it("keeps sanitizer metadata on a stable key", () => {
    const result = sanitizeForConvexValue({
      _convex_renamed_fields: "user payload",
      $reserved: true,
    }) as Record<string, unknown>;

    expectConvexCompatibleFieldNames(result);

    const renamedFields = result._convex_renamed_fields as Array<{
      storedKey: string;
      originalKey: string;
    }>;
    expect(renamedFields).toHaveLength(2);

    const reservedRename = renamedFields.find(
      (field) => field.originalKey === "$reserved",
    );
    expect(result[reservedRename!.storedKey]).toBe(true);

    const userMetadataRename = renamedFields.find(
      (field) => field.originalKey === "_convex_renamed_fields",
    );
    expect(userMetadataRename?.storedKey).toMatch(
      /^field_convex_renamed_fields_/,
    );
    expect(result[userMetadataRename!.storedKey]).toBe("user payload");
    expect(result._convex_renamed_fields_1).toBeUndefined();
  });
});
