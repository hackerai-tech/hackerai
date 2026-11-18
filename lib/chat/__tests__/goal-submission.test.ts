import { CloudWorkspaceSelectionRequiredError } from "@/lib/ai/tools/utils/cloud-workspace-selection-error";
import { ChatSDKError } from "@/lib/errors";
import { isGoalWorkspaceSelectionRefusal } from "../goal-submission";

const selectionMetadata = { cloud_workspace_region_selection_required: true };

describe("isGoalWorkspaceSelectionRefusal", () => {
  it("recognizes the explicit workspace selection HTTP refusal", () => {
    expect(
      isGoalWorkspaceSelectionRefusal(
        new CloudWorkspaceSelectionRequiredError(),
      ),
    ).toBe(true);
  });

  // Each of these leaves admission uncertain or is a different refusal, so a
  // workspace Retry could duplicate a start or hide the real problem.
  it.each([
    [
      "a server error",
      () => {
        const error = new CloudWorkspaceSelectionRequiredError();
        error.statusCode = 502;
        return error;
      },
    ],
    [
      "a stream error",
      () => new ChatSDKError("bad_request:stream", "lost", selectionMetadata),
    ],
    [
      "an offline error",
      () => new ChatSDKError("offline:chat", undefined, selectionMetadata),
    ],
    [
      "another refusal",
      () => new ChatSDKError("bad_request:sandbox", "Upload failed"),
    ],
    [
      "an unstructured copy",
      () => new Error(new CloudWorkspaceSelectionRequiredError().message),
    ],
  ])("rejects %s", (_name, create) => {
    expect(isGoalWorkspaceSelectionRefusal(create())).toBe(false);
  });
});
