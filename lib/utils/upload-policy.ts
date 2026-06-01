import type { ChatMode } from "@/types/chat";
import {
  MAX_AGENT_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
} from "@/lib/constants/s3";

export type UploadPolicyMode = ChatMode | "agent-long";

export const MAX_ASK_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_PROVIDER_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

export const ASK_MODE_MAX_FILES_LIMIT = 10;
export const AGENT_MODE_MAX_FILES_LIMIT = 20;
const AGENT_UPLOAD_TIP =
  "Switch to Agent mode to upload larger files for sandbox analysis.";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export function isSupportedImageMediaType(mediaType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mediaType.toLowerCase());
}

export function isAgentUploadMode(mode?: UploadPolicyMode): boolean {
  return mode === "agent" || mode === "agent-long";
}

export function getMaxFilesLimitForUploadMode(mode: ChatMode): number {
  return isAgentUploadMode(mode)
    ? AGENT_MODE_MAX_FILES_LIMIT
    : ASK_MODE_MAX_FILES_LIMIT;
}

export function getUploadLimitsForMode(
  mode?: UploadPolicyMode,
  options: { surface?: "client" | "backend" } = {},
): {
  maxFileSizeBytes: number;
  maxProviderImageSizeBytes: number;
} {
  const askMaxFileSizeBytes =
    options.surface === "backend"
      ? MAX_FILE_SIZE_BYTES
      : MAX_ASK_FILE_SIZE_BYTES;

  return {
    maxFileSizeBytes: isAgentUploadMode(mode)
      ? MAX_AGENT_FILE_SIZE_BYTES
      : askMaxFileSizeBytes,
    maxProviderImageSizeBytes: MAX_PROVIDER_IMAGE_SIZE_BYTES,
  };
}

export function isSandboxOnlyAgentUpload(args: {
  mode?: UploadPolicyMode;
  size: number;
  mediaType: string;
}): boolean {
  if (!isAgentUploadMode(args.mode)) return false;
  if (args.size > MAX_FILE_SIZE_BYTES) return true;
  return (
    isSupportedImageMediaType(args.mediaType) &&
    args.size > MAX_PROVIDER_IMAGE_SIZE_BYTES
  );
}

export function validateUploadPolicy(args: {
  mode?: UploadPolicyMode;
  size: number;
  mediaType: string;
  surface?: "client" | "backend";
}): { valid: true } | { valid: false; code: string; message: string } {
  const { maxFileSizeBytes, maxProviderImageSizeBytes } =
    getUploadLimitsForMode(args.mode, { surface: args.surface });

  if (args.size > maxFileSizeBytes) {
    const agentTip = !isAgentUploadMode(args.mode)
      ? ` ${AGENT_UPLOAD_TIP}`
      : "";
    return {
      valid: false,
      code: "FILE_SIZE_EXCEEDED",
      message: `File size must be less than ${maxFileSizeBytes / (1024 * 1024)}MB.${agentTip}`,
    };
  }

  if (
    !isAgentUploadMode(args.mode) &&
    isSupportedImageMediaType(args.mediaType) &&
    args.size > maxProviderImageSizeBytes
  ) {
    return {
      valid: false,
      code: "IMAGE_SIZE_EXCEEDED",
      message: `Image size must be less than ${maxProviderImageSizeBytes / (1024 * 1024)}MB. ${AGENT_UPLOAD_TIP}`,
    };
  }

  return { valid: true };
}
