type FinalizeNewChatRouteOptions = {
  chatId: string;
  isAbort: boolean;
  isError?: boolean;
  isExistingChat: boolean;
};

export const finalizeNewChatRoute = ({
  chatId,
  isAbort,
  isError = false,
  isExistingChat,
}: FinalizeNewChatRouteOptions): boolean => {
  if (isExistingChat || isError) return false;

  const chatPathname = `/c/${chatId}`;
  const currentPathname = window.location.pathname;
  if (currentPathname !== "/" && currentPathname !== chatPathname) return false;

  // useChat invokes the latest onFinish callback even when an older request is
  // aborted. Only let an abort finalize the URL if it still owns that route.
  if (isAbort && currentPathname !== chatPathname) return false;

  // Avoid a full navigation so the mounted Chat can transition back to ready.
  window.history.replaceState({}, "", chatPathname);
  return true;
};
