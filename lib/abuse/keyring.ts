import { z } from "zod";

const keyringSchema = z.object({
  active: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  keys: z.record(
    z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    z.string().regex(/^[a-fA-F0-9]{64}$/),
  ),
});

export function abuseEvidenceKeyring() {
  try {
    const result = keyringSchema.parse(
      JSON.parse(process.env.ABUSE_EVIDENCE_KEYS ?? ""),
    );
    if (!result.keys[result.active] || Object.keys(result.keys).length > 5)
      throw new Error();
    return result;
  } catch {
    throw new Error("Abuse evidence storage is unavailable");
  }
}
