type MessageWithParts = {
  role?: unknown;
  parts?: unknown[];
};

const getPartFields = (part: unknown) =>
  part && typeof part === "object"
    ? (part as {
        type?: unknown;
        storage?: unknown;
        localPath?: unknown;
        text?: unknown;
        url?: unknown;
        fileId?: unknown;
      })
    : undefined;

const UI_ONLY_PART_TYPES = new Set(["data-summarization"]);

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

export const getEmptyProcessedMessagesMetadata = (
  messages: MessageWithParts[],
  options: {
    regenerate?: boolean;
    isAutoContinue?: boolean;
    isTemporary?: boolean;
    sandboxPreference?: unknown;
  } = {},
): Record<string, boolean | number | string> => {
  let userMessages = 0;
  let assistantMessages = 0;
  let systemMessages = 0;
  let otherRoleMessages = 0;
  let emptyPartsMessages = 0;
  let partCount = 0;
  let textPartCount = 0;
  let nonemptyTextPartCount = 0;
  let filePartCount = 0;
  let fileWithUrlCount = 0;
  let fileWithFileIdCount = 0;
  let localDesktopFilePartCount = 0;
  let localDesktopFileWithLocalPathCount = 0;
  let localDesktopFileMissingLocalPathCount = 0;
  let uiOnlyPartCount = 0;
  let stepStartPartCount = 0;
  let reasoningPartCount = 0;
  let nonemptyReasoningPartCount = 0;
  let toolPartCount = 0;
  let dataPartCount = 0;
  let otherPartCount = 0;

  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    else if (message.role === "assistant") assistantMessages += 1;
    else if (message.role === "system") systemMessages += 1;
    else otherRoleMessages += 1;

    if (!message.parts || message.parts.length === 0) {
      emptyPartsMessages += 1;
      continue;
    }

    for (const part of message.parts) {
      const fields = getPartFields(part);
      const type = typeof fields?.type === "string" ? fields.type : "";
      partCount += 1;

      if (type === "text") {
        textPartCount += 1;
        if (typeof fields?.text === "string" && fields.text.trim().length > 0) {
          nonemptyTextPartCount += 1;
        }
      } else if (type === "file") {
        filePartCount += 1;
        if (typeof fields?.url === "string" && fields.url.length > 0) {
          fileWithUrlCount += 1;
        }
        if (typeof fields?.fileId === "string" && fields.fileId.length > 0) {
          fileWithFileIdCount += 1;
        }
        if (fields?.storage === "local-desktop") {
          localDesktopFilePartCount += 1;
          if (
            typeof fields.localPath === "string" &&
            fields.localPath.length > 0
          ) {
            localDesktopFileWithLocalPathCount += 1;
          } else {
            localDesktopFileMissingLocalPathCount += 1;
          }
        }
      } else if (UI_ONLY_PART_TYPES.has(type)) {
        uiOnlyPartCount += 1;
      } else if (type === "step-start") {
        stepStartPartCount += 1;
      } else if (type === "reasoning") {
        reasoningPartCount += 1;
        if (typeof fields?.text === "string" && fields.text.trim().length > 0) {
          nonemptyReasoningPartCount += 1;
        }
      } else if (type.startsWith("tool-")) {
        toolPartCount += 1;
      } else if (type.startsWith("data-")) {
        dataPartCount += 1;
      } else {
        otherPartCount += 1;
      }
    }
  }

  const metadata: Record<string, boolean | number | string> = {
    empty_after_processing: true,
    processing_input_message_count: messages.length,
    processing_input_user_message_count: userMessages,
    processing_input_assistant_message_count: assistantMessages,
    processing_input_system_message_count: systemMessages,
    processing_input_other_role_message_count: otherRoleMessages,
    processing_input_empty_parts_message_count: emptyPartsMessages,
    processing_input_part_count: partCount,
    processing_input_text_part_count: textPartCount,
    processing_input_nonempty_text_part_count: nonemptyTextPartCount,
    processing_input_file_part_count: filePartCount,
    processing_input_file_with_url_count: fileWithUrlCount,
    processing_input_file_with_file_id_count: fileWithFileIdCount,
    processing_input_local_desktop_file_part_count: localDesktopFilePartCount,
    processing_input_local_desktop_file_with_local_path_count:
      localDesktopFileWithLocalPathCount,
    processing_input_local_desktop_file_missing_local_path_count:
      localDesktopFileMissingLocalPathCount,
    processing_input_ui_only_part_count: uiOnlyPartCount,
    processing_input_step_start_part_count: stepStartPartCount,
    processing_input_reasoning_part_count: reasoningPartCount,
    processing_input_nonempty_reasoning_part_count: nonemptyReasoningPartCount,
    processing_input_tool_part_count: toolPartCount,
    processing_input_data_part_count: dataPartCount,
    processing_input_other_part_count: otherPartCount,
  };

  if (typeof options.regenerate === "boolean") {
    metadata.processing_input_regenerate = options.regenerate;
  }
  if (typeof options.isAutoContinue === "boolean") {
    metadata.processing_input_auto_continue = options.isAutoContinue;
  }
  if (typeof options.isTemporary === "boolean") {
    metadata.processing_input_temporary = options.isTemporary;
  }
  if (typeof options.sandboxPreference === "string") {
    metadata.processing_input_sandbox_preference = options.sandboxPreference;
  }

  return metadata;
};
