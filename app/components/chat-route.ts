type FinalizeNewChatRouteOptions = {
  chatId: string;
  isAbort: boolean;
  isExistingChat: boolean;
  isTemporaryChat: boolean;
};

export const finalizeNewChatRoute = ({
  chatId,
  isAbort,
  isExistingChat,
  isTemporaryChat,
}: FinalizeNewChatRouteOptions): boolean => {
  if (isExistingChat || isTemporaryChat) return false;

  // useChat invokes the latest onFinish callback even when an older request is
  // aborted. Only let an abort finalize the URL if it still owns that route.
  if (isAbort && window.location.pathname !== `/c/${chatId}`) return false;

  // Avoid a full navigation so the mounted Chat can transition back to ready.
  window.history.replaceState({}, "", `/c/${chatId}`);
  return true;
};
