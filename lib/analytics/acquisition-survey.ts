export const ACQUISITION_SURVEY_FLAG_KEY =
  "hac-57-post-activation-survey" as const;
export const ACQUISITION_SURVEY_ID = "hac_57_post_activation_v1" as const;
export const ACQUISITION_SURVEY_VERSION = 1 as const;
export const ACQUISITION_SURVEY_STORAGE_KEY =
  "hackerai:acquisition-survey:v1" as const;

export const FIRST_HEARD_OPTIONS = [
  { value: "google_or_search", label: "Google or another search engine" },
  { value: "friend_or_colleague", label: "Friend or colleague" },
  { value: "github", label: "GitHub" },
  { value: "community", label: "Reddit, Discord, or another community" },
  { value: "creator", label: "YouTube or another content creator" },
  { value: "ai_assistant", label: "AI assistant" },
  { value: "pentestgpt", label: "Previous PentestGPT user" },
  { value: "direct_or_other", label: "Direct or another source" },
] as const;

export const MAIN_REASON_OPTIONS = [
  { value: "security_agent", label: "Security Agent workflow" },
  { value: "local_sandbox", label: "Local or desktop sandbox" },
  { value: "pentest_workflow", label: "Penetration testing workflow" },
  { value: "model_access", label: "AI model access" },
  { value: "pricing", label: "Free tier or pricing" },
  { value: "recommendation_or_trust", label: "Recommendation or trust" },
  { value: "other", label: "Another reason" },
] as const;

export type FirstHeardAnswer = (typeof FIRST_HEARD_OPTIONS)[number]["value"];
export type MainReasonAnswer = (typeof MAIN_REASON_OPTIONS)[number]["value"];
export type SurveyActivationMode = "ask" | "agent";
