import {
  ACQUISITION_SURVEY_FLAG_KEY,
  isNewSurveyUser,
  selectUseCaseSurvey,
} from "../acquisition-survey";
import { surveyDefinition } from "../test-support/acquisition-survey-fixture";
const now = Date.parse("2026-10-05T00:00:00Z");
describe("headless survey eligibility", () => {
  it("retains the internal response suppression flag for server evaluation", () => {
    expect(selectUseCaseSurvey([surveyDefinition], now)).toEqual({
      id: surveyDefinition.id,
      questionId: surveyDefinition.questions[0].id,
      flagKeys: [ACQUISITION_SURVEY_FLAG_KEY, "survey-targeting-test"],
    });
  });
  it("includes additional audience and response-sampling flags", () => {
    expect(
      selectUseCaseSurvey(
        [
          {
            ...surveyDefinition,
            targeting_flag_key: "audience",
            internal_response_sampling_flag_key: "sampling",
            feature_flag_keys: [{ key: "extra", value: true }],
          },
        ],
        now,
      )?.flagKeys,
    ).toEqual([
      ACQUISITION_SURVEY_FLAG_KEY,
      "audience",
      "survey-targeting-test",
      "sampling",
      "extra",
    ]);
  });
  it.each([
    { start_date: null },
    { start_date: "2026-10-06T00:00:00Z" },
    { end_date: "2026-10-04T00:00:00Z" },
    { end_date: "invalid" },
    { type: "popover" },
    { schedule: "always" },
    { archived: true },
    { linked_flag_key: "another-feature" },
    { conditions: { deviceTypes: ["Mobile"] } },
    { questions: [{ ...surveyDefinition.questions[0], hasOpenChoice: true }] },
    {
      questions: [
        { ...surveyDefinition.questions[0], choices: ["A new question"] },
      ],
    },
    { questions: [] },
    { id: "not-a-survey-id" },
    { feature_flag_keys: [{ key: "variant", value: "treatment" }] },
  ])("rejects drafts, stopped or incompatible surveys (%j)", (change) => {
    expect(
      selectUseCaseSurvey([{ ...surveyDefinition, ...change }], now),
    ).toBeNull();
  });
  it("rejects malformed responses and duplicate definitions", () => {
    for (const body of [
      null,
      {},
      [null],
      [surveyDefinition, surveyDefinition],
    ]) {
      expect(selectUseCaseSurvey(body, now)).toBeNull();
    }
  });
  it("limits new-user eligibility to a valid creation time in the past seven days", () => {
    expect(isNewSurveyUser("2026-10-04T00:00:00Z", now)).toBe(true);
    for (const created of [
      "2026-09-28T00:00:00Z",
      "2026-10-06T00:00:00Z",
      "invalid",
    ])
      expect(isNewSurveyUser(created, now)).toBe(false);
  });
});
