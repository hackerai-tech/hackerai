type ForkedChatTitleRecord = {
  title: string;
  branched_from_title?: string;
};

type SourceChatTitleRecord = {
  title: string;
  user_id: string;
  share_id?: string;
  share_date?: number;
};

/**
 * Preserve live source titles only for forks of the viewer's own chats.
 * Cross-user forks always use the title captured at fork time so revoking and
 * later replacing a share cannot expose a private rename through the old fork.
 * Legacy forks fall back to their own title.
 */
export const resolveBranchedFromTitle = (
  forkedChat: ForkedChatTitleRecord,
  sourceChat: SourceChatTitleRecord | null | undefined,
  viewerUserId: string,
): string => {
  if (sourceChat?.user_id === viewerUserId) {
    return sourceChat.title;
  }

  return forkedChat.branched_from_title ?? forkedChat.title;
};
