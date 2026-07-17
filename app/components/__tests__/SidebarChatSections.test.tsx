import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPinChat = jest.fn();
const mockUnpinChat = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock("@/app/hooks/useChats", () => ({
  usePinChat: () => mockPinChat,
  useUnpinChat: () => mockUnpinChat,
}));
jest.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

jest.mock("../SidebarProjects", () => ({
  SidebarProjects: ({
    projects,
    variant = "section",
  }: {
    projects: Array<{ _id: string; name: string }>;
    variant?: "section" | "pinned-list";
  }) => (
    <section
      data-testid={
        variant === "pinned-list"
          ? "sidebar-pinned-project-list"
          : "sidebar-projects-section"
      }
    >
      {projects.map((project) => (
        <span key={project._id}>{project.name}</span>
      ))}
    </section>
  ),
}));
jest.mock("../SidebarHistory", () => ({
  __esModule: true,
  default: ({
    chats,
    testId = "sidebar-chat-list",
  }: {
    chats: Array<{ id: string; title: string }>;
    testId?: string;
  }) => (
    <div data-testid={testId}>
      {chats.map((chat) => (
        <span key={chat.id} data-testid={`section-chat-${chat.id}`}>
          {chat.title}
        </span>
      ))}
    </div>
  ),
}));

const { SidebarChatSections } =
  require("../SidebarChatSections") as typeof import("../SidebarChatSections");

const chats = [
  {
    _id: "pinned-doc",
    id: "pinned-chat",
    title: "Pinned target",
    pinned_at: 1,
  },
  {
    _id: "task-doc",
    id: "task-chat",
    title: "Regular target",
  },
];

const projects = [
  {
    _id: "pinned-project",
    name: "Pinned project",
    pinned_at: 2,
  },
  {
    _id: "regular-project",
    name: "Regular project",
  },
] as any;

describe("SidebarChatSections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPinChat.mockResolvedValue(null);
    mockUnpinChat.mockResolvedValue(null);
  });

  it("moves pinned projects under Pinned and keeps unpinned projects in Projects", () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const sections = screen.getByTestId("sidebar-chat-sections");
    expect(
      Array.from(sections.children).map((element) =>
        element.getAttribute("data-testid"),
      ),
    ).toEqual([
      "sidebar-pinned-section",
      "sidebar-projects-section",
      "sidebar-tasks-section",
    ]);

    const pinnedContent = screen.getByTestId(
      "sidebar-pinned-section",
    ).lastElementChild;
    expect(
      Array.from(pinnedContent?.children ?? []).map((element) =>
        element.getAttribute("data-testid"),
      ),
    ).toEqual(["sidebar-pinned-chat-list", "sidebar-pinned-project-list"]);

    expect(screen.getByTestId("sidebar-pinned-chat-list")).toHaveTextContent(
      "Pinned target",
    );
    expect(screen.getByTestId("sidebar-pinned-project-list")).toHaveTextContent(
      "Pinned project",
    );
    expect(
      screen.getByTestId("sidebar-pinned-project-list"),
    ).not.toHaveTextContent("Regular project");
    expect(screen.getByTestId("sidebar-projects-section")).toHaveTextContent(
      "Regular project",
    );
    expect(
      screen.getByTestId("sidebar-projects-section"),
    ).not.toHaveTextContent("Pinned project");
    expect(
      screen.getByTestId("sidebar-pinned-chat-list"),
    ).not.toHaveTextContent("Regular target");
    expect(screen.getByTestId("sidebar-chat-list")).toHaveTextContent(
      "Regular target",
    );
    expect(screen.getByTestId("sidebar-chat-list")).not.toHaveTextContent(
      "Pinned target",
    );
  });

  it("collapses pinned chats and tasks independently", () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    expect(screen.getByTestId("sidebar-pinned-section-chevron")).toHaveClass(
      "rotate-90",
      "opacity-0",
    );
    expect(screen.getByTestId("sidebar-tasks-section-chevron")).toHaveClass(
      "rotate-90",
      "opacity-0",
    );

    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    expect(
      screen.queryByTestId("sidebar-pinned-chat-list"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-chat-list")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-pinned-section-chevron")).toHaveClass(
      "opacity-100",
    );

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByTestId("sidebar-chat-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-projects-section")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-tasks-section-chevron")).toHaveClass(
      "opacity-100",
    );
  });

  it("pins a dropped task and shows the requested toast", async () => {
    render(
      <SidebarChatSections
        chats={[chats[1]]}
        projects={[]}
        paginationStatus="Exhausted"
      />,
    );

    expect(
      screen.queryByTestId("sidebar-pinned-section"),
    ).not.toBeInTheDocument();

    const values = new Map([["application/x-hackerai-chat-id", "task-chat"]]);
    const dataTransfer = {
      types: ["application/x-hackerai-chat-id"],
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
    } as DataTransfer;

    fireEvent.dragStart(screen.getByTestId("sidebar-chat-sections"), {
      dataTransfer,
    });

    const pinnedDropTarget = screen.getByTestId("sidebar-pinned-section");
    fireEvent.dragOver(pinnedDropTarget, { dataTransfer });
    expect(pinnedDropTarget).toHaveAttribute("data-drop-active", "true");

    fireEvent.drop(pinnedDropTarget, { dataTransfer });

    await waitFor(() => {
      expect(mockPinChat).toHaveBeenCalledWith({ chatId: "task-chat" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Task pinned");
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("accepts a drop on an existing task anywhere inside Pinned", async () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const values = new Map([["application/x-hackerai-chat-id", "task-chat"]]);
    const dataTransfer = {
      types: ["application/x-hackerai-chat-id"],
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
    } as DataTransfer;
    const pinnedSection = screen.getByTestId("sidebar-pinned-section");
    const existingPinnedTask = screen.getByTestId("section-chat-pinned-chat");

    fireEvent.dragOver(existingPinnedTask, { dataTransfer });
    expect(pinnedSection).toHaveAttribute("data-drop-active", "true");

    fireEvent.drop(existingPinnedTask, { dataTransfer });
    await waitFor(() => {
      expect(mockPinChat).toHaveBeenCalledWith({ chatId: "task-chat" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Task pinned");
    });
  });

  it("does not pin a task that is already pinned", () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const values = new Map([["application/x-hackerai-chat-id", "pinned-chat"]]);
    const dataTransfer = {
      types: ["application/x-hackerai-chat-id"],
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
    } as DataTransfer;

    fireEvent.drop(screen.getByRole("button", { name: "Pinned" }), {
      dataTransfer,
    });

    expect(mockPinChat).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("unpins a task dropped anywhere inside Tasks", async () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const values = new Map([["application/x-hackerai-chat-id", "pinned-chat"]]);
    const dataTransfer = {
      types: ["application/x-hackerai-chat-id"],
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
    } as DataTransfer;
    const tasksSection = screen.getByTestId("sidebar-tasks-section");
    const existingTask = screen.getByTestId("section-chat-task-chat");

    fireEvent.dragOver(existingTask, { dataTransfer });
    expect(tasksSection).toHaveAttribute("data-drop-active", "true");

    fireEvent.drop(existingTask, { dataTransfer });
    await waitFor(() => {
      expect(mockUnpinChat).toHaveBeenCalledWith({ chatId: "pinned-chat" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Task unpinned");
    });
    expect(mockPinChat).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
