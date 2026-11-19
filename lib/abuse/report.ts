import { z } from "zod";

const optionalText = (limit: number) =>
  z.string().trim().max(limit).default("");

/** Plain text only. Submitted addresses and evidence links are never fetched. */
export const abuseReportSchema = z
  .object({
    submissionId: z.uuid().transform((value) => value.toLowerCase()),
    kind: z.enum(["abuse", "appeal"]),
    email: z.email().max(254),
    target: optionalText(500),
    occurredAt: optionalText(160),
    description: z.string().trim().min(20).max(6000),
    sourceIp: optionalText(120),
    sourcePort: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === "" || (/^\d{1,5}$/.test(value) && Number(value) <= 65535),
        "Enter a port between 0 and 65535, or leave it blank.",
      )
      .default(""),
    protocol: optionalText(40),
    reference: optionalText(160),
    evidence: optionalText(6000),
    website: z.literal("").default(""),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.kind === "abuse" && !report.target) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Enter the affected domain, address, or other target.",
      });
    }
  });

export type AbuseReport = z.infer<typeof abuseReportSchema>;
export type AbuseReportField = Exclude<
  keyof AbuseReport,
  "submissionId" | "website"
>;
// Allow every bounded field even when JSON escapes each UTF-16 code unit.
export const ABUSE_REQUEST_MAX_BYTES = 96 * 1024;
export const ABUSE_EMAIL = "abuse@hackerai.co";

export class AbuseRequestError extends Error {
  constructor(readonly status: number) {
    super("Abuse request rejected");
  }
}

/** Bound the actual stream, including chunked requests with no Content-Length. */
export async function readAbuseJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new AbuseRequestError(415);
  }
  if (!request.body) throw new AbuseRequestError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ABUSE_REQUEST_MAX_BYTES) {
        await reader.cancel();
        throw new AbuseRequestError(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // JSON parse errors can contain fragments of the reporter's evidence.
    throw new AbuseRequestError(400);
  }
}
