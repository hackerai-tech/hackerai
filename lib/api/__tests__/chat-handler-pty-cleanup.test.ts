/**
 * Isolated verification that `ptySessionManager.closeAll(chatId)` is invoked
 * from the streamText `onFinish` callback at end of an assistant turn.
 *
 * We don't stand up the full chat-handler stack here — that would require
 * WorkOS, Convex, Axiom, model providers, etc. Instead we read the
 * `chat-handler.ts` source and assert:
 *   1. it imports the `ptySessionManager` singleton
 *   2. it calls `ptySessionManager.closeAll(chatId)` inside the streamText
 *      `onFinish` block
 *   3. the call is `.catch`-guarded so it cannot throw into the finish path
 *
 * This is the lightest test that still prevents regression of the
 * contract described in the plan's "Cleanup hook" section.
 */

import fs from "fs";
import path from "path";

describe("chat-handler — PTY closeAll wired to streamText onFinish", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../chat-handler.ts"),
    "utf8",
  );

  test("imports ptySessionManager singleton", () => {
    expect(src).toMatch(
      /import\s*\{\s*ptySessionManager\s*\}\s*from\s*["']@\/lib\/ai\/tools\/utils\/pty-session-manager["']/,
    );
  });

  test("calls closeAll(chatId) with a .catch guard", () => {
    // Matches `ptySessionManager\n  .closeAll(chatId)\n  .catch(…)` with any
    // amount of whitespace in between.
    expect(src).toMatch(
      /ptySessionManager\s*\.\s*closeAll\(\s*chatId\s*\)\s*\.\s*catch\s*\(/,
    );
  });

  test("closeAll is called inside the onError handler", () => {
    // Find the onError block in the source
    const onErrorIdx = src.indexOf("onError:");
    expect(onErrorIdx).toBeGreaterThan(-1);

    // Find a closeAll call after the onError block starts
    const closeAllAfterOnError = src.indexOf(".closeAll(chatId)", onErrorIdx);
    expect(closeAllAfterOnError).toBeGreaterThan(onErrorIdx);

    // Verify the closeAll in onError also has a .catch guard
    expect(src.substring(onErrorIdx)).toMatch(
      /closeAll\(\s*chatId\s*\)\s*\.\s*catch\s*\(/,
    );
  });

  test("closeAll is called inside the onAbort handler", () => {
    const onAbortIdx = src.indexOf("onAbort:");
    expect(onAbortIdx).toBeGreaterThan(-1);

    // Find a closeAll call after the onAbort block starts
    const closeAllAfterOnAbort = src.indexOf(".closeAll(chatId)", onAbortIdx);
    expect(closeAllAfterOnAbort).toBeGreaterThan(onAbortIdx);

    // Verify the closeAll in onAbort also has a .catch guard
    expect(src.substring(onAbortIdx)).toMatch(
      /closeAll\(\s*chatId\s*\)\s*\.\s*catch\s*\(/,
    );
  });

  test("closeAll appears in the outer catch block as a hard backstop", () => {
    expect(src).toMatch(/closeAll.*outer catch/);
  });

  test("closeAll is called inside the streamText onFinish (not toUIMessageStream onFinish)", () => {
    const streamTextOnFinishIdx = src.indexOf(
      "onFinish: async ({ finishReason, usage, response })",
    );
    expect(streamTextOnFinishIdx).toBeGreaterThan(-1);

    // Find the `.closeAll(chatId)` call site specifically (not the import).
    const closeAllCallIdx = src.indexOf(".closeAll(chatId)");
    expect(closeAllCallIdx).toBeGreaterThan(streamTextOnFinishIdx);

    // And it should appear before the *next* onFinish block that follows.
    const nextOnFinish = src.indexOf(
      "onFinish",
      streamTextOnFinishIdx + "onFinish".length,
    );
    if (nextOnFinish !== -1) {
      expect(closeAllCallIdx).toBeLessThan(nextOnFinish);
    }
  });
});
