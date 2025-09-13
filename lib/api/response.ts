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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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


