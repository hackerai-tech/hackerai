export function getSafeErrorEventMessage(
  event: Pick<ErrorEvent, "message">,
): string | undefined {
  try {
    const message = event.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    // Firefox can block access to properties on cross-origin ErrorEvents.
    return undefined;
  }
}

export function getSafeErrorEventCause(
  event: Pick<ErrorEvent, "error" | "message">,
): unknown {
  try {
    const error = event.error;
    if (error != null) return error;
  } catch {
    // Fall back to the separately guarded message accessor.
  }

  return getSafeErrorEventMessage(event);
}
