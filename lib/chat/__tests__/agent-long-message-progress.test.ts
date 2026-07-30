import { getAgentLongMessageProgressFingerprint } from "../agent-long-message-progress";
import type { ChatMessage } from "@/types";

const message = (id: string, parts: ChatMessage["parts"]): ChatMessage =>
  ({
    id,
    role: "assistant",
    parts,
  }) as ChatMessage;

describe("getAgentLongMessageProgressFingerprint", () => {
  it("changes when the latest streamed text grows", () => {
    const before = getAgentLongMessageProgressFingerprint([
      message("assistant-1", [{ type: "text", text: "working" }]),
    ]);
    const after = getAgentLongMessageProgressFingerprint([
      message("assistant-1", [{ type: "text", text: "working longer" }]),
    ]);

    expect(after).not.toBe(before);
  });

  it("changes when a new streamed part is appended", () => {
    const toolPart = {
      type: "tool-shell",
      state: "input-available",
      input: { command: "pwd" },
    } as ChatMessage["parts"][number];
    const before = getAgentLongMessageProgressFingerprint([
      message("assistant-1", [toolPart]),
    ]);
    const after = getAgentLongMessageProgressFingerprint([
      message("assistant-1", [
        toolPart,
        {
          type: "data-terminal",
          data: { toolCallId: "tool-1", terminal: "output" },
        } as ChatMessage["parts"][number],
      ]),
    ]);

    expect(after).not.toBe(before);
  });

  it("does not serialize transcript parts", () => {
    const earlierPart = {
      type: "tool-shell",
      toJSON: () => {
        throw new Error("earlier part should not be serialized");
      },
    } as unknown as ChatMessage["parts"][number];
    const latestPart = {
      type: "tool-shell",
      state: "output-available",
      toolCallId: "tool-1",
      toJSON: () => {
        throw new Error("latest part should not be serialized");
      },
    } as unknown as ChatMessage["parts"][number];

    expect(() =>
      getAgentLongMessageProgressFingerprint([
        message("assistant-1", [earlierPart]),
        message("assistant-2", [latestPart]),
      ]),
    ).not.toThrow();
  });

  it("changes when the latest tool state changes", () => {
    const before = getAgentLongMessageProgressFingerprint([
      message("assistant-1", [
        {
          type: "tool-shell",
          state: "input-available",
          toolCallId: "tool-1",
        } as ChatMessage["parts"][number],
      ]),
    ]);
    const after = getAgentLongMessageProgressFingerprint([
      message("assistant-1", [
        {
          type: "tool-shell",
          state: "output-available",
          toolCallId: "tool-1",
        } as ChatMessage["parts"][number],
      ]),
    ]);

    expect(after).not.toBe(before);
  });
});
