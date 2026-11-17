// Keep provenance without wrapping/mutating the error: retry classification,
// cancellation identity, frozen SDK errors and the original cause stay intact.
const readErrors = new WeakSet<object>();

/** Retain read provenance while rethrowing the identical failure to existing guards. */
export function rethrowBrowserHandoffReadError(error: unknown): never {
  if (typeof error === "object" && error !== null) readErrors.add(error);
  throw error;
}

export const isBrowserHandoffReadError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && readErrors.has(error);

// Same reach as extractErrorDetails: error/cause and the first five aggregate
// errors, with branded sources accepted up to four links from the failure.
const MAX_CAUSAL_DEPTH = 4;
const MAX_AGGREGATE_ERRORS = 5;

/** Own data values only: getters and proxy traps cannot establish provenance. */
const ownDataValue = (source: object, key: PropertyKey): unknown => {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const isArray = (value: unknown): value is unknown[] => {
  try {
    return Array.isArray(value);
  } catch {
    // Array.isArray throws for a revoked proxy.
    return false;
  }
};

/**
 * `shallowest` records the smallest depth each source was expanded at. A source
 * shared by several paths is expanded again only when reached shallower, so a
 * deeper first visit cannot hide a branded source within reach; cycles end
 * because a revisit through one is never shallower.
 */
const hasBrandedSource = (
  source: unknown,
  depth: number,
  shallowest: WeakMap<object, number>,
): boolean => {
  if (typeof source !== "object" || source === null) return false;
  if (readErrors.has(source)) return true;
  if (depth >= MAX_CAUSAL_DEPTH) return false;
  if ((shallowest.get(source) ?? Infinity) <= depth) return false;
  shallowest.set(source, depth);
  if (
    hasBrandedSource(ownDataValue(source, "error"), depth + 1, shallowest) ||
    hasBrandedSource(ownDataValue(source, "cause"), depth + 1, shallowest)
  )
    return true;
  const errors = ownDataValue(source, "errors");
  if (!isArray(errors)) return false;
  const length = ownDataValue(errors, "length");
  const count =
    typeof length === "number" ? Math.min(length, MAX_AGGREGATE_ERRORS) : 0;
  for (let index = 0; index < count; index++) {
    if (hasBrandedSource(ownDataValue(errors, index), depth + 1, shallowest))
      return true;
  }
  return false;
};

/**
 * Provider recovery cannot repair a failed local browser safety read, so a
 * failure whose bounded causal chain carries the read brand is not admitted to
 * model/provider fallback. Each failure is checked independently. Origin
 * strings are diagnostics only and never establish this trust.
 */
export const isTrustedBrowserHandoffReadFailure = (
  ...failures: unknown[]
): boolean =>
  failures.some((failure) => hasBrandedSource(failure, 0, new WeakMap()));
