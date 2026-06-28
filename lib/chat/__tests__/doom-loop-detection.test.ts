import { describe, it, expect } from "@jest/globals";
import {
  createStepFingerprint,
  detectDoomLoop,
  generateDoomLoopNudge,
  DOOM_LOOP_WARNING_THRESHOLD,
  DOOM_LOOP_HALT_THRESHOLD,
  EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD,
  EMPTY_RUN_TERMINAL_CMD_INPUT_WARNING_THRESHOLD,
} from "../doom-loop-detection";

function makeStep(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return { toolCalls };
}

describe("createStepFingerprint", () => {
  it("returns sentinel for steps with no tool calls", () => {
    expect(createStepFingerprint(makeStep([]))).toBe("__no_tools__");
  });

  it("returns consistent fingerprint for same tool call", () => {
    const step = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    expect(createStepFingerprint(step)).toBe(createStepFingerprint(step));
  });

  it("sorts tool calls by name for deterministic fingerprint", () => {
    const step1 = makeStep([
      { toolName: "b_tool", input: {} },
      { toolName: "a_tool", input: {} },
    ]);
    const step2 = makeStep([
      { toolName: "a_tool", input: {} },
      { toolName: "b_tool", input: {} },
    ]);
    expect(createStepFingerprint(step1)).toBe(createStepFingerprint(step2));
  });

  it("different args produce different fingerprints", () => {
    const step1 = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const step2 = makeStep([{ toolName: "file", input: { path: "/b.txt" } }]);
    expect(createStepFingerprint(step1)).not.toBe(createStepFingerprint(step2));
  });

  it("ignores brief field when fingerprinting", () => {
    const step1 = makeStep([
      {
        toolName: "file",
        input: { action: "read", path: "/a.txt", brief: "Read the file" },
      },
    ]);
    const step2 = makeStep([
      {
        toolName: "file",
        input: {
          action: "read",
          path: "/a.txt",
          brief: "Retry reading the file",
        },
      },
    ]);
    expect(createStepFingerprint(step1)).toBe(createStepFingerprint(step2));
  });

  it("ignores explanation field when fingerprinting", () => {
    const step1 = makeStep([
      {
        toolName: "run_terminal_cmd",
        input: { command: "ls", explanation: "List files" },
      },
    ]);
    const step2 = makeStep([
      {
        toolName: "run_terminal_cmd",
        input: { command: "ls", explanation: "Trying again to list" },
      },
    ]);
    expect(createStepFingerprint(step1)).toBe(createStepFingerprint(step2));
  });
});

describe("detectDoomLoop", () => {
  it("returns none for empty steps", () => {
    expect(detectDoomLoop([])).toEqual({
      severity: "none",
      toolNames: [],
      consecutiveCount: 0,
    });
  });

  it("returns none for fewer steps than warning threshold", () => {
    const step = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const steps = Array(DOOM_LOOP_WARNING_THRESHOLD - 1).fill(step);
    expect(detectDoomLoop(steps).severity).toBe("none");
  });

  it("returns warning at exactly warning threshold identical steps", () => {
    const step = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const steps = Array(DOOM_LOOP_WARNING_THRESHOLD).fill(step);
    const result = detectDoomLoop(steps);
    expect(result.severity).toBe("warning");
    expect(result.toolNames).toEqual(["file"]);
    expect(result.consecutiveCount).toBe(DOOM_LOOP_WARNING_THRESHOLD);
    expect(result.reason).toBe("repeated_tool_call");
  });

  it("returns a todo-specific warning after repeated empty todo_write calls", () => {
    const step = makeStep([{ toolName: "todo_write", input: {} }]);
    const steps = Array(EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD).fill(step);

    const result = detectDoomLoop(steps);

    expect(result).toMatchObject({
      severity: "warning",
      reason: "empty_todo_write_input",
      toolNames: ["todo_write"],
      consecutiveCount: EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD,
      activeToolExclusions: ["todo_write"],
    });
  });

  it("treats missing todo_write input as empty for recovery", () => {
    const step = makeStep([{ toolName: "todo_write", input: undefined }]);
    const steps = Array(EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD).fill(step);

    const result = detectDoomLoop(steps);

    expect(result.reason).toBe("empty_todo_write_input");
    expect(result.activeToolExclusions).toEqual(["todo_write"]);
  });

  it("returns a terminal-specific warning after repeated empty run_terminal_cmd calls", () => {
    const step = makeStep([{ toolName: "run_terminal_cmd", input: {} }]);
    const steps = Array(EMPTY_RUN_TERMINAL_CMD_INPUT_WARNING_THRESHOLD).fill(
      step,
    );

    const result = detectDoomLoop(steps);

    expect(result).toMatchObject({
      severity: "warning",
      reason: "empty_run_terminal_cmd_input",
      toolNames: ["run_terminal_cmd"],
      consecutiveCount: EMPTY_RUN_TERMINAL_CMD_INPUT_WARNING_THRESHOLD,
      activeToolExclusions: ["run_terminal_cmd"],
    });
  });

  it("treats missing run_terminal_cmd input as empty for recovery", () => {
    const step = makeStep([{ toolName: "run_terminal_cmd", input: undefined }]);
    const steps = Array(EMPTY_RUN_TERMINAL_CMD_INPUT_WARNING_THRESHOLD).fill(
      step,
    );

    const result = detectDoomLoop(steps);

    expect(result.reason).toBe("empty_run_terminal_cmd_input");
    expect(result.activeToolExclusions).toEqual(["run_terminal_cmd"]);
  });

  it("warns after repeated empty run_terminal_cmd calls even with valid commands between them", () => {
    const result = detectDoomLoop([
      makeStep([{ toolName: "run_terminal_cmd", input: {} }]),
      makeStep([
        {
          toolName: "run_terminal_cmd",
          input: { command: "curl -I https://example.com" },
        },
      ]),
      makeStep([{ toolName: "run_terminal_cmd", input: {} }]),
    ]);

    expect(result).toMatchObject({
      severity: "warning",
      reason: "empty_run_terminal_cmd_input",
      toolNames: ["run_terminal_cmd"],
      activeToolExclusions: ["run_terminal_cmd"],
    });
  });

  it("does not reapply terminal recovery after the latest command is valid", () => {
    const result = detectDoomLoop([
      makeStep([{ toolName: "run_terminal_cmd", input: {} }]),
      makeStep([{ toolName: "run_terminal_cmd", input: undefined }]),
      makeStep([{ toolName: "run_terminal_cmd", input: { command: "true" } }]),
    ]);

    expect(result.severity).toBe("none");
  });

  it("counts empty run_terminal_cmd calls in mixed tool-call steps", () => {
    const result = detectDoomLoop([
      makeStep([
        { toolName: "read_file", input: { path: "/tmp/a" } },
        { toolName: "run_terminal_cmd", input: {} },
      ]),
      makeStep([
        { toolName: "list_dir", input: { path: "/tmp" } },
        { toolName: "run_terminal_cmd", input: undefined },
      ]),
    ]);

    expect(result).toMatchObject({
      severity: "warning",
      reason: "empty_run_terminal_cmd_input",
      activeToolExclusions: ["run_terminal_cmd"],
    });
  });

  it("does not warn for old empty run_terminal_cmd calls outside the recent window", () => {
    const oldEmpty = makeStep([{ toolName: "run_terminal_cmd", input: {} }]);
    const valid = makeStep([
      { toolName: "run_terminal_cmd", input: { command: "true" } },
    ]);
    const recentEmpty = makeStep([
      { toolName: "run_terminal_cmd", input: undefined },
    ]);

    const result = detectDoomLoop([
      oldEmpty,
      valid,
      valid,
      valid,
      valid,
      valid,
      valid,
      valid,
      valid,
      recentEmpty,
    ]);

    expect(result.severity).toBe("none");
  });

  it("does not apply todo recovery to other empty tool calls", () => {
    const step = makeStep([{ toolName: "list_notes", input: {} }]);
    const steps = Array(EMPTY_TODO_WRITE_INPUT_WARNING_THRESHOLD).fill(step);

    expect(detectDoomLoop(steps).severity).toBe("none");
  });

  it("returns warning between warning and halt thresholds", () => {
    const step = makeStep([
      { toolName: "run_terminal_cmd", input: { command: "ls" } },
    ]);
    const steps = Array(DOOM_LOOP_HALT_THRESHOLD - 1).fill(step);
    const result = detectDoomLoop(steps);
    expect(result.severity).toBe("warning");
    expect(result.consecutiveCount).toBe(DOOM_LOOP_HALT_THRESHOLD - 1);
  });

  it("returns halt at exactly halt threshold identical steps", () => {
    const step = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const steps = Array(DOOM_LOOP_HALT_THRESHOLD).fill(step);
    const result = detectDoomLoop(steps);
    expect(result.severity).toBe("halt");
    expect(result.consecutiveCount).toBe(DOOM_LOOP_HALT_THRESHOLD);
  });

  it("still halts after enough repeated empty todo_write calls", () => {
    const step = makeStep([{ toolName: "todo_write", input: {} }]);
    const steps = Array(DOOM_LOOP_HALT_THRESHOLD).fill(step);

    const result = detectDoomLoop(steps);

    expect(result.severity).toBe("halt");
    expect(result.reason).toBe("empty_todo_write_input");
    expect(result.activeToolExclusions).toEqual(["todo_write"]);
  });

  it("still halts after enough repeated empty run_terminal_cmd calls", () => {
    const step = makeStep([{ toolName: "run_terminal_cmd", input: {} }]);
    const steps = Array(DOOM_LOOP_HALT_THRESHOLD).fill(step);

    const result = detectDoomLoop(steps);

    expect(result.severity).toBe("halt");
    expect(result.reason).toBe("empty_run_terminal_cmd_input");
    expect(result.activeToolExclusions).toEqual(["run_terminal_cmd"]);
  });

  it("returns halt above halt threshold", () => {
    const step = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const steps = Array(DOOM_LOOP_HALT_THRESHOLD + 3).fill(step);
    const result = detectDoomLoop(steps);
    expect(result.severity).toBe("halt");
  });

  it("returns none when chain is broken by a different tool call", () => {
    const stepA = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const stepB = makeStep([
      { toolName: "run_terminal_cmd", input: { command: "pwd" } },
    ]);
    // A, A, B, A, A — only 2 trailing identical
    const steps = [stepA, stepA, stepB, stepA, stepA];
    expect(detectDoomLoop(steps).severity).toBe("none");
  });

  it("returns none when chain is broken by a no-tool step", () => {
    const step = makeStep([{ toolName: "file", input: { path: "/a.txt" } }]);
    const noToolStep = makeStep([]);
    // 3 identical, then no-tool, then 2 identical — trailing count is 2
    const steps = [step, step, step, noToolStep, step, step];
    expect(detectDoomLoop(steps).severity).toBe("none");
  });

  it("returns none when same tool has different args each time", () => {
    const steps = Array.from({ length: 5 }, (_, i) =>
      makeStep([{ toolName: "file", input: { path: `/file${i}.txt` } }]),
    );
    expect(detectDoomLoop(steps).severity).toBe("none");
  });

  it("detects loop when only brief/explanation differs between calls", () => {
    const steps = [
      makeStep([
        {
          toolName: "file",
          input: {
            action: "read",
            path: "/home/user/.credentials/api_key.txt",
            brief: "Read the API key file as requested",
          },
        },
      ]),
      makeStep([
        {
          toolName: "file",
          input: {
            action: "read",
            path: "/home/user/.credentials/api_key.txt",
            brief: "Retry reading the API key file",
          },
        },
      ]),
      makeStep([
        {
          toolName: "file",
          input: {
            action: "read",
            path: "/home/user/.credentials/api_key.txt",
            brief: "Third attempt to read the API key file",
          },
        },
      ]),
    ];
    const result = detectDoomLoop(steps);
    expect(result.severity).toBe("warning");
    expect(result.toolNames).toEqual(["file"]);
    expect(result.consecutiveCount).toBe(3);
  });

  it("handles steps with multiple tool calls", () => {
    const step = makeStep([
      { toolName: "file", input: { path: "/a.txt" } },
      { toolName: "run_terminal_cmd", input: { command: "ls" } },
    ]);
    const steps = Array(DOOM_LOOP_WARNING_THRESHOLD).fill(step);
    const result = detectDoomLoop(steps);
    expect(result.severity).toBe("warning");
    expect(result.toolNames).toContain("file");
    expect(result.toolNames).toContain("run_terminal_cmd");
  });
});

describe("generateDoomLoopNudge", () => {
  it("includes tool name and count", () => {
    const nudge = generateDoomLoopNudge({
      severity: "warning",
      toolNames: ["file"],
      consecutiveCount: 3,
    });
    expect(nudge).toContain("file");
    expect(nudge).toContain("3 times");
    expect(nudge).toContain("[LOOP DETECTED]");
  });

  it("includes multiple tool names", () => {
    const nudge = generateDoomLoopNudge({
      severity: "warning",
      toolNames: ["file", "run_terminal_cmd"],
      consecutiveCount: 4,
    });
    expect(nudge).toContain("file");
    expect(nudge).toContain("run_terminal_cmd");
    expect(nudge).toContain("4 times");
  });

  it("gives specific recovery guidance for empty todo_write calls", () => {
    const nudge = generateDoomLoopNudge({
      severity: "warning",
      toolNames: ["todo_write"],
      consecutiveCount: 2,
      reason: "empty_todo_write_input",
      activeToolExclusions: ["todo_write"],
    });

    expect(nudge).toContain("[TODO UPDATE SKIPPED]");
    expect(nudge).toContain("todo_write is unavailable");
    expect(nudge).toContain("merge and todos");
  });

  it("gives specific recovery guidance for empty run_terminal_cmd calls", () => {
    const nudge = generateDoomLoopNudge({
      severity: "warning",
      toolNames: ["run_terminal_cmd"],
      consecutiveCount: 2,
      reason: "empty_run_terminal_cmd_input",
      activeToolExclusions: ["run_terminal_cmd"],
    });

    expect(nudge).toContain("[COMMAND SKIPPED]");
    expect(nudge).toContain("In the recent steps");
    expect(nudge).toContain("run_terminal_cmd is unavailable");
    expect(nudge).toContain("required command field");
  });
});
