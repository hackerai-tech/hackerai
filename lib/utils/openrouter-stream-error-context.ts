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

export type OpenRouterBodyFailurePhase =
  "read_body" | "finish_stream" | "observe_chunk" | "forward_chunk";

type BodyFailureContext = Readonly<{
  association: "same_response" | "ambiguous";
  status?: number;
  phase?: OpenRouterBodyFailurePhase;
}>;

// Independent from SDK call ownership: a Response body can reject without an
// SDK error part. Do not retain a Response, headers, or body contents here.
const bodyFailures = new WeakMap<
  object,
  { response: object | null; context: BodyFailureContext }
>();

export function recordOpenRouterBodyFailureContext(
  error: object,
  response: object,
  status: number,
  phase: OpenRouterBodyFailurePhase,
): void {
  const previous = bodyFailures.get(error);
  bodyFailures.set(error, {
    response: previous && previous.response !== response ? null : response,
    context: Object.freeze(
      previous && previous.response !== response
        ? { association: "ambiguous" }
        : {
            association: "same_response",
            ...(Number.isInteger(status) && status >= 100 && status <= 599
              ? { status }
              : {}),
            phase,
          },
    ),
  });
}

/** Read at serialization time so later reuse cannot leave a stale snapshot. */
export function getOpenRouterBodyFailureContext(
  error: unknown,
): BodyFailureContext | undefined {
  return error !== null && typeof error === "object"
    ? bodyFailures.get(error)?.context
    : undefined;
}
