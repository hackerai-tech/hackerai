import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  DndContext,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ReactNode } from "react";

const mockMoveChatToProject = jest.fn<any>();
const mockRouterPush = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastInfo = jest.fn();
let mockProjects: any[] | undefined;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  usePathname: () => "/",
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    closeSidebar: jest.fn(),
    setChatSidebarOpen: jest.fn(),
    initializeNewChat: jest.fn(),
    initializeChat: jest.fn(),
    optimisticChatId: null,
    setOptimisticChatId: jest.fn(),
  }),
}));
const mockUseIsMobile = jest.fn(() => false);
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));
jest.mock("convex/react", () => ({
  useMutation: () => jest.fn(),
}));
jest.mock("@/app/hooks/useChats", () => ({
  usePinChat: () => jest.fn(),
  useUnpinChat: () => jest.fn(),
}));
jest.mock("@/app/hooks/useProjects", () => ({
  useMoveChatToProject: () => mockMoveChatToProject,
}));
jest.mock("@/app/contexts/SidebarProjectList", () => ({
  useSidebarProjectList: () => ({ projects: mockProjects }),
}));
jest.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    info: mockToastInfo,
    error: jest.fn(),
  },
}));
jest.mock("../ShareDialog", () => ({
  ShareDialog: () => null,
}));
jest.mock("../ProjectCreateDialog", () => ({
  ProjectCreateDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (projectId: string, projectName: string) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => onCreated("project-new", "New target")}
      >
        Complete project creation
      </button>
    ) : null,
}));
jest.mock("../MoveChatToProjectDialog", () => ({
  MoveChatToProjectDialog: ({
    currentProjectId,
  }: {
    currentProjectId?: string;
  }) => (
    <div
      data-testid="move-chat-to-project-dialog"
      data-project-id={currentProjectId}
    />
  ),
}));

const ChatItem = require("../ChatItem")
  .default as typeof import("../ChatItem").default;

function KeyboardDragHarness({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(KeyboardSensor));
  return <DndContext sensors={sensors}>{children}</DndContext>;
}

describe("ChatItem project actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
    mockMoveChatToProject.mockResolvedValue(true);
    mockProjects = undefined;
  });

  it("reveals an accessible move action when the row receives keyboard focus", async () => {
    const user = userEvent.setup();
    render(
      <ChatItem
        id="chat-1"
        title="Target notes"
        projectId={"project-1" as any}
      />,
    );

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    const optionsButton = screen.getByRole("button", {
      name: "Open task options",
    });
    expect(optionsButton).toHaveClass("size-8");
    expect(optionsButton.querySelector("svg")).toHaveClass("size-[18px]");
    await user.click(optionsButton);

    await user.click(
      await screen.findByRole("menuitem", { name: "Move to project…" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("move-chat-to-project-dialog")).toHaveAttribute(
        "data-project-id",
        "project-1",
      );
    });
  });

  it("shows existing projects in a submenu instead of the move dialog", async () => {
    const user = userEvent.setup();
    mockProjects = [
      {
        _id: "project-1",
        _creationTime: 1,
        user_id: "user-1",
        name: "Acme target",
        created_at: 1,
        updated_at: 1,
      },
    ];
    render(<ChatItem id="chat-1" title="Target notes" />);

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    await user.click(screen.getByRole("button", { name: "Open task options" }));

    const moveTrigger = await screen.findByRole("menuitem", {
      name: "Move to project",
    });
    const taskOptionsMenu = moveTrigger.closest('[role="menu"]');
    expect(taskOptionsMenu).toHaveClass(
      "min-w-52",
      "rounded-xl",
      "border-border/80",
      "p-1.5",
    );
    expect(
      taskOptionsMenu?.querySelectorAll('[role="separator"]'),
    ).toHaveLength(2);
    for (const itemName of ["Share", "Rename", "Pin", "Move to project"]) {
      expect(screen.getByRole("menuitem", { name: itemName })).toHaveClass(
        "h-9",
        "gap-2.5",
        "rounded-md",
        "px-2.5",
        "text-foreground",
      );
    }
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("data-variant", "destructive");
    expect(deleteItem).toHaveClass("h-9", "px-2.5", "text-destructive");

    act(() => moveTrigger.focus());
    fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });

    const destinationItem = await screen.findByRole("menuitem", {
      name: "Acme target",
    });
    expect(destinationItem).toHaveClass(
      "h-9",
      "gap-2.5",
      "rounded-md",
      "px-2.5",
      "text-foreground",
    );
    await user.click(destinationItem);

    await waitFor(() => {
      expect(mockMoveChatToProject).toHaveBeenCalledWith({
        chatId: "chat-1",
        projectId: "project-1",
      });
    });
    expect(
      screen.queryByTestId("move-chat-to-project-dialog"),
    ).not.toBeInTheDocument();
    expect(mockToastSuccess).toHaveBeenCalledWith("Moved to Acme target", {
      action: expect.objectContaining({ label: "Undo" }),
    });
  });

  it("creates a project from the submenu and moves the task into it", async () => {
    const user = userEvent.setup();
    mockProjects = [
      {
        _id: "project-1",
        _creationTime: 1,
        user_id: "user-1",
        name: "Acme target",
        created_at: 1,
        updated_at: 1,
      },
    ];
    render(<ChatItem id="chat-1" title="Target notes" />);

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    await user.click(screen.getByRole("button", { name: "Open task options" }));
    const moveTrigger = await screen.findByRole("menuitem", {
      name: "Move to project",
    });
    act(() => moveTrigger.focus());
    fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });
    await user.click(
      await screen.findByRole("menuitem", { name: "New project" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Complete project creation",
      }),
    );

    await waitFor(() => {
      expect(mockMoveChatToProject).toHaveBeenCalledWith({
        chatId: "chat-1",
        projectId: "project-new",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Moved to New target", {
      action: expect.objectContaining({ label: "Undo" }),
    });
  });

  it("disables project creation while a move is in progress", async () => {
    const user = userEvent.setup();
    let finishMove: ((moved: boolean) => void) | undefined;
    mockMoveChatToProject.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishMove = resolve;
        }),
    );
    mockProjects = [
      {
        _id: "project-1",
        _creationTime: 1,
        user_id: "user-1",
        name: "Acme target",
        created_at: 1,
        updated_at: 1,
      },
    ];
    render(<ChatItem id="chat-1" title="Target notes" />);

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    await user.click(screen.getByRole("button", { name: "Open task options" }));
    let moveTrigger = await screen.findByRole("menuitem", {
      name: "Move to project",
    });
    act(() => moveTrigger.focus());
    fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });
    await user.click(
      await screen.findByRole("menuitem", { name: "Acme target" }),
    );

    await user.click(screen.getByRole("button", { name: "Open task options" }));
    moveTrigger = await screen.findByRole("menuitem", {
      name: "Move to project",
    });
    act(() => moveTrigger.focus());
    fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });
    expect(
      await screen.findByRole("menuitem", { name: "New project" }),
    ).toHaveAttribute("data-disabled");

    await act(async () => finishMove?.(true));
  });

  it("labels the Rename Task field for keyboard and screen-reader users", async () => {
    const user = userEvent.setup();
    render(<ChatItem id="chat-1" title="Target notes" />);

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    await user.click(screen.getByRole("button", { name: "Open task options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByLabelText("Task name");
    expect(input).toHaveAttribute("name", "taskTitle");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("placeholder", "Task name…");
  });

  it("uses compact side padding for standard and project chat rows", () => {
    render(
      <>
        <ChatItem id="chat-1" title="General notes" />
        <ChatItem id="chat-2" title="Target notes" indentContent />
      </>,
    );

    expect(screen.getByTestId("chat-item-chat-1")).toHaveClass(
      "py-2",
      "ps-2",
      "pe-0.5",
    );
    expect(screen.getByTestId("chat-item-chat-2")).toHaveClass(
      "py-2",
      "ps-6",
      "pe-0.5",
    );
    expect(screen.getByTestId("chat-item-chat-1")).not.toHaveClass("p-2");
    expect(screen.getByTestId("chat-item-chat-2")).not.toHaveClass("p-2");
  });

  it("keeps the entire task row clickable and removes the dedicated drag handle", () => {
    render(<ChatItem id="chat-1" title="Target notes" />);

    const row = screen.getByRole("button", { name: /Open task:/ });
    expect(row).not.toHaveAttribute("draggable");
    expect(row).toHaveClass("cursor-pointer");
    expect(row).toHaveAttribute("aria-roledescription", "draggable task");
    expect(
      screen.queryByTestId("chat-drag-handle-chat-1"),
    ).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(mockRouterPush).toHaveBeenCalledWith("/c/chat-1");
  });

  it("does not start row navigation from the task options control", () => {
    render(<ChatItem id="chat-1" title="Target notes" />);

    const row = screen.getByRole("button", { name: /Open task:/ });
    fireEvent.mouseEnter(row);
    const options = screen.getByRole("button", {
      name: "Open task options",
    });

    fireEvent.mouseDown(options, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(options, { clientX: 20, clientY: 0 });
    fireEvent.mouseUp(options, { button: 0, clientX: 20, clientY: 0 });
    fireEvent.click(options);

    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("uses Enter to open while reserving Space for keyboard dragging", () => {
    render(<ChatItem id="chat-1" title="Target notes" />);

    const row = screen.getByRole("button", { name: /Open task:/ });
    fireEvent.keyDown(row, { key: " " });
    expect(mockRouterPush).not.toHaveBeenCalled();

    fireEvent.keyDown(row, { key: "Enter" });
    expect(mockRouterPush).toHaveBeenCalledWith("/c/chat-1");
  });

  it("does not open the task when Enter completes a keyboard drag", async () => {
    render(
      <KeyboardDragHarness>
        <ChatItem id="chat-1" title="Target notes" />
      </KeyboardDragHarness>,
    );

    const row = screen.getByRole("button", { name: /Open task:/ });
    fireEvent.keyDown(row, { code: "Space", key: " " });
    await waitFor(() => expect(row).toHaveClass("opacity-50"));

    fireEvent.keyDown(row, { code: "Enter", key: "Enter" });
    await waitFor(() => expect(row).not.toHaveClass("opacity-50"));
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("does not expose desktop drag semantics on mobile", () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ChatItem id="chat-1" title="Target notes" />);

    const row = screen.getByRole("button", { name: /Open task:/ });
    expect(row).not.toHaveAttribute("aria-roledescription");
    expect(row).not.toHaveAttribute("draggable");
  });

  it("keeps compact action padding after removing the drag icon", () => {
    render(<ChatItem id="chat-1" title="Target notes" />);

    const row = screen.getByRole("button", { name: /Open task:/ });
    fireEvent.mouseEnter(row);
    expect(
      screen.getByText("Target notes").parentElement?.parentElement,
    ).toHaveClass("pr-9");
    expect(
      screen.getByText("Target notes").parentElement?.parentElement,
    ).not.toHaveClass("pr-[4.5rem]", "pr-[6.5rem]");
    expect(
      screen.queryByTestId("chat-drag-handle-chat-1"),
    ).not.toBeInTheDocument();
    expect(row).not.toHaveAttribute("draggable");
    expect(
      screen.getByRole("button", { name: "Open task options" }),
    ).toBeVisible();
  });

  it("centers the streaming indicator in the task action slot", () => {
    render(<ChatItem id="chat-1" title="Running task" isStreaming />);

    const streamingIcon = screen.getByTestId("chat-item-streaming-icon");
    expect(streamingIcon.parentElement).toHaveClass(
      "flex",
      "size-8",
      "items-center",
      "justify-center",
    );
    expect(
      screen.getByText("Running task").parentElement?.parentElement,
    ).toHaveClass("pr-9");
  });

  it("reserves space for streaming and task actions on mobile", () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ChatItem id="chat-1" title="Running task" isStreaming />);

    expect(
      screen.getByText("Running task").parentElement?.parentElement,
    ).toHaveClass("pr-[4.5rem]");
    expect(
      screen.getByRole("button", { name: "Open task options" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("chat-item-streaming-icon")).toBeInTheDocument();
  });

  it("hides the passive pin icon while keeping the unpin action", async () => {
    const user = userEvent.setup();
    render(<ChatItem id="chat-1" title="Pinned target" isPinned />);

    expect(screen.queryByTestId("chat-item-pin-icon")).not.toBeInTheDocument();

    fireEvent.focus(screen.getByRole("button", { name: /Open task:/ }));
    await user.click(screen.getByRole("button", { name: "Open task options" }));

    expect(
      await screen.findByRole("menuitem", { name: "Unpin" }),
    ).toBeInTheDocument();
  });
});
