import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCreateProject = jest.fn<any>();

jest.mock("@/app/hooks/useProjects", () => ({
  useCreateProject: () => mockCreateProject,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ desktopBridgeActive: false }),
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));
jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => false,
  pickLocalFolder: jest.fn(),
}));

const { ProjectCreateDialog } =
  require("../ProjectCreateDialog") as typeof import("../ProjectCreateDialog");

describe("ProjectCreateDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses task terminology and blocks dismissal while creating", async () => {
    let finishCreate: ((projectId: string) => void) | undefined;
    mockCreateProject.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const user = userEvent.setup();
    const onCreated = jest.fn();
    const onOpenChange = jest.fn();

    render(
      <ProjectCreateDialog
        open
        onCreated={onCreated}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByText(/Group related tasks/)).toBeInTheDocument();
    const input = screen.getByLabelText("Project name");
    expect(input).toHaveAttribute("name", "projectName");
    expect(input).toHaveAttribute("autocomplete", "off");

    await user.type(input, "Acme");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    });

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    finishCreate?.("project-1");
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("project-1");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
