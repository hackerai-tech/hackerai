import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import {
  httpRetestCredentialValuesSchema,
  type HttpRetestRecipe,
} from "./http-retest";

export const HTTP_FINDING_RETESTS_FLAG = "http_finding_retests_v1";
const FLAG_TIMEOUT_MS = 1_000;

/**
 * Fail closed: an unavailable or slow evaluation disables reads, writes, runs
 * and the Agent save tool. Assignment reads never emit exposure events.
 */
export async function isHttpFindingRetestsEnabled(
  userId: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (
      (await Promise.race([
        getPostHogBooleanFlagDecisionForUser(
          HTTP_FINDING_RETESTS_FLAG,
          userId,
          undefined,
          { sendFeatureFlagEvents: false },
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), FLAG_TIMEOUT_MS);
        }),
      ])) === true
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Names of credentials the recipe's requests actually use. */
export function requiredCredentialNames(recipe: HttpRetestRecipe): string[] {
  return recipe.credentials.map((credential) => credential.name);
}

/**
 * Accept exactly the recipe's credential names with one-line printable
 * values. Error messages name fields only, never values.
 */
export function validateRunCredentials(
  recipe: HttpRetestRecipe,
  values: unknown,
):
  | { success: true; credentials: Record<string, string> }
  | { success: false; message: string } {
  const parsed = httpRetestCredentialValuesSchema.safeParse(values);
  if (!parsed.success)
    return {
      success: false,
      message:
        "Credentials must be single-line printable text of at most 8,192 characters.",
    };
  const required = requiredCredentialNames(recipe);
  const provided = Object.keys(parsed.data);
  const missing = required.filter((name) => !provided.includes(name));
  if (missing.length > 0)
    return { success: false, message: `Enter ${missing.join(", ")}.` };
  if (provided.some((name) => !required.includes(name)))
    return {
      success: false,
      message: "Only credentials named by this recipe can be sent.",
    };
  return { success: true, credentials: parsed.data };
}
