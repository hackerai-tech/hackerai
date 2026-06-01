type MessageWithParts = {
  parts?: unknown[];
};

const getPartFields = (part: unknown) =>
  part && typeof part === "object"
    ? (part as { type?: unknown; storage?: unknown; localPath?: unknown })
    : undefined;

const isLocalDesktopFilePart = (part: unknown) => {
  const fields = getPartFields(part);
  return fields?.type === "file" && fields.storage === "local-desktop";
};

export const hasRestageableLocalDesktopAttachments = (
  messages: MessageWithParts[],
): boolean =>
  messages.some((message) =>
    message.parts?.some(
      (part) =>
        isLocalDesktopFilePart(part) &&
        typeof getPartFields(part)?.localPath === "string" &&
        (getPartFields(part)?.localPath as string).length > 0,
    ),
  );

export const hasUnrestageableLocalDesktopAttachments = (
  messages: MessageWithParts[],
): boolean =>
  messages.some((message) =>
    message.parts?.some(
      (part) =>
        isLocalDesktopFilePart(part) &&
        (typeof getPartFields(part)?.localPath !== "string" ||
          getPartFields(part)?.localPath === ""),
    ),
  );

export const hasFileAttachments = (messages: MessageWithParts[]): boolean =>
  messages.some((message) =>
    message.parts?.some((part) => getPartFields(part)?.type === "file"),
  );

export const getEmptyProcessedMessagesCause = (
  messages: MessageWithParts[],
): string => {
  if (hasUnrestageableLocalDesktopAttachments(messages)) {
    return "The attached local file is no longer available to this request. Please reattach it and try again.";
  }

  if (hasFileAttachments(messages)) {
    return "The attached file could not be prepared for this request. Please reattach it or add a short message and try again.";
  }

  return "Your message could not be processed because it did not contain any usable content. Please add a short message and try again.";
};
