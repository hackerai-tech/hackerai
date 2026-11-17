/**
 * Optional, versioned self-report a preview client attaches to its capture GET:
 * which committed `showPreview` conditions were true at dispatch and which
 * public bundle commit it loaded. These describe the client's polling decision,
 * not physical browser execution or visible pixels. The server treats them as
 * untrusted diagnostics only; they never affect auth, session selection,
 * capture, caching or the response.
 */

export const PREVIEW_DIAGNOSTIC_VERSION_PARAM = "preview_diag_v";
export const PREVIEW_ACTIVATION_PARAM = "preview_activation";
export const PREVIEW_READER_PARAM = "preview_reader";
/** The single String log attribute holding the canonical `[1,mask,reader]` tuple. */
export const PREVIEW_CLIENT_CONTEXT_KEY = "preview_client_context";

const UNKNOWN_READER = "unknown";
// Leaves room for the logger's own prefix/common/correlation attributes under
// its global 80-attribute cap, so the tuple can never displace existing fields.
const MAX_BASELINE_FIELDS = 70;

/** Bits 1|2|4 may combine; at most one handoff-state bit (8..128) is set. */
function stateBit(state: unknown) {
  switch (state) {
    case "waiting":
      return 8;
    case "claiming":
      return 16;
    case "human":
      return 32;
    case "recovery":
      return 64;
    case "resuming":
      return 128;
    default:
      return 0;
  }
}

/** Encode the exact `showPreview` sources. Agent/closed/unknown states add 0. */
export function previewActivationMask({
  browserRequested,
  fullScreen,
  hasTakenControl,
  sessionState,
}: {
  browserRequested: boolean;
  fullScreen: boolean;
  hasTakenControl: boolean;
  sessionState: unknown;
}): number {
  return (
    (browserRequested === true ? 1 : 0) |
    (fullScreen === true ? 2 : 0) |
    (hasTakenControl === true ? 4 : 0) |
    stateBit(sessionState)
  );
}

/** Closed 48-value domain: any boolean combination with zero or one state bit. */
function isActivationMask(mask: number) {
  if (!Number.isInteger(mask) || mask < 0 || mask > 255) return false;
  const state = mask & 0xf8;
  return (
    state === 0 ||
    state === 8 ||
    state === 16 ||
    state === 32 ||
    state === 64 ||
    state === 128
  );
}

function normalizeReader(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === UNKNOWN_READER) return value;
  return value.length === 40 && /^[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

/**
 * Build the capture GET URL. `fresh=1` keeps its existing name and value so
 * older servers read it unchanged; they ignore the additional optional keys.
 * The reader is the caller's loaded public build commit, or `unknown`.
 */
export function previewCaptureUrl(
  endpoint: string,
  fresh: boolean,
  activationMask: number,
  loadedBuildCommit: unknown,
): string {
  const query = new URLSearchParams();
  if (fresh) query.set("fresh", "1");
  if (isActivationMask(activationMask)) {
    query.set(PREVIEW_DIAGNOSTIC_VERSION_PARAM, "1");
    query.set(PREVIEW_ACTIVATION_PARAM, `${activationMask}`);
    query.set(
      PREVIEW_READER_PARAM,
      normalizeReader(loadedBuildCommit) ?? UNKNOWN_READER,
    );
  }
  const search = query.toString();
  return search ? `${endpoint}?${search}` : endpoint;
}

/** Exactly one value, bounded before any pattern or number parsing. */
function single(
  params: URLSearchParams,
  name: string,
  maxLength: number,
): string | undefined {
  const values = params.getAll(name);
  if (values.length !== 1) return undefined;
  const value = values[0];
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

/**
 * Strictly decode the optional group into its canonical tuple, or nothing.
 * Absent, partial, duplicated, future-version or noncanonical input drops the
 * whole group. Unrelated query keys are never read.
 */
export function parsePreviewClientContext(
  params: URLSearchParams,
): string | undefined {
  try {
    const version = single(params, PREVIEW_DIAGNOSTIC_VERSION_PARAM, 1);
    const activation = single(params, PREVIEW_ACTIVATION_PARAM, 3);
    const reader = single(params, PREVIEW_READER_PARAM, 40);
    if (version !== "1" || activation === undefined || reader === undefined)
      return undefined;
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(activation)) return undefined;
    const mask = Number(activation);
    if (!isActivationMask(mask)) return undefined;
    const normalizedReader = normalizeReader(reader);
    if (normalizedReader === undefined) return undefined;
    return `[1,${mask},"${normalizedReader}"]`;
  } catch {
    return undefined;
  }
}

/**
 * Return the existing diagnostic fields, appending the validated tuple last
 * only when the baseline leaves conservative logger headroom. Otherwise (or on
 * any failure) return the original object unchanged; never throws.
 */
export function withPreviewClientContext<T extends Record<string, unknown>>(
  fields: T,
  params: URLSearchParams,
): T {
  try {
    const context = parsePreviewClientContext(params);
    if (
      context === undefined ||
      Object.prototype.hasOwnProperty.call(
        fields,
        PREVIEW_CLIENT_CONTEXT_KEY,
      ) ||
      Object.keys(fields).length > MAX_BASELINE_FIELDS
    )
      return fields;
    return { ...fields, [PREVIEW_CLIENT_CONTEXT_KEY]: context };
  } catch {
    return fields;
  }
}
