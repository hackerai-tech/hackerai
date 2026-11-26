const UNPAIRED_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const MAX_CHARACTERS = 2 * 1024 * 1024;
const MAX_NODES = 16_384;
const MAX_DEPTH = 24;

type Evidence = "present" | "absent" | "limited" | "unavailable";
type Budget = { characters: number; nodes: number };

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor))
    throw new Error("Unreadable request field");
  return descriptor?.value;
}

function inspectText(value: string, budget: Budget): Evidence {
  budget.characters -= value.length;
  if (budget.characters < 0) return "limited";
  return UNPAIRED_HIGH_SURROGATE.test(value) ? "present" : "absent";
}

function inspectValue(value: unknown, budget: Budget, depth = 0): Evidence {
  if (--budget.nodes < 0 || depth > MAX_DEPTH) return "limited";
  if (typeof value === "string") return inspectText(value, budget);
  if (value === null || typeof value !== "object") return "absent";
  if (Array.isArray(value) && value.length > budget.nodes) return "limited";
  const keys = Object.keys(value);
  if (keys.length > budget.nodes) return "limited";
  for (const key of keys) {
    const keyEvidence = inspectText(key, budget);
    if (keyEvidence !== "absent") return keyEvidence;
    const valueEvidence = inspectValue(ownValue(value, key), budget, depth + 1);
    if (valueEvidence !== "absent") return valueEvidence;
  }
  return "absent";
}

function inspectNestedJson(
  value: unknown,
  budget: Budget,
  requiredJson: boolean,
): Evidence {
  if (typeof value !== "string") return "unavailable";
  budget.characters -= value.length;
  if (budget.characters < 0) return "limited";
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    // Tool content can also be plain text. Function arguments must be JSON.
    return requiredJson ? "unavailable" : "absent";
  }
  return inspectValue(decoded, budget);
}

function combine(current: Evidence, incoming: Evidence): Evidence {
  if (current === "present" || incoming === "present") return "present";
  if (current === "limited" || incoming === "limited") return "limited";
  if (current === "unavailable" || incoming === "unavailable")
    return "unavailable";
  return "absent";
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/**
 * Inspect the SDK-built request for a known error without retaining any field
 * names or values. A positive result in a nested layer requires JSON decoding.
 */
export function describeOpenRouterRequestJsonEscape(body: unknown): {
  outer: Evidence;
  tool_arguments_json: Evidence;
  tool_content_json: Evidence;
} {
  const unavailable = {
    outer: "unavailable",
    tool_arguments_json: "unavailable",
    tool_content_json: "unavailable",
  } as const;
  if (!isObject(body)) return unavailable;
  try {
    const budget = { characters: MAX_CHARACTERS, nodes: MAX_NODES };
    const outer = inspectValue(body, budget);
    const messages = ownValue(body, "messages");
    if (!Array.isArray(messages)) return { ...unavailable, outer };

    let argumentsEvidence: Evidence = "absent";
    let contentEvidence: Evidence = "absent";
    for (let index = 0; index < messages.length; index++) {
      if (--budget.nodes < 0 || budget.characters < 0) {
        argumentsEvidence = combine(argumentsEvidence, "limited");
        contentEvidence = combine(contentEvidence, "limited");
        break;
      }
      const message = ownValue(messages, String(index));
      if (!isObject(message)) continue;
      const role = ownValue(message, "role");
      if (role === "tool") {
        contentEvidence = combine(
          contentEvidence,
          inspectNestedJson(ownValue(message, "content"), budget, false),
        );
      }
      if (role !== "assistant") continue;
      const calls = ownValue(message, "tool_calls");
      if (!Array.isArray(calls)) continue;
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        if (--budget.nodes < 0 || budget.characters < 0) {
          argumentsEvidence = combine(argumentsEvidence, "limited");
          break;
        }
        const call = ownValue(calls, String(callIndex));
        const fn = isObject(call) ? ownValue(call, "function") : undefined;
        const value = isObject(fn) ? ownValue(fn, "arguments") : undefined;
        argumentsEvidence = combine(
          argumentsEvidence,
          inspectNestedJson(value, budget, true),
        );
      }
    }

    return {
      outer,
      tool_arguments_json: argumentsEvidence,
      tool_content_json: contentEvidence,
    };
  } catch {
    return unavailable;
  }
}

export function isOpenRouterJsonEscapeRejection(error: unknown): boolean {
  if (!isObject(error)) return false;
  const code = ownValue(error, "code");
  const message = ownValue(error, "message");
  return (
    (code === 400 || code === "400") &&
    typeof message === "string" &&
    message.length <= 4096 &&
    message.includes("unexpected end of hex escape")
  );
}
