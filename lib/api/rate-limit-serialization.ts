import type { RateLimitInfo } from "@/types";

/** Serializable rate limit info (Date -> ISO string) for cross-boundary payloads */
export type SerializableRateLimitInfo = Omit<
  RateLimitInfo,
  "resetTime" | "session" | "weekly"
> & {
  resetTime: string;
  session?: {
    remaining: number;
    limit: number;
    resetTime: string;
  };
  weekly?: {
    remaining: number;
    limit: number;
    resetTime: string;
  };
};

export function serializeRateLimitInfo(
  info: RateLimitInfo,
): SerializableRateLimitInfo {
  return {
    ...info,
    resetTime:
      typeof info.resetTime === "string"
        ? info.resetTime
        : info.resetTime.toISOString(),
    session: info.session
      ? {
          ...info.session,
          resetTime:
            typeof info.session.resetTime === "string"
              ? info.session.resetTime
              : info.session.resetTime.toISOString(),
        }
      : undefined,
    weekly: info.weekly
      ? {
          ...info.weekly,
          resetTime:
            typeof info.weekly.resetTime === "string"
              ? info.weekly.resetTime
              : info.weekly.resetTime.toISOString(),
        }
      : undefined,
  };
}

export function deserializeRateLimitInfo(info: SerializableRateLimitInfo): {
  remaining: number;
  resetTime: Date;
  limit: number;
  session?: { remaining: number; limit: number; resetTime: Date };
  weekly?: { remaining: number; limit: number; resetTime: Date };
  extraUsagePointsDeducted?: number;
} {
  return {
    ...info,
    resetTime: new Date(info.resetTime),
    session: info.session
      ? {
          ...info.session,
          resetTime: new Date(info.session.resetTime),
        }
      : undefined,
    weekly: info.weekly
      ? {
          ...info.weekly,
          resetTime: new Date(info.weekly.resetTime),
        }
      : undefined,
  };
}
