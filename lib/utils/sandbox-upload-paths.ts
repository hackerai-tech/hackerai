// Sandbox attachment staging roots shared by the stager in
// sandbox-file-utils.ts and provider adapters. Keep this module free of
// imports so adapters can recognize staged paths without the staging graph.

/** E2B cloud sandboxes stage attachments under this root. */
export const CLOUD_SANDBOX_UPLOAD_ROOT = "/home/user/upload";

/**
 * Local and Desktop sandboxes stage attachments under this root because the
 * host machine may not have /home/user (for example macOS in dangerous mode).
 */
export const LOCAL_SANDBOX_UPLOAD_ROOT = "/tmp/hackerai-upload";

const ATTACHMENT_NAMESPACE_PATTERN = /^[0-9a-f]{64}$/;
// sanitizeFilenameForTerminal emits ASCII word characters, dots and hyphens
// and never starts with a dot, so "." and ".." cannot match.
const NON_SANITIZED_ATTACHMENT_CHARACTER = /[^\w.-]/;

/**
 * Matches the current local staging shape exactly:
 * `/tmp/hackerai-upload/<lowercase sha256 hex>/<sanitized filename>`, with the
 * basename equal to the annotated filename. This recognizes an annotation's
 * shape only; it does not prove the staged file exists.
 */
export const isCanonicalLocalStagedAttachmentPath = (
  localPath: string,
  filename: string,
): boolean => {
  const prefix = `${LOCAL_SANDBOX_UPLOAD_ROOT}/`;
  if (!localPath.startsWith(prefix)) return false;
  const segments = localPath.slice(prefix.length).split("/");
  return (
    segments.length === 2 &&
    segments[0].length === 64 &&
    ATTACHMENT_NAMESPACE_PATTERN.test(segments[0]) &&
    segments[1] === filename &&
    /^[A-Za-z0-9]/.test(filename) &&
    filename.length <= 255 &&
    !NON_SANITIZED_ATTACHMENT_CHARACTER.test(filename)
  );
};
