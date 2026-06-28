import { z } from "zod";

export const toolBriefSchema = z
  .string()
  .optional()
  .describe(
    "Optional display metadata. Include a concise one-sentence preamble whenever possible so the user understands the operation; if omitted, HackerAI will show a generated fallback label.",
  );
