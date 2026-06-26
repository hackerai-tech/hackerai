import {
  getConvexErrorCodeFromText,
  isExpectedConvexErrorCode,
} from "@/lib/utils/expected-convex-errors";

export { isExpectedConvexErrorCode };

const IGNORED_CONVEX_EXCEPTION_MESSAGES = [
  "Unauthorized: User not authenticated",
  "Invalid arguments provided",
  "exceeds the maximum token limit",
  "cloud file upload limit",
  "Batch size exceeds limit",
  "Paid plan required for file uploads",
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

const shouldDropExpectedConvexMessage = (message: string): boolean => {
  const code = getConvexErrorCodeFromText(message);
  if (isExpectedConvexErrorCode(code)) {
    return true;
  }

  return IGNORED_CONVEX_EXCEPTION_MESSAGES.some((ignoredMessage) =>
    message.includes(ignoredMessage),
  );
};

export function shouldDropExpectedConvexException(event: PostHogEventLike) {
  if (event.event !== "$exception") {
    return false;
  }

  return collectStrings(event.properties).some(shouldDropExpectedConvexMessage);
}
