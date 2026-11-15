import {
  classifyToolOutcome,
  ToolFailureRecovery,
} from "../tool-failure-recovery";

const call = (id: string, toolName: string, input: unknown) => ({
  toolCallId: id,
  toolName,
  input,
});
const edit = { action: "edit", path: "/tmp/fixture/app.conf" };

// Envelopes mirror the actual returns in lib/ai/tools/file.ts and
// lib/ai/tools/run-terminal-cmd.ts.
describe("classifyToolOutcome", () => {
  it.each<[string, unknown, unknown, string]>([
    ["file", edit, { error: "find string not found" }, "failed"],
    [
      "file",
      { action: "write" },
      { error: "text is required", executionOutcome: "not_executed" },
      "failed",
    ],
    ["file", { action: "write" }, "File written: /tmp/fixture", "progress"],
    [
      "file_write",
      { action: "append" },
      { content: "File appended: /tmp/fixture", originalContent: "" },
      "progress",
    ],
    ["file_edit", {}, { content: "Multi-edit completed" }, "progress"],
    // Output text is data, never a failure marker.
    [
      "file",
      { action: "read" },
      {
        content: "Error: build failed",
        originalContent: "Error: build failed",
      },
      "succeeded",
    ],
    [
      "file",
      { action: "view" },
      { action: "view", content: "Viewing image file: fixture.png" },
      "succeeded",
    ],
    // Unrecognized success shapes are not evidence of a landed change.
    ["file", { action: "write" }, {}, "unknown"],
    ["file", { action: "read" }, "File written: /tmp/fixture", "unknown"],
    ["file", {}, "File written: /tmp/fixture", "unknown"],
    [
      "file",
      { action: "write" },
      { error: "Denied", approvalDenied: true },
      "unknown",
    ],
    [
      "run_terminal_cmd",
      {},
      { result: { status: "completed", exitCode: 0, output: "Error: x" } },
      "progress",
    ],
    // Contradictory process state is not trusted either way.
    [
      "run_terminal_cmd",
      {},
      { result: { status: "failed", exitCode: 0 } },
      "unknown",
    ],
    [
      "run_terminal_cmd",
      {},
      { result: { output: "running", exitCode: null } },
      "unknown",
    ],
    [
      "run_terminal_cmd",
      {},
      { result: { status: "completed", exitCode: 2 } },
      "unknown",
    ],
    ["run_terminal_cmd", {}, { result: { exitCode: 1.5 } }, "unknown"],
    // An interactive PTY that finished during launch reports `exited`.
    [
      "run_terminal_cmd",
      { interactive: true },
      {
        result: {
          pid: 7,
          output: "Error: build failed",
          sessionSnapshot: "Error: build failed",
          exited: { exitCode: 2 },
        },
      },
      "failed",
    ],
    [
      "run_terminal_cmd",
      { interactive: true },
      { result: { pid: 7, output: "ok", exited: { exitCode: 0 } } },
      "progress",
    ],
    [
      "run_terminal_cmd",
      { interactive: true },
      { result: { pid: 7, output: "Error: x", session: "pty-1" } },
      "unknown",
    ],
    [
      "run_terminal_cmd",
      { interactive: true },
      { result: { pid: 7, exited: { exitCode: null } } },
      "unknown",
    ],
    [
      "run_terminal_cmd",
      { interactive: true },
      { result: { pid: 7, exited: { exitCode: 130 } } },
      "unknown",
    ],
    [
      "run_terminal_cmd",
      {},
      { result: { exitCode: 0, exited: { exitCode: 1 } } },
      "unknown",
    ],
    ["run_terminal_cmd", {}, { result: { exited: 2 } }, "unknown"],
    ["run_terminal_cmd", {}, "Error: command failed", "unknown"],
    ["web_search", {}, { error: "upstream failure" }, "unknown"],
  ])("classifies %s %j -> %j as %s", (toolName, input, output, expected) => {
    expect(classifyToolOutcome({ toolName, input }, output)).toBe(expected);
  });
});

describe("ToolFailureRecovery", () => {
  it("counts parallel failures per tool and keeps tools independent", () => {
    const recovery = new ToolFailureRecovery();
    const failed = { error: "Cannot edit missing file" };
    expect(
      recovery.observe(
        [
          call("a", "file", edit),
          call("b", "run_terminal_cmd", {}),
          call("c", "file", edit),
        ],
        [
          { toolCallId: "a", output: failed },
          { toolCallId: "b", output: { result: { exitCode: 1 } } },
          { toolCallId: "c", output: failed },
        ],
        { armNotice: true },
      ),
    ).toBeUndefined();
    expect(
      recovery.observe(
        [call("d", "file", edit)],
        [{ toolCallId: "d", output: failed }],
        { armNotice: true },
      ),
    ).toEqual({ toolName: "file", failureCount: 3 });
  });

  it("treats an oversized step as a gap before matching its results", () => {
    const recovery = new ToolFailureRecovery();
    const observeFailures = (ids: string[]) =>
      recovery.observe(
        ids.map((id) => call(id, "run_terminal_cmd", {})),
        ids.map((id) => ({
          toolCallId: id,
          output: { result: { exitCode: 2 } },
        })),
        { armNotice: true },
      );
    observeFailures(["a", "b"]);
    expect(
      observeFailures(Array.from({ length: 65 }, (_, index) => `big-${index}`)),
    ).toBeUndefined();
    expect(observeFailures(["c", "d"])).toBeUndefined();
    expect(observeFailures(["e"])).toEqual({
      toolName: "run_terminal_cmd",
      failureCount: 3,
    });
  });

  it("lets a successful read of the same tool clear its pending notice", () => {
    const recovery = new ToolFailureRecovery();
    const failures = ["a", "b", "c"].map((id) => call(id, "file", edit));
    recovery.observe(
      failures,
      failures.map(({ toolCallId }) => ({
        toolCallId,
        output: { error: "File is empty." },
      })),
      { armNotice: true },
    );
    expect(recovery.getPendingNotice()).toEqual({
      toolName: "file",
      failureCount: 3,
    });
    recovery.observe(
      [call("read", "file", { action: "read", path: "/tmp/fixture" })],
      [
        {
          toolCallId: "read",
          output: { content: "1|fixture", originalContent: "fixture" },
        },
      ],
      { armNotice: true },
    );
    expect(recovery.getPendingNotice()).toBeUndefined();
  });
});
