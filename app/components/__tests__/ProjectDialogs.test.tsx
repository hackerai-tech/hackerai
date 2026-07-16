import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Doc } from "@/convex/_generated/dataModel";

const mockUpdateProject = jest.fn<any>().mockResolvedValue(null);
const mockDeleteProject = jest.fn<any>().mockResolvedValue(null);

jest.mock("@/app/hooks/useProjects", () => ({
  useUpdateProject: () => mockUpdateProject,
  useDeleteProject: () => mockDeleteProject,
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
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
