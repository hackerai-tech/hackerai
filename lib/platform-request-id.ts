// One or two region hops, then the opaque request ID Vercel assigns.
const VERCEL_REQUEST_ID =
  /^(?:[a-z]{3}\d::){1,2}[a-z0-9]{4,8}-\d{10,17}-[a-f0-9]{8,32}$/;

/**
 * A public `x-vercel-id` value safe to copy into diagnostics. A claimed request
 * ID is not verified platform identity; join it with platform logs.
 */
export function isPlatformRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    VERCEL_REQUEST_ID.exec(value)?.[0] === value
  );
}
