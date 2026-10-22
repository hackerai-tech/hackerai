import fs from "fs";
import path from "path";

const useChatHandlersSrc = fs.readFileSync(
  path.resolve(__dirname, "../useChatHandlers.ts"),
  "utf8",
);

describe("useChatHandlers chat action contracts", () => {
  it("routes chat submissions through the shared action error boundary", () => {
    expect(useChatHandlersSrc).toMatch(/const runChatAction = /);

    for (const description of [
      "send message",
      "send fallback message",
      "regenerate response",
      "retry response",
      "regenerate edited message",
      "send queued message",
    ]) {
      expect(useChatHandlersSrc).toContain(`runChatAction("${description}"`);
    }
  });

  it("blocks unavailable local attachments instead of sending text-only", () => {
    expect(useChatHandlersSrc).toContain(
      'toast.error("Local attachment is unavailable"',
    );
    expect(useChatHandlersSrc).toMatch(
      /hasUnavailableLocalFiles[\s\S]*return false;[\s\S]*const hasValidFiles/,
    );
  });
});
