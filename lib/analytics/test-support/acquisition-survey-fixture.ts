import {
  ACQUISITION_SURVEY_FLAG_KEY,
  ACQUISITION_SURVEY_NAME,
  USE_CASE_OPTIONS,
  USE_CASE_QUESTION,
} from "../acquisition-survey";
export const surveyDefinition = {
  id: "01a10996-922f-0000-912d-30dc12032b97",
  name: ACQUISITION_SURVEY_NAME,
  type: "api",
  linked_flag_key: ACQUISITION_SURVEY_FLAG_KEY,
  internal_targeting_flag_key: "survey-targeting-test",
  targeting_flag_key: null,
  feature_flag_keys: null,
  conditions: null,
  schedule: "once",
  start_date: "2026-10-04T00:00:00Z",
  end_date: null,
  questions: [
    {
      id: "2e75b109-bc29-40a7-ab44-bb49c1d5d5b8",
      type: "single_choice",
      question: USE_CASE_QUESTION,
      choices: USE_CASE_OPTIONS.map(({ label }) => label),
      hasOpenChoice: false,
    },
  ],
};
