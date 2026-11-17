/**
 * Provider token counts are nonnegative whole numbers. Any other value is an
 * unknown count: callers ignore it rather than coerce it, so a malformed
 * receipt cannot lower or poison accumulated usage or context pressure.
 */
export const isValidTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
