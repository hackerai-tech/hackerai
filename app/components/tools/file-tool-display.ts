const SANDBOX_UPLOAD_TARGET =
  /^(?:\/home\/user\/upload|\/tmp\/hackerai-upload)\/(?:[a-f0-9]{16}|[a-f0-9]{64})\/([^/]+)$/i;

export const getFileToolDisplayTarget = (
  target: string | undefined,
): string | undefined => {
  if (!target) return target;
  return SANDBOX_UPLOAD_TARGET.exec(target)?.[1] ?? target;
};
