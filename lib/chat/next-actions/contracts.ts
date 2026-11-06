import { z } from "zod";

export const NEXT_ACTIONS_FLAG = "contextual-next-actions";
export const NEXT_ACTIONS_VERSION = 1;
// Legacy field name: this versions the saved prediction format/behavior, not truth or authorization.
export const NEXT_ACTIONS_VALIDATION_VERSION = 3;
export const nextActionsRequestSchema = z
  .object({
    chatId: z.string().uuid(),
    restoreOnly: z.boolean().optional(),
    messageId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[\w-]+$/),
  })
  .strict();
export const nextActionsResponseSchema = z.object({
  batchId: z.string(),
  messageId: z.string(),
  mode: z.enum(["ask", "agent"]),
  validationVersion: z.number().int().optional(),
  suggestions: z.array(z.string().trim().min(1).max(240)).max(3),
});
export type NextActionsBatch = z.infer<typeof nextActionsResponseSchema>;
export const emptyNextActionsResponseSchema = z.object({
  suggestions: z.array(z.never()).max(0),
});
export type CompletedPredictionTurn = { chatId: string; messageId: string };

export const predictedNextActionSchema = z
  .object({
    suggestion: z.string().max(240).nullable(),
  })
  .strict();

type ContextMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: unknown[];
};
export type PredictionSource = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const OMITTED_TEXT =
  "\n[... middle omitted; do not infer missing context ...]\n";

/** Keep the opening scope and the closing corrections/conclusion verbatim. */
function excerpt(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const available = budget - OMITTED_TEXT.length;
  if (available <= 0) return "";
  const headLength = Math.floor(available / 3);
  const tailLength = available - headLength;
  // Avoid producing unpaired UTF-16 surrogates at either cut.
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-tailLength).replace(/^[\uDC00-\uDFFF]/, "");
  return head + OMITTED_TEXT + tail;
}

/** Recent persisted messages only. No reasoning, attachments, system messages,
 * tool inputs, or arbitrary tool outputs. Existing finding results provide IDs. */
export function buildPredictionSources(
  newestFirst: ContextMessage[],
): PredictionSource[] {
  const messages = newestFirst.slice(0, 6).flatMap((message) => {
    if (message.role === "system") return [];
    const textParts: string[] = [];
    const findingParts: string[] = [];
    for (const value of message.parts) {
      if (!value || typeof value !== "object") continue;
      const part = value as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string")
        textParts.push(part.text);
      else if (
        typeof part.type === "string" &&
        [
          "tool-create_vulnerability_report",
          "tool-list_reports",
          "tool-get_report",
          "tool-update_vulnerability_report",
        ].includes(part.type) &&
        part.state === "output-available" &&
        part.output
      ) {
        // Persisted outputs are JSON. An unexpected malformed result must not
        // prevent the actual answer from providing context.
        try {
          findingParts.push(JSON.stringify(part.output));
        } catch {
          /* Ignore a non-JSON finding output. */
        }
      }
    }
    const text = textParts.join("\n");
    const findings = findingParts.join("\n");
    return text.trim() || findings
      ? [{ id: message.id, role: message.role, text, findings }]
      : [];
  });
  const sources: PredictionSource[] = [];
  let remaining = 12_000;
  for (const [index, message] of messages.entries()) {
    // Reserve context for every recent turn instead of dropping the user's
    // earlier scope/intent after three long assistant messages.
    const reserved = messages
      .slice(index + 1)
      .reduce(
        (sum, older) =>
          sum +
          Math.min(
            1_000,
            older.text.length +
              older.findings.length +
              (older.text && older.findings ? 1 : 0),
          ),
        0,
      );
    const budget = Math.min(4_000, remaining - reserved);
    // Findings cannot crowd out the final answer, including on older turns
    // with a smaller budget. Clip each original span only once so an omission
    // marker cannot itself be cut into apparent source evidence.
    const findings = excerpt(
      message.findings,
      Math.min(1_000, message.text ? Math.floor(budget / 4) : budget),
    );
    const text = [
      excerpt(message.text, budget - findings.length - (findings ? 1 : 0)),
      findings,
    ]
      .filter(Boolean)
      .join("\n");
    remaining -= text.length;
    if (text.trim()) sources.push({ id: message.id, role: message.role, text });
  }
  return sources.reverse();
}

/** A prediction is editable user text; it never establishes facts or grants access. */
export function parsePredictedNextAction(output: unknown): string[] {
  const parsed = predictedNextActionSchema.safeParse(output);
  if (!parsed.success || parsed.data.suggestion === null) return [];
  const text = parsed.data.suggestion.trim();
  if (!text || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text))
    return [];
  // Composer commands have their own explicit entry flow; a prediction cannot select one.
  if (/^\/|(?:^|\s)\/goal(?=\s|$)/i.test(text)) return [];
  return [text];
}

/** Avoid spending or showing a new draft after an explicit conversational stop. */
export function hasExplicitPredictionStop(
  sources: PredictionSource[],
): boolean {
  const latest =
    sources.findLast((source) => source.role === "user")?.text ?? "";
  return (
    /(?:[,;.!?]\s*|\n)(?:and\s+)?(?:then\s+)?stop(?:\s+(?:here|there))?[.!]?\s*$/i.test(
      latest,
    ) ||
    /\b(?:no more (?:suggestions|questions|follow[ -]?ups)|do not (?:add (?:another|any|more) (?:question|suggestion)|continue)|without (?:any )?follow[ -]?ups?)\b/i.test(
      latest,
    ) ||
    /\bI(?:['’]m| am) done[.!]?\s*$/i.test(latest) ||
    /\b(?:and|then)\s+stop(?:\s+(?:here|there))?[.!]?\s*$/i.test(latest) ||
    /^(?:thanks[,.!]\s*)?(?:please\s+)?(?:cancel|stop)(?:\s+(?:that|this)(?:\s+(?:task|request|review))?)?[.!]?\s*$/i.test(
      latest.trim(),
    ) ||
    /\bno more on this[.!]?\s*$/i.test(latest) ||
    /\bdo not suggest (?:a |any )?follow[ -]?ups?\b/i.test(latest)
  );
}
