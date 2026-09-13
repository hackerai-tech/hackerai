import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCreateProject = jest.fn<any>();
const mockPickLocalFolder = jest.fn<any>();
let mockDesktopBridgeActive = false;
let mockIsTauriEnvironment = false;

jest.mock("@/app/hooks/useProjects", () => ({
  useCreateProject: () => mockCreateProject,
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ desktopBridgeActive: mockDesktopBridgeActive }),
}));
jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));
jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: () => mockIsTauriEnvironment,
  pickLocalFolder: () => mockPickLocalFolder(),
}));

const { ProjectCreateDialog } =
  require("../ProjectCreateDialog") as typeof import("../ProjectCreateDialog");

describe("ProjectCreateDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDesktopBridgeActive = false;
    mockIsTauriEnvironment = false;
  });

  it("keeps Web project creation lightweight", () => {
    render(
      <ProjectCreateDialog
        open
        onCreated={jest.fn()}
        onOpenChange={jest.fn()}
      />,
    );

    expect(
      screen.getByText("Group related tasks in one place."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Local folder (optional)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use existing folder" }),
    ).not.toBeInTheDocument();
  });

  it("lets Desktop projects use an existing local folder", async () => {
    mockIsTauriEnvironment = true;
    mockDesktopBridgeActive = true;
    mockPickLocalFolder.mockResolvedValue(
      "/Users/hackerai/targets/acme-security",
    );
    mockCreateProject.mockResolvedValue("project-1");
    const user = userEvent.setup();
    const onCreated = jest.fn();

    render(
      <ProjectCreateDialog
        open
        onCreated={onCreated}
        onOpenChange={jest.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Group related tasks and optionally link a local folder for Agent.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Local folder (optional)")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Use an existing folder to make new Agent tasks start there, or skip this for a lightweight project.",
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Use existing folder" }),
    );

    expect(mockPickLocalFolder).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("/Users/hackerai/targets/acme-security"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("acme-security");
    expect(
      screen.getByText("New Agent tasks will start in this folder."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith({
        name: "acme-security",
        folderPath: "/Users/hackerai/targets/acme-security",
      });
      expect(onCreated).toHaveBeenCalledWith("project-1", "acme-security");
    });
  });

  it("explains when a selected folder is waiting for Desktop", async () => {
    mockIsTauriEnvironment = true;
    mockPickLocalFolder.mockResolvedValue("/Users/hackerai/targets/acme");
    const user = userEvent.setup();

    render(
      <ProjectCreateDialog
        open
        onCreated={jest.fn()}
        onOpenChange={jest.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Use existing folder" }),
    );

    expect(
      await screen.findByText(
        "This folder will be ready for Agent tasks when Desktop finishes connecting.",
      ),
    ).toBeInTheDocument();
  });

  it("blocks dismissal while creating", async () => {
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
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
      expect(mockCreateProject).toHaveBeenCalledWith({ name: "Acme" });
    });

    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();

    finishCreate?.("project-1");
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("project-1", "Acme");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
