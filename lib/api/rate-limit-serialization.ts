import type { RateLimitInfo } from "@/types";

/** Serializable rate limit info (Date -> ISO string) for cross-boundary payloads */
export type SerializableRateLimitInfo = Omit<
  RateLimitInfo,
  "resetTime" | "monthly"
> & {
  resetTime: string;
  monthly?: {
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
    monthly: info.monthly
      ? {
          ...info.monthly,
          resetTime:
            typeof info.monthly.resetTime === "string"
              ? info.monthly.resetTime
              : info.monthly.resetTime.toISOString(),
        }
      : undefined,
  };
}

export function deserializeRateLimitInfo(info: SerializableRateLimitInfo): {
  remaining: number;
  resetTime: Date;
  limit: number;
  monthly?: { remaining: number; limit: number; resetTime: Date };
  extraUsagePointsDeducted?: number;
} {
  return {
    ...info,
    resetTime: new Date(info.resetTime),
    monthly: info.monthly
      ? {
          ...info.monthly,
          resetTime: new Date(info.monthly.resetTime),
        }
      : undefined,
  };
}
