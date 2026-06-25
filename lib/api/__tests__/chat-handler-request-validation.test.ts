import fs from "fs";
import path from "path";

const chatHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, "../chat-handler.ts"),
  "utf8",
);

describe("chat-handler request validation", () => {
  it("rejects non-array messages before history merging can iterate them", () => {
    expect(chatHandlerSrc).toContain("const requireChatMessagesArray =");
    expect(chatHandlerSrc).toContain(
      "Invalid chat request: messages must be an array.",
    );

    const validationIdx = chatHandlerSrc.indexOf(
      "const requestMessages = requireChatMessagesArray(messages);",
    );
    const historyFetchIdx = chatHandlerSrc.indexOf(
      "const fetched = await getMessagesByChatId({",
    );
    const newMessagesIdx = chatHandlerSrc.indexOf(
      "newMessages: requestMessages,",
      historyFetchIdx,
    );

    expect(validationIdx).toBeGreaterThan(-1);
    expect(historyFetchIdx).toBeGreaterThan(validationIdx);
    expect(newMessagesIdx).toBeGreaterThan(historyFetchIdx);
    expect(chatHandlerSrc).not.toContain("newMessages: messages,");
  });
});
