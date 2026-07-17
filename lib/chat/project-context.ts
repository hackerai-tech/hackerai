import "server-only";

import { getProjectById } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { ChatMode, SandboxPreference } from "@/types";

type ProjectLinkedChat =
  | {
      project_id?: unknown;
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
  if (folderPath && isAgentMode(mode) && sandboxPreference !== "desktop") {
    throw new ChatSDKError(
      "bad_request:api",
      "This project is linked to a Desktop folder. Connect HackerAI Desktop and select Desktop before running Agent.",
    );
  }

  return {
    projectId,
    workingDirectory:
      folderPath && sandboxPreference === "desktop" ? folderPath : undefined,
  };
}
