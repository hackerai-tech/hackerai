/**
 * Pure Notes recall rules shared by Convex functions and the server runtime.
 * Keep this module free of server-only imports: Convex bundles it.
 */

export const NOTE_TARGET_MAX_LENGTH = 200;
const LABEL_PREFIX = "label:";
const LABEL_MAX_LENGTH = 64;
/** Clock skew tolerated when a caller records an observation "now". */
const OBSERVED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const OBSERVED_AT_MIN = Date.UTC(2000, 0, 1);
const TASK_TEXT_SCAN_LIMIT = 20_000;
const MAX_TASK_HOSTS = 6;

export type NoteTargetResult =
  { ok: true; target: string } | { ok: false; error: string };

const TARGET_FORMAT_HINT =
  'Use an exact host ("api.example.com" or "api.example.com:8443"), an origin ("https://api.example.com"), or an engagement label ("label:acme q4").';

const isValidPort = (port: string) =>
  /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;

/** URL hostname normalization: lowercase, punycode, no trailing dot. */
const normalizeHostname = (hostname: string): string | null => {
  try {
    const parsed = new URL(`http://${hostname}`);
    const normalized = parsed.hostname.replace(/\.$/, "");
    return normalized && parsed.username === "" && parsed.password === ""
      ? normalized
      : null;
  } catch {
    return null;
  }
};

const normalizeLabel = (raw: string): string =>
  raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Normalizes optional note target metadata deterministically. Targets are
 * exact: a host never implies its parent domain, and wildcards, paths and
 * embedded credentials are rejected rather than silently broadened or stored.
 */
export function normalizeNoteTarget(raw: string): NoteTargetResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Target cannot be empty." };
  if (value.length > NOTE_TARGET_MAX_LENGTH)
    return { ok: false, error: "Target is too long." };

  if (value.toLowerCase().startsWith(LABEL_PREFIX)) {
    const label = normalizeLabel(value.slice(LABEL_PREFIX.length));
    if (!label || label.length > LABEL_MAX_LENGTH)
      return {
        ok: false,
        error: `Invalid engagement label. ${TARGET_FORMAT_HINT}`,
      };
    if (!/^[\p{L}\p{N} ._-]+$/u.test(label))
      return {
        ok: false,
        error:
          "Engagement labels may contain letters, numbers, spaces, '.', '_' and '-'.",
      };
    return { ok: true, target: `${LABEL_PREFIX}${label}` };
  }

  if (/[*\s]/.test(value))
    return {
      ok: false,
      error: `Wildcards and spaces are not allowed. ${TARGET_FORMAT_HINT}`,
    };

  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: `Invalid origin. ${TARGET_FORMAT_HINT}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { ok: false, error: "Only http and https origins are supported." };
    if (url.username || url.password)
      return { ok: false, error: "Targets must not contain credentials." };
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash)
      return {
        ok: false,
        error: `Use an origin without a path. ${TARGET_FORMAT_HINT}`,
      };
    const hostname = normalizeHostname(url.hostname);
    if (!hostname)
      return { ok: false, error: `Invalid origin. ${TARGET_FORMAT_HINT}` };
    return {
      ok: true,
      target: `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`,
    };
  }

  if (/[@/?#\\]/.test(value))
    return { ok: false, error: `Invalid host. ${TARGET_FORMAT_HINT}` };
  // Keep an explicit port even when it is a scheme default: a bare host has no scheme.
  const portMatch = value.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  const hostPart = portMatch ? portMatch[1] : value;
  const port = portMatch?.[2];
  if (port !== undefined && !isValidPort(port))
    return { ok: false, error: "Invalid port." };
  const hostname = normalizeHostname(hostPart);
  if (!hostname)
    return { ok: false, error: `Invalid host. ${TARGET_FORMAT_HINT}` };
  return { ok: true, target: port ? `${hostname}:${port}` : hostname };
}

export const isLabelTarget = (target: string) =>
  target.startsWith(LABEL_PREFIX);

const HOST_PATTERN =
  /(?<![\p{L}\p{N}_.@-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::(\d{1,5}))?(?![\p{L}\p{N}_-])/giu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/**
 * Exact target keys mentioned by the user's task. A mentioned host matches
 * notes saved for that host or its http/https origin, never a parent domain.
 */
export function extractTaskTargets(text: string): string[] {
  const scan = text.slice(0, TASK_TEXT_SCAN_LIMIT);
  const keys = new Set<string>();
  const hosts = new Set<string>();
  const addHost = (hostname: string, port?: string) => {
    if (hosts.size >= MAX_TASK_HOSTS && !hosts.has(hostname)) return;
    hosts.add(hostname);
    keys.add(hostname);
    if (port) keys.add(`${hostname}:${port}`);
    for (const scheme of ["https", "http"]) {
      keys.add(`${scheme}://${hostname}${port ? `:${port}` : ""}`);
    }
  };

  for (const match of scan.matchAll(URL_PATTERN)) {
    try {
      const url = new URL(match[0]);
      const hostname = normalizeHostname(url.hostname);
      if (!hostname || url.username || url.password) continue;
      if (hosts.size >= MAX_TASK_HOSTS && !hosts.has(hostname)) continue;
      hosts.add(hostname);
      keys.add(hostname);
      if (url.port) keys.add(`${hostname}:${url.port}`);
      keys.add(`${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`);
    } catch {
      // Not a URL; the host scan below still sees its hostname.
    }
  }
  const withoutUrls = scan.replace(URL_PATTERN, " ");
  for (const match of withoutUrls.matchAll(HOST_PATTERN)) {
    const hostname = normalizeHostname(match[1]);
    if (!hostname) continue;
    const port = match[2] && isValidPort(match[2]) ? match[2] : undefined;
    addHost(hostname, port);
  }
  return [...keys];
}

/** Labels match only as a whole phrase in the user's own task text. */
export function taskMentionsLabel(
  taskText: string,
  labelTarget: string,
): boolean {
  if (!isLabelTarget(labelTarget)) return false;
  const label = labelTarget.slice(LABEL_PREFIX.length);
  const haystack = ` ${normalizeLabel(taskText.slice(0, TASK_TEXT_SCAN_LIMIT)).replace(/[^\p{L}\p{N}._-]+/gu, " ")} `;
  const needle = ` ${label.replace(/[^\p{L}\p{N}._-]+/gu, " ")} `;
  return needle.trim().length > 0 && haystack.includes(needle);
}

export type NoteTimestampResult =
  { ok: true; value: number } | { ok: false; error: string };

/** An observation date must describe something that already happened. */
export function parseObservedAt(raw: string, now: number): NoteTimestampResult {
  const value = Date.parse(raw.trim());
  if (!Number.isFinite(value))
    return {
      ok: false,
      error: "observed_at must be an ISO 8601 date or date-time.",
    };
  if (value > now + OBSERVED_AT_FUTURE_SKEW_MS)
    return { ok: false, error: "observed_at cannot be in the future." };
  if (value < OBSERVED_AT_MIN)
    return { ok: false, error: "observed_at is implausibly old." };
  return { ok: true, value };
}

export function parseRecheckAfter(raw: string): NoteTimestampResult {
  const value = Date.parse(raw.trim());
  if (!Number.isFinite(value) || value < OBSERVED_AT_MIN)
    return {
      ok: false,
      error: "recheck_after must be an ISO 8601 date or date-time.",
    };
  return { ok: true, value };
}

type RecheckFields = {
  target?: string;
  category: string;
  observed_at?: number;
  recheck_after?: number;
};

export type RecheckState = "recheck_due" | "observation_date_unknown";

/**
 * Observations (targeted or non-general notes) need rechecking when their
 * explicit recheck date has passed or when no observation date was recorded.
 * Age alone never marks a note fixed, wrong or deletable.
 */
export function getRecheckState(
  note: RecheckFields,
  now: number,
): RecheckState | undefined {
  if (note.target === undefined && note.category === "general")
    return undefined;
  if (note.recheck_after !== undefined && note.recheck_after <= now)
    return "recheck_due";
  if (note.observed_at === undefined) return "observation_date_unknown";
  return undefined;
}

/** Code-unit cut that never splits a surrogate pair. */
export const safeCutIndex = (text: string, index: number): number => {
  const bounded = Math.max(0, Math.min(index, text.length));
  if (bounded <= 0 || bounded >= text.length) return bounded;
  const code = text.charCodeAt(bounded - 1);
  return code >= 0xd800 && code <= 0xdbff ? bounded - 1 : bounded;
};

/**
 * Longest prefix whose exact token count fits the budget. The counter is
 * injected so Convex can share this module without bundling a tokenizer.
 */
export function fitTextToTokens(
  text: string,
  maxTokens: number,
  countTokens: (value: string) => number,
): { text: string; consumed: number; truncated: boolean } {
  if (maxTokens <= 0 || !text)
    return { text: "", consumed: 0, truncated: text.length > 0 };
  if (countTokens(text) <= maxTokens)
    return { text, consumed: text.length, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = safeCutIndex(text, Math.ceil((low + high) / 2));
    if (mid <= low) break;
    if (countTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  const cut = safeCutIndex(text, low);
  return { text: text.slice(0, cut), consumed: cut, truncated: true };
}
