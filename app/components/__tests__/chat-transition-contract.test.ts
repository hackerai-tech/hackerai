import fs from "fs";
import path from "path";

const chatSource = fs.readFileSync(
  path.resolve(__dirname, "../chat.tsx"),
  "utf8",
);

describe("chat route transition rendering", () => {
  it("resets route-owned messages before paint", () => {
    expect(chatSource).toMatch(
      /Sync local chat state from URL[\s\S]*useLayoutEffect\(\(\) => \{[\s\S]*setChatId\(routeChatId\)/,
    );
    expect(chatSource).toMatch(
      /messagesChatIdRef[\s\S]*useLayoutEffect\(\(\) => \{[\s\S]*setMessages\(serverMessages\)/,
    );
  });

  it("shows an explicit loading state instead of hiding stale messages", () => {
    expect(chatSource).toContain('data-testid="chat-timeline-loading"');
    expect(chatSource).toContain("Loading task…");
    expect(chatSource).toMatch(/<Messages\s+key=\{chatId\}/);
    expect(chatSource).not.toMatch(
      /isInitialExistingChatLoad\s*\?\s*"opacity-0"/,
    );
  });
});
