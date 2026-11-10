export type OpenRouterStreamErrorContext = Readonly<{
  version: 1;
  source: "sdk_error_part";
  headers: "present" | "absent" | "unreadable" | "unattributable";
  association: "same_call" | "ambiguous";
  generationId?: string;
  requestId?: string;
}>;

const contexts = new WeakMap<
  object,
  {
    call: object | null;
    context: OpenRouterStreamErrorContext;
  }
>();

/** Read only context associated with this exact emitted error object. */
export function getOpenRouterStreamErrorContext(
  error: unknown,
): OpenRouterStreamErrorContext | undefined {
  return error !== null && typeof error === "object"
    ? contexts.get(error)?.context
    : undefined;
}

/** Associate one immutable snapshot; reused objects cannot identify their owning call. */
export function recordOpenRouterStreamErrorContext(
  error: unknown,
  call: object,
  context: OpenRouterStreamErrorContext,
): void {
  if (error === null || typeof error !== "object") return;
  const previous = contexts.get(error);
  contexts.set(
    error,
    previous && previous.call !== call
      ? {
          call: null,
          context: Object.freeze({
            version: 1,
            source: "sdk_error_part",
            headers: "unattributable",
            association: "ambiguous",
          }),
        }
      : { call, context: Object.freeze(context) },
  );
}
