export type ErrorType =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "offline";

export type Surface =
  | "chat"
  | "auth"
  | "api"
  | "stream"
  | "database"
  | "history"
  | "vote"
  | "document"
  | "sandbox"
  | "suggestions";

export type ErrorCode = `${ErrorType}:${Surface}`;

export type ErrorVisibility = "response" | "log" | "none";

export const visibilityBySurface: Record<Surface, ErrorVisibility> = {
  database: "log",
  chat: "response",
  auth: "response",
  stream: "response",
  api: "response",
  history: "response",
  vote: "response",
  document: "response",
  sandbox: "response",
  suggestions: "response",
};

export class ChatSDKError extends Error {
  public type: ErrorType;
  public surface: Surface;
  public statusCode: number;
  public metadata?: Record<string, unknown>;

  constructor(
    errorCode: ErrorCode,
    cause?: string,
    metadata?: Record<string, unknown>,
  ) {
    super();

    const [type, surface] = errorCode.split(":");

    this.type = type as ErrorType;
    this.cause = cause;
    this.surface = surface as Surface;
    this.message = getMessageByErrorCode(errorCode);
    this.statusCode = getStatusCodeByType(this.type);
    this.metadata = metadata;
  }

  public toResponse() {
    const code: ErrorCode = `${this.type}:${this.surface}`;
    const visibility = visibilityBySurface[this.surface];

    const { message, cause, statusCode, metadata } = this;

    if (visibility === "log") {
      console.error({
        code,
        message,
        cause,
      });

      return Response.json(
        { code: "", message: "Something went wrong. Please try again later." },
        { status: statusCode },
      );
    }

    return Response.json(
      { code, message, cause, ...(metadata && { metadata }) },
      { status: statusCode },
    );
  }
}

const STREAM_ERROR_PREFIX = "__HACKERAI_CHAT_SDK_ERROR__:";

/**
 * UI message streams only carry error text. Preserve the structured error
 * fields needed by the client for rate-limit actions when an error crosses a
 * durable Agent stream.
 */
export function serializeChatSDKErrorForStream(error: ChatSDKError): string {
  const code: ErrorCode = `${error.type}:${error.surface}`;

  try {
    return `${STREAM_ERROR_PREFIX}${JSON.stringify({
      code,
      cause: typeof error.cause === "string" ? error.cause : undefined,
      metadata: error.metadata,
    })}`;
  } catch {
    return typeof error.cause === "string" ? error.cause : error.message;
  }
}

export function deserializeChatSDKErrorFromStream(
  error: unknown,
): ChatSDKError | null {
  if (error instanceof ChatSDKError) return error;
  if (
    !(error instanceof Error) ||
    !error.message.startsWith(STREAM_ERROR_PREFIX)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      error.message.slice(STREAM_ERROR_PREFIX.length),
    ) as {
      code?: unknown;
      cause?: unknown;
      metadata?: unknown;
    };
    if (
      typeof parsed.code !== "string" ||
      !/^(bad_request|unauthorized|forbidden|not_found|rate_limit|offline):(chat|auth|api|stream|database|history|vote|document|sandbox|suggestions)$/.test(
        parsed.code,
      )
    ) {
      return null;
    }

    return new ChatSDKError(
      parsed.code as ErrorCode,
      typeof parsed.cause === "string" ? parsed.cause : undefined,
      parsed.metadata && typeof parsed.metadata === "object"
        ? (parsed.metadata as Record<string, unknown>)
        : undefined,
    );
  } catch {
    return null;
  }
}

export function getMessageByErrorCode(errorCode: ErrorCode): string {
  if (errorCode.includes("database")) {
    return "An error occurred while executing a database query.";
  }

  switch (errorCode) {
    case "bad_request:api":
      return "The request couldn't be processed. Please check your input and try again.";

    case "unauthorized:auth":
      return "You need to sign in before continuing.";
    case "forbidden:auth":
      return "Your account does not have access to this feature.";

    case "rate_limit:chat":
      return "You have exceeded your maximum number of messages for the day. Please try again later.";
    case "bad_request:chat":
      return "The chat couldn't accept that message. Please try again.";
    case "not_found:chat":
      return "The requested chat was not found. Please check the chat ID and try again.";
    case "forbidden:chat":
      return "This chat belongs to another user. Please check the chat ID and try again.";
    case "unauthorized:chat":
      return "You need to sign in to view this chat. Please sign in and try again.";
    case "offline:chat":
      return "We're having trouble sending your message. Please check your internet connection and try again.";

    case "bad_request:stream":
      return "The model provider returned an error.";
    case "bad_request:sandbox":
      return "The computer attachment upload failed.";
    case "forbidden:stream":
      return "The model provider blocked this request.";

    case "not_found:document":
      return "The requested document was not found. Please check the document ID and try again.";
    case "forbidden:document":
      return "This document belongs to another user. Please check the document ID and try again.";
    case "unauthorized:document":
      return "You need to sign in to view this document. Please sign in and try again.";
    case "bad_request:document":
      return "The request to create or update the document was invalid. Please check your input and try again.";

    default:
      return "Something went wrong. Please try again later.";
  }
}

export function isNetworkStreamError(error: unknown): boolean {
  if (error instanceof ChatSDKError) return error.type === "offline";
  if (!(error instanceof Error)) return false;
  // User-initiated stops surface as AbortError — don't treat as network drop.
  if (error.name === "AbortError") return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("connection closed") ||
    msg.includes("error in input stream") ||
    msg.includes("load failed")
  );
}

function getStatusCodeByType(type: ErrorType) {
  switch (type) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "rate_limit":
      return 429;
    case "offline":
      return 503;
    default:
      return 500;
  }
}
