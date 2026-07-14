import { describe, expect, it } from "@jest/globals";
import {
  hasVisibleAssistantContent,
  shouldSkipAbortedMessageSave,
  shouldUseUpdateOnlyForAbortedSave,
} from "../abort-persistence";

describe("hasVisibleAssistantContent", () => {
  it("detects non-empty assistant text", () => {
    expect(
      hasVisibleAssistantContent([
        { role: "user", parts: [{ type: "text", text: "run tests" }] },
        { role: "assistant", parts: [{ type: "text", text: "Done." }] },
      ]),
    ).toBe(true);
  });

  it("detects assistant tool work", () => {
    expect(
      hasVisibleAssistantContent([
        {
          role: "assistant",
          parts: [{ type: "tool-terminal" }],
        },
      ]),
    ).toBe(true);
  });

  it("ignores empty assistant text and user content", () => {
    expect(
      hasVisibleAssistantContent([
        { role: "user", parts: [{ type: "text", text: "visible user text" }] },
        { role: "assistant", parts: [{ type: "text", text: "   " }] },
      ]),
    ).toBe(false);
  });
});

describe("shouldSkipAbortedMessageSave", () => {
  const baseArgs = {
    isAborted: true,
    shouldSkipSaveSignal: false,
    hasVisibleAssistantContent: false,
    hasNewFiles: false,
    hasIncompleteToolCalls: false,
    hasUsageToRecord: false,
  };

  it("does not skip when visible assistant content exists without usage", () => {
    expect(
      shouldSkipAbortedMessageSave({
        ...baseArgs,
        hasVisibleAssistantContent: true,
      }),
    ).toBe(false);
  });

  it("skips when an aborted save has no persisted work to record", () => {
    expect(shouldSkipAbortedMessageSave(baseArgs)).toBe(true);
  });

  it("honors explicit skip-save signals", () => {
    expect(
      shouldSkipAbortedMessageSave({
        ...baseArgs,
        shouldSkipSaveSignal: true,
        hasVisibleAssistantContent: true,
      }),
    ).toBe(true);
  });

  it("does not skip non-aborted saves", () => {
    expect(
      shouldSkipAbortedMessageSave({
        ...baseArgs,
        isAborted: false,
      }),
    ).toBe(false);
  });
});

describe("shouldUseUpdateOnlyForAbortedSave", () => {
  it("uses updateOnly for explicit user aborts", () => {
    expect(
      shouldUseUpdateOnlyForAbortedSave({
        isAborted: true,
        isUserInitiatedAbort: true,
      }),
    ).toBe(true);
  });

  it("does not use updateOnly for non-user aborts", () => {
    expect(
      shouldUseUpdateOnlyForAbortedSave({
        isAborted: true,
        isUserInitiatedAbort: false,
      }),
    ).toBe(false);
  });
});
