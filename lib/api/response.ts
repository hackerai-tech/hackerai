import { NextResponse } from "next/server";

export const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers || {}),
    },
  });

export const extractErrorMessage = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return (err as any).message ?? "";
  }
  return "";
};

export const isUnauthorizedError = (err: unknown): boolean => {
  const normalized = extractErrorMessage(err).toLowerCase();
  return (
    normalized.includes("invalid_grant") ||
    normalized.includes("session has already ended") ||
    normalized.includes("no session cookie") ||
    normalized.includes("unauthorized")
  );
};

export const isRateLimitError = (err: unknown): boolean => {
  const normalized = extractErrorMessage(err).toLowerCase();
  // Detect common 429 shapes and WorkOS SDK message

  const statusCode = (err as any)?.status;
  return (
    statusCode === 429 ||
    normalized.includes("rate limit exceeded") ||
    normalized.includes("too many requests")
  );
};
