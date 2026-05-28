const IGNORED_CONVEX_EXCEPTION_MESSAGES = [
  "Unauthorized: User not authenticated",
  "Invalid arguments provided",
  "FILE_TOKEN_LIMIT_EXCEEDED",
  "FILE_UPLOAD_RATE_LIMIT",
  "exceeds the maximum token limit",
  "cloud file upload limit",
  "INVALID_FILE_SIZE",
  "Batch size exceeds limit",
  "PAID_PLAN_REQUIRED",
  "Paid plan required for file uploads",
  "CHAT_UNAUTHORIZED",
  "Unauthorized: Chat does not belong to user",
  "OptimisticConcurrencyControlFailure",
  'Documents read from or written to the "btreeNode" table changed',
];

type PostHogEventLike = {
  event?: string;
  properties?: Record<string, unknown>;
};

const collectStrings = (value: unknown, strings: string[] = []): string[] => {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, strings);
    }
    return strings;
  }

  if (value && typeof value === "object") {
    for (const nestedValue of Object.values(value)) {
      collectStrings(nestedValue, strings);
    }
  }

  return strings;
};

export function shouldDropExpectedConvexException(event: PostHogEventLike) {
  if (event.event !== "$exception") {
    return false;
  }

  return collectStrings(event.properties).some((message) =>
    IGNORED_CONVEX_EXCEPTION_MESSAGES.some((ignoredMessage) =>
      message.includes(ignoredMessage),
    ),
  );
}
