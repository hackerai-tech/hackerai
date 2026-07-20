import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    mockUseProjects.mockReturnValue({
      results: [
        {
          _id: "project-1",
          _creationTime: 1,
          user_id: "user-1",
          name: "Acme target",
          created_at: 1,
          updated_at: 1,
        },
      ] as Doc<"projects">[],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });
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
    expect(mockToast.success).toHaveBeenCalledWith("Moved to Acme target", {
      action: expect.objectContaining({ label: "Undo" }),
    });
  });

  it("removes a task from its project and can undo", async () => {
    const onOpenChange = jest.fn();

    render(
      <MoveChatToProjectDialog
        chatId="chat-1"
        currentProjectId={"project-1" as any}
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from project" }),
    );

    await waitFor(() => {
      expect(moveChatToProject).toHaveBeenCalledWith({
        chatId: "chat-1",
        projectId: null,
      });
    });
    const successOptions = mockToast.success.mock.calls.find(
      ([message]) => message === "Removed from project",
    )?.[1] as { action?: { onClick?: () => void } } | undefined;
    act(() => successOptions?.action?.onClick?.());

    await waitFor(() => {
      expect(moveChatToProject).toHaveBeenCalledWith({
        chatId: "chat-1",
        projectId: "project-1",
      });
      expect(mockToast.success).toHaveBeenCalledWith("Move undone");
    });
  });

  it("does not race an undo with another move", async () => {
    let finishMove: ((moved: boolean) => void) | undefined;
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
      expect(mockToast.success).toHaveBeenCalledWith("Moved to Acme target", {
        action: expect.objectContaining({ label: "Undo" }),
      });
    });
    const undo = mockToast.success.mock.calls.find(
      ([message]) => message === "Moved to Acme target",
    )?.[1]?.action?.onClick as (() => void) | undefined;
    expect(undo).toBeDefined();

    moveChatToProject.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishMove = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Acme target" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Acme target" }),
      ).toBeDisabled();
    });

    undo?.();
    expect(moveChatToProject).toHaveBeenCalledTimes(2);

    finishMove?.(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Acme target" })).toBeEnabled();
    });
  });

  it("shows an info toast when the chat is already in the project", async () => {
    moveChatToProject.mockResolvedValueOnce(false);
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
      expect(mockToast.info).toHaveBeenCalledWith("Already in Acme target");
    });
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("shows an error toast and keeps the dialog open when moving fails", async () => {
    moveChatToProject.mockRejectedValueOnce(new Error("Move failed"));
    const onOpenChange = jest.fn();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(
        <MoveChatToProjectDialog
          chatId="chat-1"
          open
          onOpenChange={onOpenChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Acme target" }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("Failed to move task", {
          description: "Move failed",
        });
      });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(mockToast.success).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("ignores dismissal attempts while a move is in progress", async () => {
    let finishMove: ((moved: boolean) => void) | undefined;
    moveChatToProject.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishMove = resolve;
        }),
    );
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
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();

    finishMove?.(true);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("explains how to add a destination when there are no projects", () => {
    mockUseProjects.mockReturnValue({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    });

    render(
      <MoveChatToProjectDialog chatId="chat-1" open onOpenChange={jest.fn()} />,
    );

    expect(
      screen.getByText("Create a project from the sidebar first."),
    ).toBeInTheDocument();
  });

  it("loads ten more project destinations", () => {
    const loadMore = jest.fn();
    mockUseProjects.mockReturnValue({
      results: [],
      status: "CanLoadMore",
      loadMore,
      isLoading: false,
    });

    render(
      <MoveChatToProjectDialog chatId="chat-1" open onOpenChange={jest.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    expect(loadMore).toHaveBeenCalledWith(10);
  });
});
