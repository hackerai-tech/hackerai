import { z } from "zod";

export const NEXT_ACTIONS_FLAG = "contextual-next-actions";
export const NEXT_ACTIONS_VERSION = 1;
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
  suggestions: z.array(z.string().trim().min(1).max(240)).max(3),
});
export type NextActionsBatch = z.infer<typeof nextActionsResponseSchema>;
export const emptyNextActionsResponseSchema = z.object({
  suggestions: z.array(z.never()).max(0),
});
export type CompletedPredictionTurn = { chatId: string; messageId: string };

export const generatedNextActionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(240),
        sourceMessageId: z.string(),
        evidenceQuote: z.string().min(12).max(240),
      }),
    )
    .max(3),
});

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

export function validateGroundedSuggestions(
  output: unknown,
  sources: PredictionSource[],
): string[] {
  const parsed = generatedNextActionsSchema.safeParse(output);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  return parsed.data.suggestions.flatMap((item) => {
    const source = sources.find((source) => source.id === item.sourceMessageId);
    // Quotes are checked against exactly the bounded context the model saw.
    if (
      !source?.text
        .split(OMITTED_TEXT)
        .some((part) => part.includes(item.evidenceQuote))
    )
      return [];
    const text = item.text.replace(/\s+/g, " ").trim();
    // Modal questions ask for something; they do not assert a user fact.
    const factualText = text
      .replace(
        /\b(?:can|could|may|might|should|would|will|shall|must|do|did|if|whether)\s+(?:i|we)\b/gi,
        " ",
      )
      .replace(/¿[^¿?]*\?/g, " ")
      .replace(/(?:^|[.!?;:]\s+)est-ce que\b[^?]*\?/gi, " ");
    // Editable predictions must not become composer control commands on send.
    // A standalone /goal token also selects goal mode inside an ordinary draft.
    if (/^\/|(?:^|\s)\/goal(?=\s|$)/i.test(text)) return [];
    // A real evidence quote does not make an invented user update true. Drop
    // the observed placeholder/completed-action forms instead of making Tab
    // insert a draft that falsely claims new evidence or work was supplied.
    if (
      /^(?:here (?:is|are)\b|i(?:['’]ve| have| just)? (?:attached|uploaded|provided|ran|run|tested|verified|checked)\b)/i.test(
        text,
      ) ||
      // A supported topic quote (especially an assistant's question) cannot
      // support filling in facts for the user. Drop observed factual-update
      // forms even if the model puts the claim after an otherwise valid request.
      /\b(?:i(?:['’](?:m|ve)|\s+(?:am|have|own|work|ran|tested|verified|checked|attached|uploaded|provided))|we(?:['’](?:re|ve)|\s+(?:are|have|own|work|ran|tested|verified|checked|attached|uploaded|provided)))\b/i.test(
        factualText,
      ) ||
      /(?:^|[.!?;:]\s+)(?:my|our)\s+.{0,80}\b(?:owns?|is|has|are|have)\b/i.test(
        text,
      ) ||
      // These are bounded observed claim forms, not a semantic verifier for
      // every language. The prompt must also avoid unsupported factual updates.
      /\b(?:(?:tengo|tenemos)\s+(?:permisos?|autorizaci[oó]n)|(?:estoy|estamos)\s+autorizad[oa]s?|soy\s+(?:el\s+|la\s+)?dueñ[oa])\b/i.test(
        factualText,
      ) ||
      /\b(?:j['’]ai|nous avons)\s+(?:la permission|l['’]autorisation)\b/i.test(
        factualText,
      )
    )
      return [];
    // Suggestions are plain editable questions, never fabricated artifact links.
    if (/[<>]|https?:\/\/|www\./i.test(text) || seen.has(text.toLowerCase()))
      return [];
    seen.add(text.toLowerCase());
    return [text];
  });
}
