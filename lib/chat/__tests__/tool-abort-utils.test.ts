import {
  ABORTED_TOOL_ERROR_TEXT,
  INTERRUPTED_TOOL_ERROR_TEXT,
  getIncompleteToolErrorText,
  isUserStoppedToolError,
} from "../tool-abort-utils";
import { fixIncompleteMessageParts } from "../chat-processor";
import { normalizeMessages } from "@/lib/utils/message-processor";
import type { ChatMessage } from "@/types";

it("only attributes explicit user interruptions to the user", () => {
  expect(getIncompleteToolErrorText("timeout")).toBe(
    INTERRUPTED_TOOL_ERROR_TEXT,
  );
  expect(getIncompleteToolErrorText(undefined, true)).toBe(
    ABORTED_TOOL_ERROR_TEXT,
  );
  expect(isUserStoppedToolError(INTERRUPTED_TOOL_ERROR_TEXT)).toBe(false);
  expect(isUserStoppedToolError("Execution aborted by provider")).toBe(false);
  expect(isUserStoppedToolError(ABORTED_TOOL_ERROR_TEXT)).toBe(true);
  const parts = [
    {
      type: "tool-shell",
      toolCallId: "call-1",
      state: "input-available",
      input: { command: "echo hello" },
    },
  ];
  expect(
    fixIncompleteMessageParts(parts, { userInitiatedAbort: true })[0].errorText,
  ).toBe(ABORTED_TOOL_ERROR_TEXT);
  const messages = [
    { id: "a1", role: "assistant", parts },
  ] as unknown as ChatMessage[];
  expect(
    normalizeMessages(messages, { userInitiatedAbort: true }).messages[0]
      .parts[0],
  ).toMatchObject({ errorText: ABORTED_TOOL_ERROR_TEXT });
});
