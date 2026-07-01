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
});
