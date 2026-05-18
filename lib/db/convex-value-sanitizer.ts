const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const primitiveErrorFieldNames = [
  "code",
  "status",
  "statusCode",
  "exitCode",
  "errno",
  "syscall",
] as const;

const sanitizeError = (error: Error, seen: WeakSet<object>) => {
  const sanitized: Record<string, unknown> = {
    error: error.message || error.name || "Error",
    name: error.name || "Error",
    message: error.message || "Error",
  };

  for (const key of primitiveErrorFieldNames) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      sanitized[key] = value;
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error) {
    sanitized.cause = sanitizeForConvexValue(cause, seen);
  }

  return sanitized;
};

/**
 * Convert arbitrary SDK/tool payloads into values Convex can persist.
 *
 * AI SDK tool parts can carry thrown Error instances in `output` when a tool
 * fails outside its normal result shape. Convex rejects class instances even
 * under `v.any()`, so normalize those objects before mutation calls.
 */
export function sanitizeForConvexValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "boolean" ||
    valueType === "bigint"
  ) {
    return value;
  }

  if (valueType === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (valueType === "function" || valueType === "symbol") {
    return String(value);
  }

  if (value instanceof Error) {
    return sanitizeError(value, seen);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return value;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const sanitized = value.map((item) => {
      const sanitizedItem = sanitizeForConvexValue(item, seen);
      return sanitizedItem === undefined ? null : sanitizedItem;
    });
    seen.delete(value);
    return sanitized;
  }

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function" && !isPlainObject(value)) {
    try {
      const jsonValue = toJSON.call(value);
      if (jsonValue !== value) {
        const sanitized = sanitizeForConvexValue(jsonValue, seen);
        seen.delete(value);
        return sanitized;
      }
    } catch {
      // Fall through to enumerable fields.
    }
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const sanitizedChild = sanitizeForConvexValue(childValue, seen);
    if (sanitizedChild !== undefined) {
      sanitized[key] = sanitizedChild;
    }
  }

  if (!isPlainObject(value) && Object.keys(sanitized).length === 0) {
    seen.delete(value);
    return String(value);
  }

  seen.delete(value);
  return sanitized;
}
