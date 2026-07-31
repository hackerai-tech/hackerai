import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  SIDEBAR_PINNED_DROP_ID,
  SIDEBAR_TASKS_DROP_ID,
  type SidebarChatDragData,
  type SidebarChatDropData,
} from "../sidebar-chat-drag";
import { SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY } from "@/lib/utils/client-storage";

const mockPinChat = jest.fn();
const mockUnpinChat = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
let mockDndContextProps: {
  collisionDetection: unknown;
  onDragCancel: (event: unknown) => void;
  onDragEnd: (event: unknown) => void;
  onDragStart: (event: unknown) => void;
  sensors: unknown[];
};
let mockOverDropId: string | undefined;
const mockDroppableData = new Map<string, SidebarChatDropData>();
const mockPointerWithin = jest.fn();
const mockRectIntersection = jest.fn();

jest.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    collisionDetection: unknown;
    onDragCancel: (event: unknown) => void;
    onDragEnd: (event: unknown) => void;
    onDragStart: (event: unknown) => void;
    sensors: unknown[];
  }) => {
    mockDndContextProps = props;
    return children;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => children,
  KeyboardSensor: class KeyboardSensor {},
  MouseSensor: class MouseSensor {},
  pointerWithin: mockPointerWithin,
  rectIntersection: mockRectIntersection,
  TouchSensor: class TouchSensor {},
  useDroppable: ({ data, id }: { data: SidebarChatDropData; id: string }) => {
    mockDroppableData.set(id, data);
    return {
      isOver: mockOverDropId === id,
      setNodeRef: jest.fn(),
    };
  },
  useSensor: (sensor: unknown, options?: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
}));

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
    openProjectIds,
    onProjectOpenChange,
    projects,
    variant = "section",
  }: {
    openProjectIds: ReadonlySet<string>;
    onProjectOpenChange: (projectId: string, open: boolean) => void;
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
        <button
          key={project._id}
          type="button"
          data-open={String(openProjectIds.has(project._id))}
          onClick={() =>
            onProjectOpenChange(project._id, !openProjectIds.has(project._id))
          }
          aria-label={`Toggle ${project.name}`}
        >
          {project.name}
        </button>
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
    mockDroppableData.clear();
    mockOverDropId = undefined;
    mockPointerWithin.mockReturnValue([]);
    mockRectIntersection.mockReturnValue([]);
    mockPinChat.mockResolvedValue(null);
    mockUnpinChat.mockResolvedValue(null);
    window.localStorage.clear();
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
    expect(mockDndContextProps.collisionDetection).toEqual(
      expect.any(Function),
    );
    expect(mockDndContextProps.sensors).toHaveLength(3);
  });

  it("restores expanded projects across pinned and regular lists", async () => {
    const props = {
      chats,
      projects,
      paginationStatus: "Exhausted" as const,
    };
    const firstRender = render(<SidebarChatSections {...props} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle Pinned project" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle Regular project" }),
    );
    await waitFor(() => {
      expect(
        window.localStorage.getItem(SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY),
      ).toBe(JSON.stringify(["pinned-project", "regular-project"]));
    });

    firstRender.unmount();
    render(<SidebarChatSections {...props} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Toggle Pinned project" }),
      ).toHaveAttribute("data-open", "true");
      expect(
        screen.getByRole("button", { name: "Toggle Regular project" }),
      ).toHaveAttribute("data-open", "true");
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle Regular project" }),
    );
    await waitFor(() => {
      expect(
        window.localStorage.getItem(SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY),
      ).toBe(JSON.stringify(["pinned-project"]));
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle Pinned project" }),
    );
    await waitFor(() => {
      expect(
        window.localStorage.getItem(SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY),
      ).toBeNull();
    });
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
    const props = {
      chats: [chats[1]],
      projects: [],
      paginationStatus: "Exhausted" as const,
    };
    const { rerender } = render(<SidebarChatSections {...props} />);

    expect(
      screen.queryByTestId("sidebar-pinned-section"),
    ).not.toBeInTheDocument();

    const dragData: SidebarChatDragData = {
      type: "sidebar-chat",
      chatId: "task-chat",
      isPinned: false,
      title: "Regular target",
    };
    act(() => {
      mockDndContextProps.onDragStart({
        active: { data: { current: dragData } },
      });
    });

    const pinnedDropTarget = screen.getByTestId("sidebar-pinned-section");
    mockOverDropId = SIDEBAR_PINNED_DROP_ID;
    rerender(<SidebarChatSections {...props} />);
    expect(pinnedDropTarget).toHaveAttribute("data-drop-active", "true");

    act(() => {
      mockDndContextProps.onDragEnd({
        active: { data: { current: dragData } },
        over: {
          data: { current: mockDroppableData.get(SIDEBAR_PINNED_DROP_ID) },
        },
      });
    });

    await waitFor(() => {
      expect(mockPinChat).toHaveBeenCalledWith({ chatId: "task-chat" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Task pinned");
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("accepts the sensor drop target covering existing Pinned content", async () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const dragData: SidebarChatDragData = {
      type: "sidebar-chat",
      chatId: "task-chat",
      isPinned: false,
      title: "Regular target",
    };
    const pinnedSection = screen.getByTestId("sidebar-pinned-section");
    const existingPinnedTask = screen.getByTestId("section-chat-pinned-chat");
    expect(pinnedSection).toContainElement(existingPinnedTask);

    act(() => {
      mockDndContextProps.onDragEnd({
        active: { data: { current: dragData } },
        over: {
          data: { current: mockDroppableData.get(SIDEBAR_PINNED_DROP_ID) },
        },
      });
    });
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

    const dragData: SidebarChatDragData = {
      type: "sidebar-chat",
      chatId: "pinned-chat",
      isPinned: true,
      title: "Pinned target",
    };
    act(() => {
      mockDndContextProps.onDragEnd({
        active: { data: { current: dragData } },
        over: {
          data: { current: mockDroppableData.get(SIDEBAR_PINNED_DROP_ID) },
        },
      });
    });

    expect(mockPinChat).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("unpins a task dropped on the Tasks sensor target", async () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const dragData: SidebarChatDragData = {
      type: "sidebar-chat",
      chatId: "pinned-chat",
      isPinned: true,
      title: "Pinned target",
    };
    const tasksSection = screen.getByTestId("sidebar-tasks-section");
    const existingTask = screen.getByTestId("section-chat-task-chat");
    expect(tasksSection).toContainElement(existingTask);

    act(() => {
      mockDndContextProps.onDragEnd({
        active: { data: { current: dragData } },
        over: {
          data: { current: mockDroppableData.get(SIDEBAR_TASKS_DROP_ID) },
        },
      });
    });
    await waitFor(() => {
      expect(mockUnpinChat).toHaveBeenCalledWith({ chatId: "pinned-chat" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Task unpinned");
    });
    expect(mockPinChat).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("falls back to rectangle collisions and completes a keyboard drop", async () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={projects}
        paginationStatus="Exhausted"
      />,
    );

    const collisionArgs = { pointerCoordinates: null };
    const keyboardCollisions = [{ id: SIDEBAR_TASKS_DROP_ID }];
    mockRectIntersection.mockReturnValue(keyboardCollisions);

    const detectCollisions =
      mockDndContextProps.collisionDetection as typeof mockPointerWithin;
    expect(detectCollisions(collisionArgs)).toEqual(keyboardCollisions);
    expect(mockPointerWithin).toHaveBeenCalledWith(collisionArgs);
    expect(mockRectIntersection).toHaveBeenCalledWith(collisionArgs);

    const dragData: SidebarChatDragData = {
      type: "sidebar-chat",
      chatId: "pinned-chat",
      isPinned: true,
      title: "Pinned target",
    };
    act(() => {
      mockDndContextProps.onDragEnd({
        active: { data: { current: dragData } },
        over: {
          data: { current: mockDroppableData.get(keyboardCollisions[0].id) },
        },
      });
    });

    await waitFor(() => {
      expect(mockUnpinChat).toHaveBeenCalledWith({ chatId: "pinned-chat" });
      expect(mockToastSuccess).toHaveBeenCalledWith("Task unpinned");
    });
  });
});
