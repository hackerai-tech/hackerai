import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";

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
});
