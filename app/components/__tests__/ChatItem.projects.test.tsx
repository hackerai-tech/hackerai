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

const mockMoveChatToProject = jest.fn<any>();
const mockToastSuccess = jest.fn();
const mockToastInfo = jest.fn();
let mockProjects: any[] | undefined;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
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
