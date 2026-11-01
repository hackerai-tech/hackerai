import { ChatSDKError } from "@/lib/errors";

export class CloudWorkspaceSelectionRequiredError extends ChatSDKError {
  constructor() {
    super(
      "bad_request:sandbox",
      "Choose which existing Cloud workspace to continue using. Files in both workspaces will be kept.",
      { cloud_workspace_region_selection_required: true },
    );
  }
}
