/**
 * Optional, versioned self-report a preview client attaches to its capture GET:
 * which committed `showPreview` conditions were true at dispatch and which
 * public bundle commit it loaded, plus, only beside browserRequested, which
 * terminal input field produced the display text and whether the selection
 * followed the live edge, and for a live command, its closed invocation shape.
 * These describe the client's polling decision, not physical browser
 * execution or visible pixels. The server treats them as untrusted
 * diagnostics only; they never affect auth, session selection, capture,
 * caching or the response.
 */

import { AGENT_BROWSER_PREVIEW_INTENTS } from "@/lib/utils/agent-browser-command";

export const PREVIEW_DIAGNOSTIC_VERSION_PARAM = "preview_diag_v";
export const PREVIEW_ACTIVATION_PARAM = "preview_activation";
export const PREVIEW_READER_PARAM = "preview_reader";
/**
 * Optional add-on, valid only beside the browserRequested bit: `1.<source>.<1|0>`.
 * Older servers ignore it; a missing or invalid value keeps the v1 base.
 */
export const PREVIEW_TEXT_SOURCE_PARAM = "preview_text_source";
/**
 * The single String log attribute holding the canonical `[1,mask,reader]`
 * tuple. A valid text-source add-on is appended as a fourth element,
 * `[1,source,liveSelection]`; positions 0-2 never change, so v1 readers that
 * read those positions are unaffected.
 */
export const PREVIEW_CLIENT_CONTEXT_KEY = "preview_client_context";
/**
 * Optional add-on `1.<intent>`: the closed shape of the selected live command
 * (`AgentBrowserPreviewIntent`), sent only beside the browserRequested bit and
 * a `command` source at the live edge. Older servers ignore it.
 */
export const PREVIEW_TERMINAL_INTENT_PARAM = "preview_terminal_intent";
/**
 * Separate String log attribute `[1,"<intent>"]`, appended after the client
 * context only when that context carried a live `command` source. It never
 * changes the `preview_client_context` value.
 */
export const PREVIEW_TERMINAL_INTENT_KEY = "preview_terminal_intent";

/**
 * The selected terminal's producer tag (`SidebarTerminal.commandSource`) for
 * the text that set browserRequested: its command (shell or legacy), the brief
 * an empty command fell back to, the brief an interactive action shows, or
 * `unavailable` when the producer chose a label or set no tag. Provenance
 * only, never the text itself.
 */
export const PREVIEW_TEXT_SOURCES = [
  "command",
  "brief",
  "interactive_brief",
  "unavailable",
] as const;
export type PreviewTextSource = (typeof PREVIEW_TEXT_SOURCES)[number];

/** Closed 8-value domain: canonical query value → canonical tuple element. */
const TEXT_SOURCE_ADD_ONS = new Map<string, string>(
  PREVIEW_TEXT_SOURCES.flatMap((source) =>
    [true, false].map(
      (live) =>
        [`1.${source}.${live ? 1 : 0}`, `[1,"${source}",${live}]`] as const,
    ),
  ),
);
const MAX_TEXT_SOURCE_LENGTH = Math.max(
  ...[...TEXT_SOURCE_ADD_ONS.keys()].map((value) => value.length),
);
/** The only text-source add-on that admits a terminal intent. */
const LIVE_COMMAND_TEXT_SOURCE = "1.command.1";

/** Closed 5-value domain: canonical query value → canonical attribute value. */
const TERMINAL_INTENTS = new Map<string, string>(
  AGENT_BROWSER_PREVIEW_INTENTS.map(
    (intent) => [`1.${intent}`, `[1,"${intent}"]`] as const,
  ),
);
const MAX_TERMINAL_INTENT_LENGTH = Math.max(
  ...[...TERMINAL_INTENTS.keys()].map((value) => value.length),
);

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
 * Functional, not diagnostic: a fresh passive Agent-state preview may accept a
 * 202 deferral while the selected session runs a verified WAIT. The server
 * re-checks state and run independently; older servers ignore the key.
 */
export const PREVIEW_DEFER_WAIT_PARAM = "deferWait";

/**
 * Build the capture GET URL. `fresh=1` keeps its existing name and value so
 * older servers read it unchanged; they ignore the additional optional keys.
 * The reader is the caller's loaded public build commit, or `unknown`.
 * `deferWait=1` is added only beside `fresh=1`. The text-source add-on is sent
 * only beside an encodable mask with the browserRequested bit; an unrecognized
 * source is reported as `unavailable`, and a non-boolean selection omits it.
 * The terminal intent is added only beside a `command` source at the live
 * edge, and only for a value in its closed domain.
 */
export function previewCaptureUrl(
  endpoint: string,
  fresh: boolean,
  activationMask: number,
  loadedBuildCommit: unknown,
  deferWait = false,
  textSource?: { source: unknown; liveSelection: unknown; intent?: unknown },
): string {
  const query = new URLSearchParams();
  if (fresh) query.set("fresh", "1");
  if (fresh && deferWait === true) query.set(PREVIEW_DEFER_WAIT_PARAM, "1");
  if (isActivationMask(activationMask)) {
    query.set(PREVIEW_DIAGNOSTIC_VERSION_PARAM, "1");
    query.set(PREVIEW_ACTIVATION_PARAM, `${activationMask}`);
    query.set(
      PREVIEW_READER_PARAM,
      normalizeReader(loadedBuildCommit) ?? UNKNOWN_READER,
    );
    const live = textSource?.liveSelection;
    if ((activationMask & 1) === 1 && typeof live === "boolean") {
      const source = PREVIEW_TEXT_SOURCES.includes(
        textSource?.source as PreviewTextSource,
      )
        ? (textSource?.source as PreviewTextSource)
        : "unavailable";
      const addOn = `1.${source}.${live ? 1 : 0}`;
      query.set(PREVIEW_TEXT_SOURCE_PARAM, addOn);
      const intent = textSource?.intent;
      if (
        addOn === LIVE_COMMAND_TEXT_SOURCE &&
        typeof intent === "string" &&
        intent.length + 2 <= MAX_TERMINAL_INTENT_LENGTH &&
        TERMINAL_INTENTS.has(`1.${intent}`)
      )
        query.set(PREVIEW_TERMINAL_INTENT_PARAM, `1.${intent}`);
    }
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

/** Exact canonical value from a closed domain, or nothing; never throws. */
function closedValue(
  params: URLSearchParams,
  name: string,
  domain: ReadonlyMap<string, string>,
  maxLength: number,
): { value: string; element: string } | undefined {
  try {
    const value = single(params, name, maxLength);
    if (value === undefined) return undefined;
    const element = domain.get(value);
    return element === undefined ? undefined : { value, element };
  } catch {
    return undefined;
  }
}

/**
 * The canonical tuple plus whether its add-on validated as a live `command`
 * source beside the browserRequested bit, the only basis for an intent.
 */
function decodePreviewClientContext(
  params: URLSearchParams,
): { tuple: string; liveCommand: boolean } | undefined {
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
    const base = `1,${mask},"${normalizedReader}"`;
    const addOn =
      (mask & 1) === 1
        ? closedValue(
            params,
            PREVIEW_TEXT_SOURCE_PARAM,
            TEXT_SOURCE_ADD_ONS,
            MAX_TEXT_SOURCE_LENGTH,
          )
        : undefined;
    return addOn === undefined
      ? { tuple: `[${base}]`, liveCommand: false }
      : {
          tuple: `[${base},${addOn.element}]`,
          liveCommand: addOn.value === LIVE_COMMAND_TEXT_SOURCE,
        };
  } catch {
    return undefined;
  }
}

/**
 * Strictly decode the optional group into its canonical tuple, or nothing.
 * Absent, partial, duplicated, future-version or noncanonical input drops the
 * whole group. The text-source add-on is read only when the decoded mask has
 * the browserRequested bit; any problem with it drops only the add-on.
 * Unrelated query keys are never read.
 */
export function parsePreviewClientContext(
  params: URLSearchParams,
): string | undefined {
  return decodePreviewClientContext(params)?.tuple;
}

/**
 * Return the existing diagnostic fields, appending the validated tuple last
 * only when the baseline leaves conservative logger headroom. The terminal
 * intent follows it only when the tuple's add-on is a live `command` source,
 * the intent is one canonical closed value, and the tuple's own budget still
 * holds afterwards, so the largest record never grows. Otherwise (or on any
 * failure) return the original object or the tuple-only result; never throws.
 */
export function withPreviewClientContext<T extends Record<string, unknown>>(
  fields: T,
  params: URLSearchParams,
): T {
  try {
    const context = decodePreviewClientContext(params);
    const has = (key: string) =>
      Object.prototype.hasOwnProperty.call(fields, key);
    const count = Object.keys(fields).length;
    if (
      context === undefined ||
      has(PREVIEW_CLIENT_CONTEXT_KEY) ||
      count > MAX_BASELINE_FIELDS
    )
      return fields;
    const withContext = {
      ...fields,
      [PREVIEW_CLIENT_CONTEXT_KEY]: context.tuple,
    };
    if (
      !context.liveCommand ||
      has(PREVIEW_TERMINAL_INTENT_KEY) ||
      count + 1 > MAX_BASELINE_FIELDS
    )
      return withContext;
    const intent = closedValue(
      params,
      PREVIEW_TERMINAL_INTENT_PARAM,
      TERMINAL_INTENTS,
      MAX_TERMINAL_INTENT_LENGTH,
    );
    return intent === undefined
      ? withContext
      : { ...withContext, [PREVIEW_TERMINAL_INTENT_KEY]: intent.element };
  } catch {
    return fields;
  }
}
