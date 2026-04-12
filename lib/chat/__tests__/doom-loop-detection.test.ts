import { describe, it, expect } from "@jest/globals";
import {
  createStepFingerprint,
  detectDoomLoop,
  generateDoomLoopNudge,
  DOOM_LOOP_WARNING_THRESHOLD,
  DOOM_LOOP_HALT_THRESHOLD,
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
});
