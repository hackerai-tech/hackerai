import { NextRequest, NextResponse } from "next/server";
import { ipAddress } from "@vercel/functions";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  abuseFingerprints,
  abuseIntakeEnabled,
  encryptAbuseEvidence,
} from "@/lib/abuse/evidence";
import {
  AbuseRequestError,
  abuseReportSchema,
  readAbuseJson,
} from "@/lib/abuse/report";
import {
  abuseTurnstileConfig,
  verifyAbuseTurnstile,
} from "@/lib/abuse/turnstile";

export const runtime = "nodejs";
export const maxDuration = 30;
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers });

export async function POST(request: NextRequest) {
  if (!abuseIntakeEnabled() || !abuseTurnstileConfig())
    return reply(
      {
        error:
          "Reporting is temporarily unavailable. Please use the help center or try again later.",
      },
      503,
    );
  // No login dependency, including when an unrelated session cookie has expired.
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return reply({ error: "Open the reporting page and try again." }, 403);
  try {
    const parsed = abuseReportSchema.safeParse(await readAbuseJson(request));
    if (!parsed.success) {
      const allowed = [
        "email",
        "target",
        "occurredAt",
        "description",
        "sourceIp",
        "sourcePort",
        "protocol",
        "reference",
        "evidence",
      ];
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        if (allowed.includes(field))
          fieldErrors[field] =
            field === "description"
              ? "Describe what happened using 20–6,000 characters."
              : field === "email"
                ? "Enter a valid email address."
                : field === "target"
                  ? "Enter the affected domain, address, or other target."
                  : "Check this field and its length.";
      }
      return reply(
        { error: "Please check the report details.", fieldErrors },
        400,
      );
    }
    const report = parsed.data;
    const reference = `AB-${report.submissionId}`;
    const source =
      ipAddress(request) ??
      (process.env.NODE_ENV === "development"
        ? "local-development"
        : undefined);
    if (!source)
      return reply(
        {
          error:
            "Reporting is temporarily unavailable. Please try again later.",
        },
        503,
      );
    // A renewed challenge must not change the report's durable retry identity.
    const verification = await verifyAbuseTurnstile(
      request.headers.get("x-turnstile-token") ?? "",
      request.nextUrl.hostname,
    );
    if (verification !== "verified")
      return reply(
        {
          code:
            verification === "rejected"
              ? "verification_failed"
              : "verification_unavailable",
          error:
            "Security verification could not be completed. Your details are still here; please try again.",
        },
        verification === "rejected" ? 403 : 503,
      );
    const receipt = await getConvexClient().mutation(api.abuseCases.receive, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      reference,
      digests: abuseFingerprints("submission", JSON.stringify(report)),
      kind: report.kind,
      ciphertext: encryptAbuseEvidence(reference, report),
      sourceHashes: abuseFingerprints("rate-source", source),
      emailHashes: abuseFingerprints("rate-email", report.email.toLowerCase()),
    });
    if (receipt.outcome === "rate_limited")
      return NextResponse.json(
        {
          error:
            "Too many reports were submitted recently. Please try again in an hour.",
        },
        { status: 429, headers: { ...headers, "Retry-After": "3600" } },
      );
    if (receipt.outcome === "conflict")
      return reply(
        {
          error:
            "This submission changed after it was saved. Start a new report for additional information.",
        },
        409,
      );
    return reply({ reference: receipt.reference, received: true }, 201);
  } catch (error) {
    if (error instanceof AbuseRequestError)
      return reply(
        {
          error:
            error.status === 413
              ? "This report is too large. Please shorten the details and evidence."
              : "The report could not be read. Please check it and try again.",
        },
        error.status,
      );
    // Never forward provider errors, request contents, or reporter identifiers to logs/analytics.
    return reply(
      {
        error:
          "We could not confirm that your report was saved. Your details are still here; please retry.",
      },
      503,
    );
  }
}
