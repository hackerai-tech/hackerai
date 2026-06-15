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

const MIN_CONVEX_BIGINT = -BigInt("9223372036854775808");
const MAX_CONVEX_BIGINT = BigInt("9223372036854775807");
const MAX_CONVEX_FIELD_NAME_LENGTH = 1024;
const MAX_SANITIZED_FIELD_NAME_LENGTH = 200;
const MAX_ORIGINAL_FIELD_NAME_PREVIEW_LENGTH = 512;
const RENAMED_FIELDS_METADATA_KEY = "_convex_renamed_fields";

const isValidConvexObjectFieldName = (key: string): boolean => {
  if (key.length > MAX_CONVEX_FIELD_NAME_LENGTH) return false;
  if (key.startsWith("$")) return false;

  for (let i = 0; i < key.length; i++) {
    const charCode = key.charCodeAt(i);
    if (charCode < 32 || charCode >= 127) return false;
  }

  return true;
};

const hashString = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const previewFieldName = (key: string): string =>
  key.length > MAX_ORIGINAL_FIELD_NAME_PREVIEW_LENGTH
    ? `${key.slice(0, MAX_ORIGINAL_FIELD_NAME_PREVIEW_LENGTH)}...`
    : key;

const getUniqueFieldName = (candidate: string, usedKeys: Set<string>) => {
  if (!usedKeys.has(candidate)) return candidate;

  let suffix = 1;
  while (true) {
    const suffixText = `_${suffix}`;
    const maxBaseLength = MAX_SANITIZED_FIELD_NAME_LENGTH - suffixText.length;
    const base = candidate.slice(0, Math.max(1, maxBaseLength));
    const nextCandidate = `${base}${suffixText}`;
    if (!usedKeys.has(nextCandidate)) return nextCandidate;
    suffix++;
  }
};

const sanitizeInvalidFieldName = (
  key: string,
  usedKeys: Set<string>,
): string => {
  const hash = hashString(key);
  const suffix = `_${hash}`;
  const prefix = "field_";
  const normalized = key.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  const maxBodyLength =
    MAX_SANITIZED_FIELD_NAME_LENGTH - prefix.length - suffix.length;
  const body = (normalized || "value").slice(0, Math.max(1, maxBodyLength));

  return getUniqueFieldName(`${prefix}${body}${suffix}`, usedKeys);
};

const arrayBufferViewToArrayBuffer = (view: ArrayBufferView): ArrayBuffer => {
  if (view.buffer instanceof ArrayBuffer) {
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    );
  }

  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
};

const sanitizeError = (error: Error, seen: WeakSet<object>) => {
  if (seen.has(error)) {
    return {
      error: "[Circular]",
      name: error.name || "Error",
      message: "[Circular]",
    };
  }
  seen.add(error);

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

  seen.delete(error);
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
  if (valueType === "string" || valueType === "boolean") {
    return value;
  }

  if (valueType === "bigint") {
    const bigintValue = value as bigint;
    return bigintValue >= MIN_CONVEX_BIGINT && bigintValue <= MAX_CONVEX_BIGINT
      ? bigintValue
      : bigintValue.toString();
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
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return arrayBufferViewToArrayBuffer(value);
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
  const entries = Object.entries(value as Record<string, unknown>);
  const usedKeys = new Set(
    entries
      .map(([key]) => (isValidConvexObjectFieldName(key) ? key : undefined))
      .filter((key): key is string => key !== undefined),
  );
  const renamedFields: Array<{ storedKey: string; originalKey: string }> = [];

  for (const [key, childValue] of entries) {
    const sanitizedChild = sanitizeForConvexValue(childValue, seen);
    if (sanitizedChild !== undefined) {
      if (isValidConvexObjectFieldName(key)) {
        sanitized[key] = sanitizedChild;
        continue;
      }

      const sanitizedKey = sanitizeInvalidFieldName(key, usedKeys);
      usedKeys.add(sanitizedKey);
      sanitized[sanitizedKey] = sanitizedChild;
      renamedFields.push({
        storedKey: sanitizedKey,
        originalKey: previewFieldName(key),
      });
    }
  }

  if (renamedFields.length > 0) {
    const metadataKey = getUniqueFieldName(
      RENAMED_FIELDS_METADATA_KEY,
      usedKeys,
    );
    sanitized[metadataKey] = renamedFields;
  }

  if (!isPlainObject(value) && Object.keys(sanitized).length === 0) {
    seen.delete(value);
    return String(value);
  }

  seen.delete(value);
  return sanitized;
}
