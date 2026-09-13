import type { ChatMode } from "@/types/chat";
import type { UploadedFileState } from "@/types/file";
import { isAgentMode } from "./mode-helpers";

export const PASTED_TEXT_ATTACHMENT_MIN_CHARS = 5_000;
export const PASTED_TEXT_INLINE_RESTORE_MAX_CHARS = 25_000;

export const isGeneratedPastedTextAttachment = (
  file: UploadedFileState,
): boolean =>
  file.generatedSource === "pasted-text" ||
  Boolean(file.generatedTextAttachment || file.generatedTextAttachmentId);

export const isPastedTextAttachmentAvailableInMode = (
  file: UploadedFileState,
  mode: ChatMode,
): boolean => !isGeneratedPastedTextAttachment(file) || isAgentMode(mode);
