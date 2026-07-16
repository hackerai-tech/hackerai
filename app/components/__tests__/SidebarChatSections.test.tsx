import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("../SidebarProjects", () => ({
  SidebarProjects: () => (
    <section data-testid="sidebar-projects-section">Projects</section>
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

describe("SidebarChatSections", () => {
  it("orders pinned chats before projects and unpinned tasks without duplication", () => {
    render(
      <SidebarChatSections
        chats={chats}
        projects={[]}
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
        projects={[]}
        paginationStatus="Exhausted"
      />,
    );

    expect(screen.getByTestId("sidebar-pinned-section-chevron")).toHaveClass(
      "rotate-90",
    );
    expect(screen.getByTestId("sidebar-tasks-section-chevron")).toHaveClass(
      "rotate-90",
    );

    fireEvent.click(screen.getByRole("button", { name: "Pinned" }));
    expect(
      screen.queryByTestId("sidebar-pinned-chat-list"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-chat-list")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.queryByTestId("sidebar-chat-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-projects-section")).toBeInTheDocument();
  });
});
