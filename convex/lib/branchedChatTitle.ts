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
 * Preserve live source titles only while the viewer is authorized to see the
 * source chat. Revoked cross-user shares use the title captured at fork time;
 * legacy forks fall back to their own title instead of exposing later changes.
 */
export const resolveBranchedFromTitle = (
  forkedChat: ForkedChatTitleRecord,
  sourceChat: SourceChatTitleRecord | null | undefined,
  viewerUserId: string,
): string => {
  const canReadLiveSourceTitle =
    sourceChat?.user_id === viewerUserId ||
    (sourceChat?.share_id !== undefined && sourceChat.share_date !== undefined);

  if (sourceChat && canReadLiveSourceTitle) {
    return sourceChat.title;
  }

  return forkedChat.branched_from_title ?? forkedChat.title;
};
