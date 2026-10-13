import { z } from "zod";
import { v5 as uuidv5 } from "uuid";

export const ACQUISITION_SURVEY_FLAG_KEY = "hac-57-post-activation-survey";
export const ACQUISITION_SURVEY_NAME = "HackerAI primary use case v2";
export const ACQUISITION_SURVEY_VERSION = 2;
// Retain the old key only to respect previous dismissals/completions.
export const ACQUISITION_SURVEY_STORAGE_KEY = "hackerai:acquisition-survey:v1";
export const USE_CASE_SURVEY_STORAGE_KEY = "hackerai:use-case-survey:v2";
export const SURVEY_NEW_USER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const USE_CASE_QUESTION = "What are you mainly using HackerAI for?";
export const USE_CASE_OPTIONS = [
  { value: "bug_bounty", label: "Bug bounty" },
  { value: "pentesting", label: "Penetration testing" },
  { value: "learning", label: "Learning security / CTFs" },
  { value: "building", label: "Building or debugging tools" },
  { value: "other", label: "Something else" },
] as const;
export type UseCaseAnswer = (typeof USE_CASE_OPTIONS)[number]["value"];
export type SurveyActivationMode = "ask" | "agent";

/** Vary choice positions across users without moving buttons on rerender or
 * changing PostHog's canonical question/answer mapping. Keep Other last.
 */
export function getUseCaseDisplayOptions(userId: string, surveyId: string) {
  return USE_CASE_OPTIONS.map((option) => ({
    option,
    rank:
      option.value === "other"
        ? "z"
        : uuidv5(`${userId}:${surveyId}:${option.value}`, uuidv5.URL),
  }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map(({ option }) => option);
}

export const useCaseSurveySchema = z.object({
  id: z.guid(),
  questionId: z.guid(),
});
export type UseCaseSurvey = z.infer<typeof useCaseSurveySchema>;

export function isNewSurveyUser(createdAt: string, now = Date.now()) {
  const age = now - Date.parse(createdAt);
  return age >= 0 && age < SURVEY_NEW_USER_WINDOW_MS;
}

const definitionSchema = z.object({
  id: z.guid(),
  name: z.literal(ACQUISITION_SURVEY_NAME),
  type: z.literal("api"),
  linked_flag_key: z.literal(ACQUISITION_SURVEY_FLAG_KEY),
  targeting_flag_key: z.string().nullable().optional(),
  internal_targeting_flag_key: z.string().nullable().optional(),
  internal_response_sampling_flag_key: z.string().nullable().optional(),
  feature_flag_keys: z
    .array(z.object({ key: z.string(), value: z.literal(true).optional() }))
    .nullable()
    .optional(),
  conditions: z.null().optional(),
  schedule: z.literal("once").nullable().optional(),
  start_date: z.string(),
  end_date: z.string().nullable().optional(),
  archived: z.literal(false).optional(),
  questions: z.tuple([
    z.object({
      id: z.guid(),
      type: z.literal("single_choice"),
      question: z.literal(USE_CASE_QUESTION),
      choices: z.array(z.string()),
      hasOpenChoice: z.literal(false).optional(),
    }),
  ]),
});

/** Validate the question contract and every flag before rendering a headless
 * survey. Unsupported display conditions fail closed; all audience targeting
 * belongs in the linked flag or PostHog's generated targeting flags.
 */
export function selectUseCaseSurvey(
  surveys: unknown,
  now = Date.now(),
): (UseCaseSurvey & { flagKeys: string[] }) | null {
  if (!Array.isArray(surveys)) return null;
  const matches = surveys.flatMap((raw) => {
    const result = definitionSchema.safeParse(raw);
    if (!result.success) return [];
    const survey = result.data;
    const question = survey.questions[0];
    if (
      !(Date.parse(survey.start_date) <= now) ||
      (survey.end_date && !(Date.parse(survey.end_date) > now)) ||
      question.choices.length !== USE_CASE_OPTIONS.length ||
      !USE_CASE_OPTIONS.every(
        ({ label }, index) => question.choices[index] === label,
      )
    )
      return [];
    return [
      {
        id: survey.id,
        questionId: question.id,
        flagKeys: [
          ...new Set(
            [
              ACQUISITION_SURVEY_FLAG_KEY,
              survey.targeting_flag_key,
              survey.internal_targeting_flag_key,
              survey.internal_response_sampling_flag_key,
              ...(survey.feature_flag_keys ?? []).map((flag) => flag.key),
            ].filter((key): key is string => Boolean(key)),
          ),
        ],
      },
    ];
  });
  return matches.length === 1 ? matches[0] : null;
}
