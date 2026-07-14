import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Doc } from "@/convex/_generated/dataModel";

jest.mock("@/app/hooks/useProjects", () => ({
  useProjects: jest.fn(),
  useMoveChatToProject: jest.fn(),
}));
jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  useMoveChatToProject: mockUseMoveChatToProject,
  useProjects: mockUseProjects,
} = jest.requireMock<{
  useMoveChatToProject: jest.Mock;
  useProjects: jest.Mock;
}>("@/app/hooks/useProjects");
const { toast: mockToast } = jest.requireMock<{
  toast: { success: jest.Mock; info: jest.Mock; error: jest.Mock };
}>("sonner");
const { MoveChatToProjectDialog } =
  require("../MoveChatToProjectDialog") as typeof import("../MoveChatToProjectDialog");

describe("MoveChatToProjectDialog", () => {
  const moveChatToProject = jest.fn<any>().mockResolvedValue(true);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseProjects.mockReturnValue([
      {
        _id: "project-1",
        _creationTime: 1,
        user_id: "user-1",
        name: "Acme target",
        created_at: 1,
        updated_at: 1,
      },
    ] as Doc<"projects">[]);
    mockUseMoveChatToProject.mockReturnValue(moveChatToProject);
  });

  it("moves a chat with a keyboard-accessible project button", async () => {
    const onOpenChange = jest.fn();

    render(
      <MoveChatToProjectDialog
        chatId="chat-1"
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Acme target" }));

    await waitFor(() => {
      expect(moveChatToProject).toHaveBeenCalledWith({
        chatId: "chat-1",
        projectId: "project-1",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockToast.success).toHaveBeenCalledWith("Moved to Acme target");
  });

  it("explains how to add a destination when there are no projects", () => {
    mockUseProjects.mockReturnValue([]);

    render(
      <MoveChatToProjectDialog chatId="chat-1" open onOpenChange={jest.fn()} />,
    );

    expect(
      screen.getByText("Create a project from the sidebar first."),
    ).toBeInTheDocument();
  });
});
