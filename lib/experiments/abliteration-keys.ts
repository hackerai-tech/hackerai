export const ABLITERATED_EXPERIMENT_KEY = "abliterated_paid_moderated_v1";
export const FREE_ASK_ABLITERATED_EXPERIMENT_KEY =
  "abliterated_free_ask_moderated_v1";

export type AbliterationExperimentKey =
  | typeof ABLITERATED_EXPERIMENT_KEY
  | typeof FREE_ASK_ABLITERATED_EXPERIMENT_KEY;

export function isAbliterationExperimentKey(
  key: string | undefined,
): key is AbliterationExperimentKey {
  return (
    key === ABLITERATED_EXPERIMENT_KEY ||
    key === FREE_ASK_ABLITERATED_EXPERIMENT_KEY
  );
}
