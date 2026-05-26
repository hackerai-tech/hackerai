import fs from "fs";
import path from "path";

const chatHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, "../chat-handler.ts"),
  "utf8",
);

const toolsSrc = fs.readFileSync(
  path.resolve(__dirname, "../../ai/tools/index.ts"),
  "utf8",
);

const systemPromptSrc = fs.readFileSync(
  path.resolve(__dirname, "../../system-prompt.ts"),
  "utf8",
);

describe("chat mode validation", () => {
  test("chat handler validates the runtime mode before applying gates", () => {
    const validationIdx = chatHandlerSrc.indexOf("isChatMode(parsedMode)");
    const freeAgentGateIdx = chatHandlerSrc.indexOf("assertFreeAgentGates({");

    expect(validationIdx).toBeGreaterThan(-1);
    expect(freeAgentGateIdx).toBeGreaterThan(validationIdx);
    expect(chatHandlerSrc).toMatch(/Invalid chat mode\./);
  });

  test("tools fail closed for unknown modes", () => {
    const validationIdx = toolsSrc.indexOf("isChatMode(mode)");
    const askBranchIdx = toolsSrc.indexOf('mode === "ask"');

    expect(validationIdx).toBeGreaterThan(-1);
    expect(askBranchIdx).toBeGreaterThan(validationIdx);
  });

  test("system prompt fails closed for unknown modes", () => {
    const validationIdx = systemPromptSrc.indexOf("isChatMode(mode)");
    const askBranchIdx = systemPromptSrc.indexOf('mode === "ask"');

    expect(validationIdx).toBeGreaterThan(-1);
    expect(askBranchIdx).toBeGreaterThan(validationIdx);
  });
});
