import {
  classifyNativeTerminalError,
  readDesktopTerminalErrorDiagnostic,
} from "../desktop-terminal-error-diagnostics";

describe("classifyNativeTerminalError", () => {
  it.each<[unknown, string]>([
    ["Command timed out after 30000ms", "native_command_timeout"],
    ["Command timed out after 0ms", "native_command_timeout"],
    ["Process error: PRIVATE os error 5", "native_process_error"],
    ["Process error: ", "native_process_error"],
    // Anything but the exact fixed templates is unknown, never guessed.
    ["Command timed out after ms", "native_other"],
    ["Command timed out after -1ms", "native_other"],
    ["Command timed out after 1.5ms", "native_other"],
    ["Command timed out after 30000ms PRIVATE", "native_other"],
    ["Command timed out after 30000ms\n", "native_other"],
    ["PRIVATE Command timed out after 30000ms", "native_other"],
    [`Command timed out after ${"9".repeat(21)}ms`, "native_other"],
    ["command timed out after 30000ms", "native_other"],
    [" Process error: PRIVATE", "native_other"],
    ["Process error PRIVATE", "native_other"],
    ["Failed to spawn: PRIVATE", "native_other"],
    ["", "native_other"],
    [undefined, "native_other"],
    [{ toString: () => "Process error: PRIVATE" }, "native_other"],
  ])("classifies %p as %s", (message, kind) => {
    expect(classifyNativeTerminalError(message)).toBe(kind);
  });
});

describe("readDesktopTerminalErrorDiagnostic", () => {
  const group = {
    desktop_terminal_error_diagnostic_version: 1,
    desktop_terminal_error_kind: "native_process_error",
  };

  it("copies only the complete group's data values", () => {
    const read = readDesktopTerminalErrorDiagnostic({
      ...group,
      message: "PRIVATE",
    });
    expect(read).toEqual(group);
    expect(Object.isFrozen(read)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["no source", undefined],
    ["a string source", "PRIVATE"],
    ["an empty bag", {}],
    ["a partial group", { desktop_terminal_error_kind: "native_other" }],
    [
      "a version without its kind",
      { desktop_terminal_error_diagnostic_version: 1 },
    ],
    [
      "an unsupported version",
      { ...group, desktop_terminal_error_diagnostic_version: 2 },
    ],
    [
      "a string version",
      { ...group, desktop_terminal_error_diagnostic_version: "1" },
    ],
    ["a private kind", { ...group, desktop_terminal_error_kind: "PRIVATE" }],
    [
      "a raw native message as kind",
      { ...group, desktop_terminal_error_kind: "Command timed out after 1ms" },
    ],
    [
      "an inherited group",
      Object.create(group as object) as Record<string, unknown>,
    ],
  ])("reads nothing for %s", (_case, source) => {
    expect(readDesktopTerminalErrorDiagnostic(source)).toBeNull();
  });

  it("never runs an accessor and survives a throwing proxy", () => {
    let reads = 0;
    const accessor = { ...group };
    Object.defineProperty(accessor, "desktop_terminal_error_kind", {
      enumerable: true,
      get() {
        reads++;
        return "native_other";
      },
    });
    expect(readDesktopTerminalErrorDiagnostic(accessor)).toBeNull();
    expect(reads).toBe(0);
    const fail = () => {
      throw new Error("PRIVATE");
    };
    expect(
      readDesktopTerminalErrorDiagnostic(
        new Proxy(
          { ...group },
          { get: fail, getOwnPropertyDescriptor: fail, ownKeys: fail },
        ),
      ),
    ).toBeNull();
  });
});
