import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Doc } from "@/convex/_generated/dataModel";

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ desktopBridgeActive: true }),
}));
jest.mock("@/app/hooks/useStartNewChat", () => ({
  useStartNewChat: () => jest.fn(),
}));
jest.mock("@/app/hooks/useProjects", () => ({
  useMoveChatToProject: jest.fn(),
}));
jest.mock("../ProjectCreateDialog", () => ({
  ProjectCreateDialog: ({ open }: { open: boolean }) => (
    <div data-testid="project-create-dialog" data-open={String(open)} />
  ),
}));
jest.mock("../SidebarProjectItem", () => ({
  SidebarProjectItem: ({
    project,
    open,
    onDropChat,
    onOpenChange,
  }: {
    project: Doc<"projects">;
    open: boolean;
    onDropChat: (chatId: string) => Promise<void>;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid={`project-${project._id}`} data-open={String(open)}>
      {project.name}
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label={`Toggle ${project.name}`}
      />
      <button
        type="button"
        onClick={() => void onDropChat("chat-1")}
        aria-label={`Drop chat in ${project.name}`}
      />
    </div>
  ),
}));

const { useMoveChatToProject: mockUseMoveChatToProject } = jest.requireMock<{
  useMoveChatToProject: jest.Mock;
}>("@/app/hooks/useProjects");

const { SidebarProjects } =
  require("../SidebarProjects") as typeof import("../SidebarProjects");

const projects = ["Acme", "Example"].map(
  (name, index) =>
    ({
      _id: `project-${index + 1}`,
      _creationTime: index + 1,
      user_id: "user-1",
      name,
      created_at: index + 1,
      updated_at: index + 1,
    }) as unknown as Doc<"projects">,
);

describe("SidebarProjects", () => {
  const moveChatToProject = jest.fn<any>().mockResolvedValue(true);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseMoveChatToProject.mockReturnValue(moveChatToProject);
  });

  it("only shows collapse-all while an individual project is open", () => {
    render(<SidebarProjects projects={projects} />);

    expect(
      screen.queryByRole("button", { name: "Collapse all projects" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle Acme" }));
    expect(screen.getByTestId("project-project-1")).toHaveAttribute(
      "data-open",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Collapse all projects" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse all projects" }),
    );
    expect(screen.getByTestId("project-project-1")).toHaveAttribute(
      "data-open",
      "false",
    );
    expect(
      screen.queryByRole("button", { name: "Collapse all projects" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("project-project-2")).toHaveAttribute(
      "data-open",
      "false",
    );
  });

  it("shows a new-project row when there are no projects", () => {
    render(<SidebarProjects projects={[]} />);

    expect(
      screen.getByRole("button", { name: "New project" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("project-create-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "New project" }));

    expect(screen.getByTestId("project-create-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
  });

  it("does not show the new-project row when projects exist", () => {
    render(<SidebarProjects projects={projects} />);

    expect(
      screen.queryByRole("button", { name: "New project" }),
    ).not.toBeInTheDocument();
  });

  it("loads ten more projects", () => {
    const loadMore = jest.fn();
    render(
      <SidebarProjects
        projects={projects}
        paginationStatus="CanLoadMore"
        loadMore={loadMore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show more projects" }));
    expect(loadMore).toHaveBeenCalledWith(10);
  });

  it("collapses the entire projects section from its heading", () => {
    render(<SidebarProjects projects={projects} />);

    expect(screen.getByTestId("projects-section-chevron")).toHaveClass(
      "rotate-90",
      "opacity-0",
    );
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    expect(screen.getByTestId("projects-section-chevron")).not.toHaveClass(
      "rotate-90",
    );
    expect(screen.getByTestId("projects-section-chevron")).toHaveClass(
      "opacity-100",
    );
    expect(screen.queryByTestId("project-project-1")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse all projects" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create project" }),
    ).toBeInTheDocument();
  });

  it("moves a dropped chat and opens the target project", async () => {
    render(<SidebarProjects projects={projects} />);

    fireEvent.click(screen.getByRole("button", { name: "Drop chat in Acme" }));

    await waitFor(() => {
      expect(moveChatToProject).toHaveBeenCalledWith({
        chatId: "chat-1",
        projectId: "project-1",
      });
    });
    expect(screen.getByTestId("project-project-1")).toHaveAttribute(
      "data-open",
      "true",
    );
  });
});
