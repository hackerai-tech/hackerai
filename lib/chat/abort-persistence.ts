type MessagePartLike = {
  type?: string;
  text?: unknown;
};

type MessageLike = {
  role?: string;
  parts?: readonly MessagePartLike[];
};

export function hasVisibleAssistantContent(
  messages: readonly MessageLike[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts?.some((part) => isVisibleAssistantPart(part)),
  );
}

export function shouldSkipAbortedMessageSave(args: {
  isAborted: boolean;
  shouldSkipSaveSignal: boolean;
  hasVisibleAssistantContent: boolean;
  hasNewFiles: boolean;
  hasIncompleteToolCalls: boolean;
  hasUsageToRecord: boolean;
}): boolean {
  if (!args.isAborted) return false;
  if (args.shouldSkipSaveSignal) return true;

  return (
    !args.hasVisibleAssistantContent &&
    !args.hasNewFiles &&
    !args.hasIncompleteToolCalls &&
    !args.hasUsageToRecord
  );
}

export function shouldUseUpdateOnlyForAbortedSave(args: {
  isAborted: boolean;
  isUserInitiatedAbort: boolean;
}): boolean {
  return args.isAborted && args.isUserInitiatedAbort;
}

function isVisibleAssistantPart(part: MessagePartLike): boolean {
  if (part.type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }

  return part.type?.startsWith("tool-") === true;
}
