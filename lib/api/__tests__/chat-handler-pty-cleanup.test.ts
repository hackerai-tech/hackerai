/**
 * Isolated verification that `ptySessionManager.closeAll(chatId)` is invoked
 * from the agent loop's streamText callbacks.
 *
 * After the shared-runner refactor, the onFinish/onError/onAbort PTY hooks
 * live in agent-stream-runner.ts (shared by both chat-handler and Trigger.dev tasks).
 * The outer-catch backstop remains in chat-handler.ts directly.
 *
 * We read source files and assert structural presence — lighter than a full
 * integration test, still prevents regression of the cleanup contract.
 */

import fs from "fs";
import path from "path";

const chatHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, "../chat-handler.ts"),
  "utf8",
);

const runnerSrc = fs.readFileSync(
  path.resolve(__dirname, "../agent-stream-runner.ts"),
  "utf8",
);

describe("chat-handler — PTY closeAll wired to streamText onFinish", () => {
  test("chat-handler imports ptySessionManager singleton", () => {
    expect(chatHandlerSrc).toMatch(
      /import\s*\{\s*ptySessionManager\s*\}\s*from\s*["']@\/lib\/ai\/tools\/utils\/pty-session-manager["']/,
    );
  });

  test("runner calls closeAll(ctx.chatId) with a .catch guard", () => {
    expect(runnerSrc).toMatch(
      /ptySessionManager\s*\.\s*closeAll\(\s*ctx\.chatId\s*\)\s*\.\s*catch\s*\(/,
    );
  });

  test("runner calls closeAll inside the onError handler", () => {
    const onErrorIdx = runnerSrc.indexOf("onError:");
    expect(onErrorIdx).toBeGreaterThan(-1);

    const closeAllAfterOnError = runnerSrc.indexOf(
      ".closeAll(ctx.chatId)",
      onErrorIdx,
    );
    expect(closeAllAfterOnError).toBeGreaterThan(onErrorIdx);

    expect(runnerSrc.substring(onErrorIdx)).toMatch(
      /closeAll\(\s*ctx\.chatId\s*\)\s*\.\s*catch\s*\(/,
    );
  });

  test("runner calls closeAll inside the onAbort handler", () => {
    const onAbortIdx = runnerSrc.indexOf("onAbort:");
    expect(onAbortIdx).toBeGreaterThan(-1);

    const closeAllAfterOnAbort = runnerSrc.indexOf(
      ".closeAll(ctx.chatId)",
      onAbortIdx,
    );
    expect(closeAllAfterOnAbort).toBeGreaterThan(onAbortIdx);

    expect(runnerSrc.substring(onAbortIdx)).toMatch(
      /closeAll\(\s*ctx\.chatId\s*\)\s*\.\s*catch\s*\(/,
    );
  });

  test("chat-handler still has closeAll in the outer catch block as a hard backstop", () => {
    expect(chatHandlerSrc).toMatch(/closeAll.*outer catch/);
  });

  test("runner calls closeAll inside the streamText onFinish callback", () => {
    const onFinishIdx = runnerSrc.indexOf(
      "onFinish: async ({ finishReason, usage, response })",
    );
    expect(onFinishIdx).toBeGreaterThan(-1);

    const closeAllCallIdx = runnerSrc.indexOf(
      ".closeAll(ctx.chatId)",
      onFinishIdx,
    );
    expect(closeAllCallIdx).toBeGreaterThan(onFinishIdx);
  });
});
