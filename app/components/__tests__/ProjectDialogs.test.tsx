import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Doc } from "@/convex/_generated/dataModel";

const mockUpdateProject = jest.fn<any>().mockResolvedValue(null);
const mockDeleteProject = jest.fn<any>().mockResolvedValue(null);
const mockPickLocalFolder = jest.fn<any>();
let mockIsTauriEnvironment = false;

jest.mock("@/app/hooks/useProjects", () => ({
  useUpdateProject: () => mockUpdateProject,
  useDeleteProject: () => mockDeleteProject,
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));
jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => mockIsTauriEnvironment,
  pickLocalFolder: () => mockPickLocalFolder(),
}));

const { ProjectEditDialog } =
  require("../ProjectEditDialog") as typeof import("../ProjectEditDialog");
const { ProjectDeleteDialog } =
  require("../ProjectDeleteDialog") as typeof import("../ProjectDeleteDialog");

const project = {
  _id: "project-1",
  _creationTime: 1,
  user_id: "user-1",
  name: "Acme",
  created_at: 1,
  updated_at: 1,
} as unknown as Doc<"projects">;

describe("project management dialogs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauriEnvironment = false;
  });

  it("renames a project", async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    render(
      <ProjectEditDialog project={project} open onOpenChange={onOpenChange} />,
    );

    const input = screen.getByLabelText("Project name");
    await user.clear(input);
    await user.type(input, "Acme recon");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateProject).toHaveBeenCalledWith({
        projectId: "project-1",
        name: "Acme recon",
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("shows a linked folder as read-only on Web", () => {
    const linkedProject = {
      ...project,
      folder_path: "/Users/hackerai/targets/acme",
    } as Doc<"projects">;

    render(
      <ProjectEditDialog
        project={linkedProject}
        open
        onOpenChange={jest.fn()}
      />,
    );

    expect(
      screen.getByText("/Users/hackerai/targets/acme"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open HackerAI Desktop to change or remove this folder.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove linked folder" }),
    ).not.toBeInTheDocument();
  });

  it("changes a linked folder on Desktop", async () => {
    mockIsTauriEnvironment = true;
    mockPickLocalFolder.mockResolvedValue("/Users/hackerai/targets/beta");
    const user = userEvent.setup();
    const linkedProject = {
      ...project,
      folder_path: "/Users/hackerai/targets/acme",
    } as Doc<"projects">;

    render(
      <ProjectEditDialog
        project={linkedProject}
        open
        onOpenChange={jest.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(
      await screen.findByText("/Users/hackerai/targets/beta"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateProject).toHaveBeenCalledWith({
        projectId: "project-1",
        name: "Acme",
        folderPath: "/Users/hackerai/targets/beta",
      });
    });
  });

  it("unlinks a Desktop folder", async () => {
    mockIsTauriEnvironment = true;
    const user = userEvent.setup();
    const linkedProject = {
      ...project,
      folder_path: "/Users/hackerai/targets/acme",
    } as Doc<"projects">;

    render(
      <ProjectEditDialog
        project={linkedProject}
        open
        onOpenChange={jest.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Remove linked folder" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockUpdateProject).toHaveBeenCalledWith({
        projectId: "project-1",
        name: "Acme",
        folderPath: null,
      });
    });
  });

  it("explains that deleting a project preserves its tasks", async () => {
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    render(
      <ProjectDeleteDialog
        project={project}
        open
        onOpenChange={onOpenChange}
      />,
    );

    expect(
      screen.getByText(/Tasks in this project will be kept/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockDeleteProject).toHaveBeenCalledWith({
        projectId: "project-1",
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
