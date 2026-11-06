/** Tool history for predictions is evidence of activity, not an execution transcript.
 * Keep names/states and actual wait replies; never forward commands, file content,
 * credentials, approval tokens, or arbitrary tool payloads. */
export function predictionToolEvents(parts: unknown[]): string[] {
  const waits: string[] = [];
  const others: string[] = [];
  for (const value of parts) {
    const part = record(value);
    if (!part) continue;
    const name =
      part.type === "dynamic-tool"
        ? part.toolName
        : typeof part.type === "string" && part.type.startsWith("tool-")
          ? part.type.slice(5)
          : undefined;
    if (typeof name !== "string" || !/^[\w.:-]{1,128}$/.test(name)) continue;
    const state =
      typeof part.state === "string" && STATES.has(part.state)
        ? part.state
        : "unknown";
    const event: Record<string, unknown> = { name, state };
    const output = record(part.output);
    if (state === "output-available" && typeof output?.success === "boolean")
      event.success = output.success;
    if (name === "wait_for_user") {
      // Failed validation or denied calls do not establish that a question was shown.
      if (state === "input-available" || state === "output-available") {
        const input = record(part.input);
        if (Array.isArray(input?.questions)) {
          const questions = input.questions
            .slice(0, 8)
            .map((q) => record(q)?.question)
            .filter((q): q is string => typeof q === "string" && !!q.trim());
          if (questions.length)
            event.questions = bounded(questions.join("\n"), 200);
        }
      }
      if (state === "output-available") {
        if (output?.success === false && output.wait_outcome === "timed_out")
          event.waitOutcome = "timed_out";
        if (
          output?.success === true &&
          output.wait_outcome === "message_arrived" &&
          typeof output.reply === "string" &&
          output.reply.trim()
        ) {
          event.waitOutcome = "message_arrived";
          event.reply = bounded(output.reply, 240);
        }
      }
      waits.push(JSON.stringify(event));
    } else others.push(JSON.stringify(event));
  }
  // Preserve the latest interaction even when many intervening tools ran.
  // These are activity records, not a reconstructed chronological transcript.
  return [...waits.reverse(), ...others.reverse()];
}

const STATES = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bounded(text: string, size: number): string {
  return text.length <= size
    ? text
    : text.slice(0, size).replace(/[\uD800-\uDBFF]$/, "") + " [truncated]";
}

/** Keep whole JSON records and explicitly mark missing events, rather than
 * clipping an event into something that could be mistaken for complete evidence. */
export function renderPredictionToolContext(
  events: string[],
  budget: number,
): string {
  if (!events.length) return "";
  const prefix =
    "Tool activity (partial records; not a complete transcript):\n";
  const omitted =
    "\n[Additional tool events omitted; do not infer they did not happen.]";
  const kept: string[] = [];
  let available = budget - prefix.length - omitted.length;
  for (const event of events) {
    if (event.length + 1 > available) continue;
    kept.push(event);
    available -= event.length + 1;
  }
  return (
    prefix + kept.join("\n") + (kept.length < events.length ? omitted : "")
  );
}
