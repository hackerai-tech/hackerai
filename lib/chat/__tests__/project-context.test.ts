import { beforeEach, describe, expect, it, jest } from "@jest/globals";
jest.mock("@/lib/db/actions", () => ({
  getProjectById: jest.fn(),
}));

const { getProjectById: mockGetProjectById } = jest.requireMock<{
  getProjectById: jest.MockedFunction<
    typeof import("@/lib/db/actions").getProjectById
  >;
}>("@/lib/db/actions");
const { resolveProjectExecutionContext } =
  require("../project-context") as typeof import("../project-context");

describe("resolveProjectExecutionContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns no context for an ungrouped chat", async () => {
    await expect(
      resolveProjectExecutionContext({
        chat: null,
        userId: "user-1",
        mode: "agent",
        sandboxPreference: "desktop",
      }),
    ).resolves.toEqual({});
    expect(mockGetProjectById).not.toHaveBeenCalled();
  });

  it("uses an explicitly selected project for a new Desktop chat", async () => {
    mockGetProjectById.mockResolvedValue({
      _id: "project-1",
      folder_path: "/Users/hackerai/targets/acme",
    } as Awaited<ReturnType<typeof import("@/lib/db/actions").getProjectById>>);

    await expect(
      resolveProjectExecutionContext({
        chat: null,
        requestedProjectId: "project-1",
        userId: "user-1",
        mode: "agent",
        sandboxPreference: "desktop",
      }),
    ).resolves.toEqual({
      projectId: "project-1",
      workingDirectory: "/Users/hackerai/targets/acme",
    });
  });

  it("uses the persisted project instead of a forged replacement", async () => {
    mockGetProjectById.mockResolvedValue({
      _id: "project-existing",
    } as Awaited<ReturnType<typeof import("@/lib/db/actions").getProjectById>>);

    await resolveProjectExecutionContext({
      chat: { project_id: "project-existing" },
      requestedProjectId: "project-forged",
      userId: "user-1",
      mode: "ask",
      sandboxPreference: "e2b",
    });

    expect(mockGetProjectById).toHaveBeenCalledWith({
      id: "project-existing",
      userId: "user-1",
    });
  });

  it("blocks Agent from silently ignoring a Desktop folder", async () => {
    mockGetProjectById.mockResolvedValue({
      _id: "project-1",
      folder_path: "/Users/hackerai/targets/acme",
    } as Awaited<ReturnType<typeof import("@/lib/db/actions").getProjectById>>);

    const error = await resolveProjectExecutionContext({
      chat: { project_id: "project-1" },
      userId: "user-1",
      mode: "agent",
      sandboxPreference: "e2b",
    }).catch((caught) => caught);

    expect(error.cause).toContain("linked to a Desktop folder");
  });
});
