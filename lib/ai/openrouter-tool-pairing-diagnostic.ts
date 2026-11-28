/**
 * Count-only evidence for Bedrock tool pairing rejections. Amazon Bedrock
 * Converse accepts ToolUse/ToolResult IDs of 1-64 characters from
 * [A-Za-z0-9_.:-] and tool names from [A-Za-z0-9_-]. Raw IDs and names stay in
 * memory for comparison only; they, their hashes, and message content are
 * never reported.
 */
const BEDROCK_TOOL_ID_ALPHABET = /^[A-Za-z0-9_.:-]+$/;
const BEDROCK_TOOL_ID_MAX_LENGTH = 64;
const BEDROCK_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Longer values are counted as over-length without scanning their alphabet. */
const MAX_INSPECTED_STRING_LENGTH = 1024;
const MAX_NODES = 16_384;
const MAX_ERROR_TEXT_LENGTH = 16 * 1024;

type Evidence = "complete" | "limited" | "unavailable";

export type BedrockToolPairingCounts = {
  evidence: Evidence;
  message_count: number;
  assistant_tool_call_count: number;
  tool_result_count: number;
  unmatched_tool_call_count: number;
  unmatched_tool_result_count: number;
  duplicate_tool_call_id_in_turn_count: number;
  cross_turn_duplicate_tool_call_id_count: number;
  duplicate_tool_result_id_count: number;
  missing_tool_id_count: number;
  tool_id_over_64_count: number;
  tool_id_invalid_alphabet_count: number;
  max_tool_id_length: number;
  tool_definition_count: number;
  invalid_tool_definition_name_count: number;
  invalid_tool_call_name_count: number;
  invalid_tool_result_name_count: number;
  undeclared_tool_call_name_count: number;
};

class Unreadable extends Error {}
class Exhausted extends Error {}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Read only own data properties; a getter cannot run or supply evidence. */
function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Unreadable();
  return descriptor?.value;
}

function ownArray(value: object, key: string): unknown[] | undefined {
  const array = ownValue(value, key);
  if (array === undefined || array === null) return undefined;
  if (!Array.isArray(array)) throw new Unreadable();
  return array;
}

function isValidName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= 64 &&
    BEDROCK_TOOL_NAME_PATTERN.test(name)
  );
}

const zeroCounts = (evidence: Evidence): BedrockToolPairingCounts => ({
  evidence,
  message_count: 0,
  assistant_tool_call_count: 0,
  tool_result_count: 0,
  unmatched_tool_call_count: 0,
  unmatched_tool_result_count: 0,
  duplicate_tool_call_id_in_turn_count: 0,
  cross_turn_duplicate_tool_call_id_count: 0,
  duplicate_tool_result_id_count: 0,
  missing_tool_id_count: 0,
  tool_id_over_64_count: 0,
  tool_id_invalid_alphabet_count: 0,
  max_tool_id_length: 0,
  tool_definition_count: 0,
  invalid_tool_definition_name_count: 0,
  invalid_tool_call_name_count: 0,
  invalid_tool_result_name_count: 0,
  undeclared_tool_call_name_count: 0,
});

/**
 * Describe the OpenRouter chat body built by @openrouter/ai-sdk-provider:
 * assistant `tool_calls[].id` / `function.name`, `role: "tool"` messages with
 * `tool_call_id` / `name`, and `tools[].function.name`. A tool call must be
 * answered by the contiguous tool messages that follow its assistant message.
 */
export function describeBedrockToolPairing(
  body: unknown,
): BedrockToolPairingCounts {
  if (!isObject(body)) return zeroCounts("unavailable");
  const counts = zeroCounts("complete");
  let nodes = MAX_NODES;
  const visit = () => {
    if (--nodes < 0) throw new Exhausted();
  };
  const inspectId = (id: unknown): string | undefined => {
    if (typeof id !== "string" || id.length === 0) {
      counts.missing_tool_id_count++;
      return undefined;
    }
    counts.max_tool_id_length = Math.max(
      counts.max_tool_id_length,
      Math.min(id.length, MAX_INSPECTED_STRING_LENGTH + 1),
    );
    if (id.length > BEDROCK_TOOL_ID_MAX_LENGTH) counts.tool_id_over_64_count++;
    if (id.length > MAX_INSPECTED_STRING_LENGTH) {
      counts.evidence = "limited";
      return undefined;
    }
    if (!BEDROCK_TOOL_ID_ALPHABET.test(id)) {
      counts.tool_id_invalid_alphabet_count++;
    }
    return id;
  };

  try {
    const declared = new Set<string>();
    const tools = ownArray(body, "tools") ?? [];
    for (let index = 0; index < tools.length; index++) {
      visit();
      const tool = ownValue(tools, String(index));
      const fn = isObject(tool) ? ownValue(tool, "function") : undefined;
      if (!isObject(fn)) continue;
      counts.tool_definition_count++;
      const name = ownValue(fn, "name");
      if (isValidName(name)) declared.add(name);
      else counts.invalid_tool_definition_name_count++;
    }

    const messages = ownArray(body, "messages");
    if (!messages) return zeroCounts("unavailable");
    const earlierTurnCallIds = new Set<string>();
    let pending = new Set<string>();
    let answered = new Set<string>();
    const closeTurn = () => {
      counts.unmatched_tool_call_count += pending.size;
      pending = new Set();
      answered = new Set();
    };
    try {
      for (let index = 0; index < messages.length; index++) {
        visit();
        const message = ownValue(messages, String(index));
        counts.message_count++;
        const role = isObject(message) ? ownValue(message, "role") : undefined;
        if (role === "tool" && isObject(message)) {
          counts.tool_result_count++;
          const name = ownValue(message, "name");
          if (name !== undefined && !isValidName(name))
            counts.invalid_tool_result_name_count++;
          const id = inspectId(ownValue(message, "tool_call_id"));
          if (id === undefined) continue;
          if (pending.delete(id)) answered.add(id);
          else if (answered.has(id)) counts.duplicate_tool_result_id_count++;
          else counts.unmatched_tool_result_count++;
          continue;
        }
        closeTurn();
        if (role !== "assistant" || !isObject(message)) continue;
        const calls = ownArray(message, "tool_calls") ?? [];
        const turnIds = new Set<string>();
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
          visit();
          const call = ownValue(calls, String(callIndex));
          counts.assistant_tool_call_count++;
          const fn = isObject(call) ? ownValue(call, "function") : undefined;
          const name = isObject(fn) ? ownValue(fn, "name") : undefined;
          if (!isValidName(name)) counts.invalid_tool_call_name_count++;
          else if (declared.size > 0 && !declared.has(name))
            counts.undeclared_tool_call_name_count++;
          const id = inspectId(
            isObject(call) ? ownValue(call, "id") : undefined,
          );
          if (id === undefined) continue;
          if (turnIds.has(id)) counts.duplicate_tool_call_id_in_turn_count++;
          else if (earlierTurnCallIds.has(id))
            counts.cross_turn_duplicate_tool_call_id_count++;
          turnIds.add(id);
        }
        for (const id of turnIds) earlierTurnCallIds.add(id);
        pending = turnIds;
      }
      closeTurn();
    } catch (error) {
      if (!(error instanceof Exhausted)) throw error;
      // Unvisited results may answer pending calls; do not count them unmatched.
      counts.evidence = "limited";
    }
    return counts;
  } catch (error) {
    if (error instanceof Exhausted) {
      counts.evidence = "limited";
      return counts;
    }
    return zeroCounts("unavailable");
  }
}

function boundedOwnText(value: object, key: string): string | undefined {
  const text = ownValue(value, key);
  return typeof text === "string" && text.length <= MAX_ERROR_TEXT_LENGTH
    ? text
    : undefined;
}

/** Recognize the SDK's HTTP 400 error or a returned stream error part. */
function hasToolPairingMarker(text: string): boolean {
  return (
    /\bunmatched\b/.test(text) && /\binvalid_tool_(?:result|call)\b/.test(text)
  );
}

export function isBedrockToolPairingRejection(error: unknown): boolean {
  if (!isObject(error)) return false;
  try {
    // APICallError carries statusCode; an in-band error part carries code.
    const status = ownValue(error, "statusCode") ?? ownValue(error, "code");
    if (status !== 400 && status !== "400") return false;
    const texts = [
      boundedOwnText(error, "message"),
      boundedOwnText(error, "responseBody"),
    ];
    return texts.some(
      (text) => text !== undefined && hasToolPairingMarker(text),
    );
  } catch {
    return false;
  }
}

/** The SDK attaches the body it built as own `requestBodyValues` on HTTP errors. */
export function ownRequestBodyValues(error: unknown): unknown {
  if (!isObject(error)) return undefined;
  try {
    return ownValue(error, "requestBodyValues");
  } catch {
    return undefined;
  }
}

/** The SDK returns the body it built as own `request.body` on stream results. */
export function ownStreamRequestBody(result: unknown): unknown {
  if (!isObject(result)) return undefined;
  try {
    const request = ownValue(result, "request");
    return isObject(request) ? ownValue(request, "body") : undefined;
  } catch {
    return undefined;
  }
}

const reportedErrors = new WeakSet<object>();

/** Report at most once per error object; never throws. */
export function reportBedrockToolPairingRejection(
  error: unknown,
  source: "sdk_http_rejection" | "sdk_error_part",
  readBody: () => unknown,
): boolean {
  try {
    if (!isBedrockToolPairingRejection(error) || !isObject(error)) return false;
    if (reportedErrors.has(error)) return false;
    reportedErrors.add(error);
    console.warn(
      JSON.stringify({
        event: "openrouter_bedrock_tool_pairing_diagnostic",
        diagnostic_version: 1,
        source,
        ...describeBedrockToolPairing(readBody()),
      }),
    );
    return true;
  } catch {
    return false;
  }
}
