// Keep provenance without wrapping/mutating the error: retry classification,
// cancellation identity, frozen SDK errors and the original cause stay intact.
const readErrors = new WeakSet<object>();

export function rethrowBrowserHandoffReadError(error: unknown): never {
  if (typeof error === "object" && error !== null) readErrors.add(error);
  throw error;
}

export const isBrowserHandoffReadError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && readErrors.has(error);
