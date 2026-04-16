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
