import fs from "fs";
import path from "path";

const useChatHandlersSrc = fs.readFileSync(
  path.resolve(__dirname, "../useChatHandlers.ts"),
  "utf8",
);

describe("useChatHandlers chat action contracts", () => {
  it("catches rejected chat action promises instead of leaving unhandled rejections", () => {
    expect(useChatHandlersSrc).toMatch(/const runChatAction = /);
    expect(useChatHandlersSrc).toMatch(/Promise\.resolve\(action\(\)\)\.catch/);

    for (const description of [
      "send message",
      "send fallback message",
      "regenerate response",
      "retry response",
      "regenerate edited message",
      "continue response",
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
