import { describe, expect, it } from "@jest/globals";
import { sanitizeTerminalPartForShare } from "../shared-terminal-sanitizer";

describe("sanitizeTerminalPartForShare", () => {
  it("removes hidden host paths while preserving terminal results and inputs", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "run_terminal_cmd",
      input: { command: "cat /project/README.md" },
      output: {
        workingDirectory: "/Users/owner/PrivateProject",
        result: {
          output:
            "ordinary stdout\n[Full output (123 chars) saved to: /Users/owner/PrivateProject/output.txt]",
          exitCode: 0,
          workingDirectory: "/Users/owner/PrivateProject",
          recordPath: "/Users/owner/PrivateProject/record.json",
          outputPath: "/Users/owner/PrivateProject/output.txt",
          artifactPaths: ["/Users/owner/PrivateProject/output.txt"],
        },
      },
    };

    expect(sanitizeTerminalPartForShare(part)).toEqual({
      type: "dynamic-tool",
      toolName: "run_terminal_cmd",
      input: { command: "cat /project/README.md" },
      output: {
        result: {
          output: "ordinary stdout\n[Full output (123 chars) saved privately]",
          exitCode: 0,
        },
      },
    });
    expect(part.output.result.workingDirectory).toBe(
      "/Users/owner/PrivateProject",
    );
  });

  it("hides the generated saved-output path in streamed terminal parts", () => {
    expect(
      sanitizeTerminalPartForShare({
        type: "data-terminal",
        data: {
          terminal:
            "[Output too large - first 100 chars saved to: /Users/owner/PrivateProject/output.txt]\n",
          toolCallId: "tool-1",
        },
      }),
    ).toEqual({
      type: "data-terminal",
      data: {
        terminal: "[Output too large - first 100 chars saved privately]\n",
        toolCallId: "tool-1",
      },
    });
  });

  it("hides paths embedded in compacted terminal placeholders", () => {
    const placeholder =
      "[Terminal: ran 'pwd', exit code 0; record /Users/owner/PrivateProject/record.json; output /Users/owner/PrivateProject/output.txt; artifact /Users/owner/PrivateProject/result.txt]";
    expect(
      sanitizeTerminalPartForShare({
        type: "tool-run_terminal_cmd",
        input: { command: "pwd" },
        output: placeholder,
      }),
    ).toEqual({
      type: "tool-run_terminal_cmd",
      input: { command: "pwd" },
      output: "[Terminal: prior output compacted for storage]",
    });
  });

  it("preserves a path-free compacted placeholder and its exit status", () => {
    const part = {
      type: "tool-run_terminal_cmd",
      input: { command: "pwd" },
      output: "[Terminal: ran 'pwd', exit code 0]",
    };
    expect(sanitizeTerminalPartForShare(part)).toBe(part);
  });

  it("hides saved-output notices retained in partial stdout", () => {
    expect(
      sanitizeTerminalPartForShare({
        type: "tool-run_terminal_cmd",
        output: {
          result: {
            stdout:
              "ordinary stdout\n[Full output (123 chars) saved to: /Users/owner/PrivateProject/output.txt]",
          },
        },
      }),
    ).toEqual({
      type: "tool-run_terminal_cmd",
      output: {
        result: {
          stdout: "ordinary stdout\n[Full output (123 chars) saved privately]",
        },
      },
    });
  });

  it("hides metadata in serialized terminal result text", () => {
    const result = JSON.stringify({
      result: {
        output: "ordinary stdout",
        exitCode: 0,
        workingDirectory: "/Users/owner/PrivateProject",
        recordPath: "/Users/owner/PrivateProject/record.json",
      },
    });
    const expected = JSON.stringify({
      result: { output: "ordinary stdout", exitCode: 0 },
    });

    for (const prefix of ["", "Process exited with code 0\n"]) {
      expect(
        sanitizeTerminalPartForShare({
          type: "tool-run_terminal_cmd",
          output: `${prefix}${result}`,
        }).output,
      ).toBe(`${prefix}${expected}`);
    }
  });

  it("preserves user-authored paths and unrelated tool outputs", () => {
    const terminal = {
      type: "tool-shell",
      input: { command: "echo /Users/owner/PrivateProject" },
      output: { result: { output: "/Users/owner/PrivateProject" } },
    };
    const directOutput = {
      type: "tool-run_terminal_cmd",
      output: "/Users/owner/PrivateProject",
    };
    const unrelated = {
      type: "tool-open_url",
      output: { result: { workingDirectory: "http://example.test/path" } },
    };
    expect(sanitizeTerminalPartForShare(terminal)).toBe(terminal);
    expect(sanitizeTerminalPartForShare(directOutput)).toBe(directOutput);
    expect(sanitizeTerminalPartForShare(unrelated)).toBe(unrelated);
  });
});
