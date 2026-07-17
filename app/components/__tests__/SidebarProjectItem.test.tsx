import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Doc } from "@/convex/_generated/dataModel";
import {
  SIDEBAR_CHAT_DRAG_PROJECT_TYPE,
  SIDEBAR_CHAT_DRAG_TYPE,
} from "../sidebar-chat-drag";

const mockProjectThreads = jest.fn(() => (
  <div data-testid="project-threads">Tasks</div>
));
const mockPinProject = jest.fn<any>().mockResolvedValue(null);
const mockUnpinProject = jest.fn<any>().mockResolvedValue(null);

jest.mock("@/app/hooks/useProjects", () => ({
  usePinProject: () => mockPinProject,
  useUnpinProject: () => mockUnpinProject,
}));

jest.mock("../SidebarProjectThreads", () => ({
  SidebarProjectThreads: () => mockProjectThreads(),
}));
jest.mock("../ProjectEditDialog", () => ({
  ProjectEditDialog: ({ open }: { open: boolean }) => (
    <div data-testid="project-edit-dialog" data-open={String(open)} />
  ),
}));
jest.mock("../ProjectDeleteDialog", () => ({
  ProjectDeleteDialog: ({ open }: { open: boolean }) => (
    <div data-testid="project-delete-dialog" data-open={String(open)} />
  ),
}));

const { SidebarProjectItem } =
  require("../SidebarProjectItem") as typeof import("../SidebarProjectItem");

const project = {
  _id: "project-1",
  _creationTime: 1,
  user_id: "user-1",
  name: "Acme",
  created_at: 1,
  updated_at: 1,
} as unknown as Doc<"projects">;

describe("SidebarProjectItem", () => {
  it("unmounts the thread list when collapsed so pagination resets", () => {
    const props = {
      project,
      onOpenChange: jest.fn(),
      onNewThread: jest.fn(),
      onDropChat: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    const { rerender } = render(<SidebarProjectItem {...props} open />);

    expect(screen.getByTestId("project-folder-open")).toBeInTheDocument();
    expect(screen.getByTestId("project-chevron")).toHaveClass("rotate-90");
    expect(
      screen.queryByTestId("project-folder-closed"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("project-threads")).toBeInTheDocument();
    expect(mockProjectThreads).toHaveBeenCalledTimes(1);

    rerender(<SidebarProjectItem {...props} open={false} />);
    expect(screen.getByTestId("project-folder-closed")).toBeInTheDocument();
    expect(screen.getByTestId("project-chevron")).not.toHaveClass("rotate-90");
    expect(screen.queryByTestId("project-folder-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-threads")).not.toBeInTheDocument();

    rerender(<SidebarProjectItem {...props} open />);
    expect(screen.getByTestId("project-threads")).toBeInTheDocument();
    expect(mockProjectThreads).toHaveBeenCalledTimes(2);
  });

  it("accepts a dragged sidebar chat", () => {
    const onDropChat = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const values = new Map([
      [SIDEBAR_CHAT_DRAG_TYPE, "chat-1"],
      [SIDEBAR_CHAT_DRAG_PROJECT_TYPE, "project-previous"],
    ]);
    const dataTransfer = {
      types: [SIDEBAR_CHAT_DRAG_TYPE, SIDEBAR_CHAT_DRAG_PROJECT_TYPE],
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
    } as DataTransfer;

    render(
      <SidebarProjectItem
        project={project}
        open={false}
        onOpenChange={jest.fn()}
        onNewThread={jest.fn()}
        onDropChat={onDropChat}
      />,
    );

    const dropTarget = screen.getByTestId("project-project-1-drop-target");
    fireEvent.dragEnter(dropTarget, { dataTransfer });
    expect(dropTarget).toHaveClass("ring-1");

    fireEvent.drop(dropTarget, { dataTransfer });
    expect(onDropChat).toHaveBeenCalledWith("chat-1", "project-previous");
    expect(dropTarget).not.toHaveClass("ring-1");
  });

  it("shows the linked Desktop folder in the project menu", async () => {
    const user = userEvent.setup();
    const linkedProject = {
      ...project,
      folder_path: "/Users/hackerai/targets/acme",
    } as Doc<"projects">;

    render(
      <SidebarProjectItem
        project={linkedProject}
        open={false}
        onOpenChange={jest.fn()}
        onNewThread={jest.fn()}
        onDropChat={jest.fn<() => Promise<void>>().mockResolvedValue(undefined)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Project options for Acme" }),
    );
    expect(
      await screen.findByText("/Users/hackerai/targets/acme"),
    ).toBeInTheDocument();
  });

  it("offers pin, edit, and delete actions from the project menu", async () => {
    const user = userEvent.setup();
    render(
      <SidebarProjectItem
        project={project}
        open={false}
        onOpenChange={jest.fn()}
        onNewThread={jest.fn()}
        onDropChat={jest.fn<() => Promise<void>>().mockResolvedValue(undefined)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Project options for Acme" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => {
      expect(mockPinProject).toHaveBeenCalledWith({ projectId: "project-1" });
    });

    await user.click(
      screen.getByRole("button", { name: "Project options for Acme" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(screen.getByTestId("project-edit-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );

    await user.click(
      screen.getByRole("button", { name: "Project options for Acme" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByTestId("project-delete-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
  });

  it("hides the passive pin icon while allowing unpinning", async () => {
    const user = userEvent.setup();
    const pinnedProject = { ...project, pinned_at: 10 } as Doc<"projects">;
    render(
      <SidebarProjectItem
        project={pinnedProject}
        open={false}
        onOpenChange={jest.fn()}
        onNewThread={jest.fn()}
        onDropChat={jest.fn<() => Promise<void>>().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByTestId("project-pin-icon")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Project options for Acme" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => {
      expect(mockUnpinProject).toHaveBeenCalledWith({
        projectId: "project-1",
      });
    });
  });
});
