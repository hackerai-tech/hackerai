import { mergeResumedMessage } from "../useAutoResume";
import type { ChatMessage } from "@/types/chat";

function message(id: string, role: "user" | "assistant"): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text: id }],
  } as ChatMessage;
}

describe("mergeResumedMessage", () => {
  it("does not duplicate a resumed message already in current state", () => {
    const currentMessages = [
      message("user-1", "user"),
      message("a-1", "assistant"),
    ];
    const result = mergeResumedMessage(
      currentMessages,
      [message("user-1", "user")],
      message("a-1", "assistant"),
    );

    expect(result).toBe(currentMessages);
  });

  it("does not duplicate a resumed message already in initial messages", () => {
    const initialMessages = [
      message("user-1", "user"),
      message("a-1", "assistant"),
    ];
    const result = mergeResumedMessage(
      [message("user-1", "user")],
      initialMessages,
      message("a-1", "assistant"),
    );

    expect(result).toBe(initialMessages);
  });

  it("appends a new resumed message to the freshest message list", () => {
    const currentMessages = [
      message("user-1", "user"),
      message("a-1", "assistant"),
    ];
    const result = mergeResumedMessage(
      currentMessages,
      [message("user-1", "user")],
      message("a-2", "assistant"),
    );

    expect(result.map((item) => item.id)).toEqual(["user-1", "a-1", "a-2"]);
  });
});
