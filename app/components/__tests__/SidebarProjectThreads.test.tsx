import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Doc } from "@/convex/_generated/dataModel";
jest.mock("@/app/hooks/useProjects", () => ({
  useProjectThreads: jest.fn(),
}));
jest.mock("../ChatItem", () => ({
  __esModule: true,
  default: ({
    id,
    title,
    indentContent,
  }: {
    id: string;
    title: string;
    indentContent?: boolean;
  }) => (
    <div data-testid={`chat-${id}`} data-indent={String(indentContent)}>
      {title}
    </div>
  ),
}));

const { useProjectThreads: mockUseProjectThreads } = jest.requireMock<{
  useProjectThreads: jest.MockedFunction<
    typeof import("@/app/hooks/useProjects").useProjectThreads
  >;
}>("@/app/hooks/useProjects");
const { SidebarProjectThreads } =
  require("../SidebarProjectThreads") as typeof import("../SidebarProjectThreads");
const project = {
  _id: "project-1",
  _creationTime: 1,
  user_id: "user-1",
  name: "Acme",
  created_at: 1,
  updated_at: 1,
} as unknown as Doc<"projects">;

describe("SidebarProjectThreads", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requests ten additional threads from Show more", () => {
    const loadMore = jest.fn();
    mockUseProjectThreads.mockReturnValue({
      results: Array.from({ length: 5 }, (_, index) => ({
        _id: `doc-${index}`,
        id: `chat-${index}`,
        title: `Thread ${index + 1}`,
      })),
      status: "CanLoadMore",
      loadMore,
      isLoading: false,
    } as ReturnType<
      typeof import("@/app/hooks/useProjects").useProjectThreads
    >);

    render(<SidebarProjectThreads project={project} />);

    expect(screen.getAllByTestId(/^chat-chat-/)).toHaveLength(5);
    expect(screen.getByTestId("chat-chat-0")).toHaveAttribute(
      "data-indent",
      "true",
    );
    expect(screen.getByTestId("chat-chat-0").parentElement).toHaveClass(
      "w-full",
    );
    expect(screen.getByTestId("chat-chat-0").parentElement).not.toHaveClass(
      "px-2",
      "ps-7",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(loadMore).toHaveBeenCalledWith(10);
  });

  it("shows the empty project state", () => {
    mockUseProjectThreads.mockReturnValue({
      results: [],
      status: "Exhausted",
      loadMore: jest.fn(),
      isLoading: false,
    } as ReturnType<
      typeof import("@/app/hooks/useProjects").useProjectThreads
    >);

    render(<SidebarProjectThreads project={project} />);

    expect(screen.getByText("No threads yet")).toBeInTheDocument();
    expect(screen.queryByText("Show more")).not.toBeInTheDocument();
  });
});
