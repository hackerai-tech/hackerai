import type { ModelMessage, UIMessage } from "ai";
import {
  getProviderRequestMediaCounts,
  type ProviderImageReferenceMatchCounts,
} from "./provider-request-media";

export interface ProviderFailedImageReferenceDiagnostics {
  diagnostic_version: 1;
  status:
    | "matched"
    | "unmatched"
    | "redacted"
    | "unavailable"
    | "ambiguous"
    | "bounded"
    | "unreadable";
  candidate_count?: "none" | "one" | "multiple";
  observation?: "error_boundary";
  matches?: ProviderImageReferenceMatchCounts;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Correlate a provider's explicit failure candidate with prepared input only.
 * No URL, host, path, error text, image contents or identifiers leave this function.
 * A match/expiry hint is neither an authorization receipt nor proof of a 403 cause.
 */
export function getProviderFailedImageReferenceDiagnostics(
  error: unknown,
  messages: readonly ModelMessage[],
  sourceMessages?: readonly UIMessage[],
  nowMs = Date.now(),
): ProviderFailedImageReferenceDiagnostics | undefined {
  const result = (
    status: ProviderFailedImageReferenceDiagnostics["status"],
  ): ProviderFailedImageReferenceDiagnostics => ({
    diagnostic_version: 1,
    status,
  });
  try {
    let unreadable = false;
    let bounded = false;
    const own = (value: unknown, key: string): unknown => {
      if (typeof value !== "object" || value === null) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && !("value" in descriptor)) unreadable = true;
      return descriptor?.value;
    };
    // One aggregate node/depth/text budget for the entire retry/cause graph.
    const sources: Array<{ value: Record<string, unknown>; depth: number }> =
      [];
    const seen = new WeakSet<object>();
    const add = (value: unknown, depth: number) => {
      if (!record(value) || seen.has(value)) return;
      if (depth > 3 || sources.length >= 8) {
        bounded = true;
        return;
      }
      seen.add(value);
      sources.push({ value, depth });
    };
    add(error, 0);
    for (let i = 0; i < sources.length; i++) {
      const { value, depth } = sources[i];
      for (const key of ["cause", "error"]) add(own(value, key), depth + 1);
      const errors = own(value, "errors");
      if (Array.isArray(errors)) {
        const length = own(errors, "length");
        if (
          typeof length !== "number" ||
          !Number.isSafeInteger(length) ||
          length < 0
        )
          unreadable = true;
        else {
          if (length > 8) bounded = true;
          for (let j = 0; j < Math.min(length, 8); j++)
            add(own(errors, String(j)), depth + 1);
        }
      }
    }
    if (bounded) return result("bounded");
    let remaining = 65_536;
    const consume = (text: string) => {
      remaining -= text.length;
      if (remaining < 0) bounded = true;
      return !bounded;
    };
    let imageFetch = false;
    let redacted = false;
    const candidates = new Set<string>();
    const inspectMessage = (value: unknown) => {
      if (typeof value !== "string" || !consume(value)) return;
      if (
        !/\b(?:fetch(?:ing)?|download(?:ing)?)\b[\s\S]{0,80}\bimage\b|\bimage\b[\s\S]{0,80}\b(?:fetch|download)/i.test(
          value,
        )
      )
        return;
      imageFetch = true;
      redacted ||= value.includes("[Redacted signed URL]");
      if (candidates.size > 1) return;
      for (const match of value.matchAll(/https?:\/\/[^\s"<>\\]+/gi)) {
        let url = match[0];
        // Strip only the provider's surrounding single-quote delimiter; do not
        // decode, refresh, reorder query parameters or try guessed URL variants.
        if (value[match.index! - 1] === "'") {
          const end = url.lastIndexOf("'");
          if (
            end >= 0 &&
            /^(?::(?:HTTP)?[1-5]\d{2}|:)?$/i.test(url.slice(end + 1))
          )
            url = url.slice(0, end);
        }
        if (url.length > 8192) {
          bounded = true;
          return;
        }
        try {
          if (!/^https?:$/.test(new URL(url).protocol)) continue;
        } catch {
          continue;
        }
        candidates.add(url);
        if (candidates.size > 1) return;
      }
    };
    const inspectPayload = (payload: unknown) => {
      const nested = own(payload, "error");
      if (!record(nested)) return;
      inspectMessage(own(nested, "message"));
      const raw = own(own(nested, "metadata"), "raw");
      if (typeof raw === "string" && consume(raw)) {
        try {
          const parsed: unknown = JSON.parse(raw);
          inspectMessage(
            own(own(parsed, "error"), "message") ?? own(parsed, "message"),
          );
        } catch {
          inspectMessage(raw);
        }
      }
    };
    for (const { value } of sources) {
      inspectPayload(value);
      inspectPayload(own(value, "data"));
      const body = own(value, "responseBody");
      if (typeof body === "string" && consume(body)) {
        try {
          inspectPayload(JSON.parse(body));
        } catch {
          /* malformed body is censored */
        }
      }
      if (bounded) return result("bounded");
    }
    if (unreadable) return result("unreadable");
    if (!imageFetch) return undefined;
    if (candidates.size > 1)
      return { ...result("ambiguous"), candidate_count: "multiple" };
    // A redacted candidate beside an explicit URL may refer to a different
    // image; do not assign that explicit URL's role to the hidden candidate.
    if (redacted && candidates.size === 1)
      return { ...result("ambiguous"), candidate_count: "one" };
    if (candidates.size === 0)
      return {
        ...result(redacted ? "redacted" : "unavailable"),
        candidate_count: "none",
      };
    const matches = getProviderRequestMediaCounts(
      messages,
      nowMs,
      sourceMessages,
      [...candidates][0],
    ).failed_image_reference!;
    return {
      ...result(matches.image_parts > 0 ? "matched" : "unmatched"),
      candidate_count: "one",
      observation: "error_boundary",
      matches,
    };
  } catch {
    // Optional evidence must never affect refunds, cleanup, retries or rejection.
    return result("unreadable");
  }
}
