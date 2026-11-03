import { z } from "zod";

export const NEXT_ACTIONS_FLAG = "contextual-next-actions";
export const NEXT_ACTIONS_VERSION = 1;
export const nextActionsRequestSchema = z
  .object({
    chatId: z.string().uuid(),
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

/** Recent persisted messages only. No reasoning, attachments, system messages,
 * tool inputs, or arbitrary tool outputs. Existing finding results provide IDs. */
export function buildPredictionSources(
  newestFirst: ContextMessage[],
): PredictionSource[] {
  const sources: PredictionSource[] = [];
  let remaining = 12_000;
  for (const message of newestFirst.slice(0, 6)) {
    if (message.role === "system" || remaining <= 0) continue;
    const chunks: string[] = [];
    let messageRemaining = Math.min(4_000, remaining);
    for (const value of message.parts) {
      if (!value || typeof value !== "object" || messageRemaining <= 0)
        continue;
      const part = value as Record<string, unknown>;
      let text = "";
      if (part.type === "text" && typeof part.text === "string")
        text = part.text;
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
        text = JSON.stringify(part.output);
      }
      const clipped = text.slice(0, messageRemaining);
      if (clipped) chunks.push(clipped);
      messageRemaining -= clipped.length;
    }
    const text = chunks.join("\n").slice(0, remaining);
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
    if (!source?.text.includes(item.evidenceQuote)) return [];
    const text = item.text.replace(/\s+/g, " ").trim();
    // Suggestions are plain editable questions, never fabricated artifact links.
    if (/[<>]|https?:\/\/|www\./i.test(text) || seen.has(text.toLowerCase()))
      return [];
    seen.add(text.toLowerCase());
    return [text];
  });
}
