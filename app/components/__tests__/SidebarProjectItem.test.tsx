import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { SIDEBAR_CHAT_DRAG_TYPE } from "../sidebar-chat-drag";

const mockProjectThreads = jest.fn(() => (
  <div data-testid="project-threads">Threads</div>
));

jest.mock("../SidebarProjectThreads", () => ({
  SidebarProjectThreads: () => mockProjectThreads(),
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
    const values = new Map([[SIDEBAR_CHAT_DRAG_TYPE, "chat-1"]]);
    const dataTransfer = {
      types: [SIDEBAR_CHAT_DRAG_TYPE],
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
    expect(onDropChat).toHaveBeenCalledWith("chat-1");
    expect(dropTarget).not.toHaveClass("ring-1");
  });
});
