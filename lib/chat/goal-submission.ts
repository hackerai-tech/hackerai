import { ChatSDKError } from "@/lib/errors";

/** Only an explicit client-side HTTP refusal proves no start was admitted. */
export const isGoalAdmissionRefused = (error: unknown): boolean =>
  error instanceof ChatSDKError &&
  error.surface !== "stream" &&
  error.type !== "offline" &&
  error.statusCode >= 400 &&
  error.statusCode < 500;

/**
 * The server refused the start until the user picks a saved Cloud workspace.
 * Nothing was admitted, so the composer can offer the selector and a retry.
 */
export const isGoalWorkspaceSelectionRefusal = (
  error: unknown,
): error is ChatSDKError =>
  isGoalAdmissionRefused(error) &&
  (error as ChatSDKError).metadata
    ?.cloud_workspace_region_selection_required === true;

/** A saved/unknown turn is not proof that its durable Agent start failed. */
export class GoalSubmissionUnconfirmedError extends Error {
  constructor(
    public readonly messagePersisted: boolean | undefined,
    public readonly chatId?: string,
  ) {
    super("The goal may have started. Check its chat before sending again.");
    this.name = "GoalSubmissionUnconfirmedError";
  }
}
