import { NextRequest, NextResponse } from "next/server";
import { selectUseCaseSurvey } from "@/lib/analytics/acquisition-survey";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { arePostHogSurveyFlagsEnabled } from "@/lib/posthog/server";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: NextRequest) {
  const unavailable = () =>
    NextResponse.json({ available: false }, { headers: NO_STORE_HEADERS });
  try {
    const { userId, subscription, organizationId } = await getUserIDAndPro(req);
    // Keep this research separate from the paid-task feedback cohort.
    const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (subscription !== "free" || organizationId || !token)
      return unavailable();
    // Public survey definitions use the same environment-specific project token
    // as flag evaluation and response capture. No personal API key is needed.
    const url = new URL(
      "/api/surveys/",
      process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    );
    url.searchParams.set("token", token);
    const response = await fetch(url, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return unavailable();
    const body = await response.json();
    const survey = selectUseCaseSurvey(body.surveys);
    if (
      !survey ||
      !(await arePostHogSurveyFlagsEnabled(survey.flagKeys, userId))
    )
      return unavailable();
    return NextResponse.json(
      {
        available: true,
        survey: { id: survey.id, questionId: survey.questionId },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return unavailable();
  }
}
