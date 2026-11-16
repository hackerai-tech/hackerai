import type { LocalScheduleExecution } from "@/lib/schedules/recurrence";
import "server-only";
import { isDesktopPreference } from "@/lib/sandbox/environment";

import { getProjectById } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { ChatMode, SandboxPreference } from "@/types";

type ProjectLinkedChat =
  | {
      project_id?: unknown;
      scheduled_local_execution?: LocalScheduleExecution;
    }
  | null
  | undefined;

export type ProjectExecutionContext = {
  projectId?: string;
  workingDirectory?: string;
};

export async function resolveProjectExecutionContext({
  chat,
  requestedProjectId,
  userId,
  mode,
  sandboxPreference,
}: {
  chat: ProjectLinkedChat;
  requestedProjectId?: string;
  userId: string;
  mode: ChatMode;
  sandboxPreference?: SandboxPreference;
}): Promise<ProjectExecutionContext> {
  const execution = chat?.scheduled_local_execution;
  if (execution && isAgentMode(mode)) {
    if (sandboxPreference !== execution.preference)
      throw new ChatSDKError(
        "bad_request:api",
        "This scheduled task is bound to its original computer. Select that computer to continue.",
      );
    return { workingDirectory: execution.workingDirectory };
  }
  const persistedProjectId =
    typeof chat?.project_id === "string" ? chat.project_id : undefined;
  const projectId =
    persistedProjectId ?? (!chat ? requestedProjectId : undefined);
  if (!projectId) return {};

  const project = await getProjectById({ id: projectId, userId });
  if (!project) {
    throw new ChatSDKError(
      "bad_request:api",
      "This project is unavailable. Choose another project and try again.",
    );
  }

  const folderPath = project.folder_path;
  if (
    folderPath &&
    isAgentMode(mode) &&
    !isDesktopPreference(sandboxPreference ?? "e2b")
  ) {
    throw new ChatSDKError(
      "bad_request:api",
      "This project is linked to a Desktop folder. Connect HackerAI Desktop and select Desktop before running Agent.",
    );
  }

  return {
    projectId,
    workingDirectory:
      folderPath && isDesktopPreference(sandboxPreference ?? "e2b")
        ? folderPath
        : undefined,
  };
}
