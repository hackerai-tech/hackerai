import { describe, expect, it } from "@jest/globals";
import {
  AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES,
  sanitizeAgentLongRealtimeChunk,
} from "../agent-long-realtime-sanitizer";

const getBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("sanitizeAgentLongRealtimeChunk", () => {
  it("keeps small chunks by reference", () => {
    const chunk = { type: "text-delta", id: "t1", delta: "hello" };

    expect(sanitizeAgentLongRealtimeChunk(chunk)).toEqual([chunk]);
  });

  it("compacts oversized tool-input-error chunks", () => {
    const command = "curl https://example.test ".repeat(70_000);
    const chunk = {
      type: "tool-input-error",
      toolCallId: "call_1",
      toolName: "run_terminal_cmd",
      input: {
        command,
        interactive: false,
        is_background: false,
      },
      errorText: `Invalid input for tool run_terminal_cmd: ${command}`,
    };

    expect(getBytes(chunk)).toBeGreaterThan(
      AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES,
    );

    const [sanitized] = sanitizeAgentLongRealtimeChunk(chunk);

    expect(sanitized.type).toBe("tool-input-error");
    expect(getBytes(sanitized)).toBeLessThan(
      AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES,
    );
    expect(
      ((sanitized.input as Record<string, unknown>).command as string).length,
    ).toBeLessThan(command.length);
    expect((sanitized.errorText as string).length).toBeLessThan(
      chunk.errorText.length,
    );
  });

  it("compacts oversized tool outputs", () => {
    const html = "<main>payload</main>".repeat(90_000);
    const chunk = {
      type: "tool-output-available",
      toolCallId: "call_2",
      output: {
        html,
        status: 200,
      },
    };

    const [sanitized] = sanitizeAgentLongRealtimeChunk(chunk);

    expect(sanitized.type).toBe("tool-output-available");
    expect(getBytes(sanitized)).toBeLessThan(
      AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES,
    );
    expect(
      ((sanitized.output as Record<string, unknown>).html as string).length,
    ).toBeLessThan(html.length);
  });

  it("splits oversized terminal data chunks", () => {
    const terminal = "a".repeat(1_100_000);
    const chunk = {
      type: "data-terminal",
      id: "terminal-1",
      data: {
        terminal,
        toolCallId: "call_3",
      },
    };

    const sanitized = sanitizeAgentLongRealtimeChunk(chunk);

    expect(sanitized.length).toBeGreaterThan(1);
    expect(sanitized.map((part) => getBytes(part))).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(
      sanitized.every(
        (part) => getBytes(part) < AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES,
      ),
    ).toBe(true);
    expect(
      sanitized
        .map((part) => (part.data as { terminal: string }).terminal)
        .join(""),
    ).toBe(terminal);
  });
});
