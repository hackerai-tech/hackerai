import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalMutation: jest.fn((config: unknown) => config),
  mutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
}));
jest.mock("../_generated/api", () => ({
  internal: {
    projects: { detachProjectTasksBatch: "detachProjectTasksBatch" },
  },
}));
jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    string: jest.fn(() => "string"),
    optional: jest.fn(() => "optional"),
  },
  ConvexError: class ConvexError extends Error {
    data: unknown;
    constructor(data: { message: string }) {
      super(data.message);
      this.data = data;
    }
  },
}));
jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn().mockResolvedValue(undefined),
}));

const {
  createProject,
  deleteProject,
  getProjectThreads,
  listProjects,
  pinProject,
  updateProject,
} = require("../projects") as typeof import("../projects");

const authenticated = {
  getUserIdentity: jest.fn<any>().mockResolvedValue({ subject: "user-1" }),
};

const project = {
  _id: "project-1",
  user_id: "user-1",
  name: "Acme",
  created_at: 1,
  updated_at: 1,
};

describe("projects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated.getUserIdentity.mockResolvedValue({ subject: "user-1" });
  });

  it("creates a trimmed user-owned project with an explicit folder", async () => {
    const take = jest.fn<any>().mockResolvedValue([]);
    const withIndex = jest.fn<any>().mockReturnValue({ take });
    const insert = jest.fn<any>().mockResolvedValue("project-1");
    const ctx = {
      auth: authenticated,
      db: {
        query: jest.fn<any>().mockReturnValue({ withIndex }),
        insert,
      },
    };

    await expect(
      createProject.handler(ctx as any, {
        name: "  Acme target  ",
        folderPath: "  /Users/hackerai/targets/acme  ",
      }),
    ).resolves.toBe("project-1");

    expect(take).toHaveBeenCalledWith(100);
    expect(insert).toHaveBeenCalledWith("projects", {
      user_id: "user-1",
      name: "Acme target",
      folder_path: "/Users/hackerai/targets/acme",
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });

  it("enforces the project limit before inserting", async () => {
    const take = jest
      .fn<any>()
      .mockResolvedValue(Array.from({ length: 100 }, (_, index) => index));
    const insert = jest.fn();
    const ctx = {
      auth: authenticated,
      db: {
        query: jest.fn<any>().mockReturnValue({
          withIndex: jest.fn<any>().mockReturnValue({ take }),
        }),
        insert,
      },
    };

    await expect(
      createProject.handler(ctx as any, { name: "One too many" }),
    ).rejects.toThrow("You can have up to 100 projects");
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns pinned projects first and paginates unpinned projects", async () => {
    const pinnedProject = { ...project, pinned_at: 20 };
    const unpinnedProject = { ...project, _id: "project-2", name: "Beta" };
    const pinnedTake = jest.fn<any>().mockResolvedValue([pinnedProject]);
    const pinnedOrder = jest.fn<any>().mockReturnValue({ take: pinnedTake });
    const pinnedFilter = jest.fn<any>().mockReturnValue({ order: pinnedOrder });
    const pinnedGt = jest.fn<any>().mockReturnThis();
    const pinnedEq = jest.fn<any>().mockReturnValue({ gt: pinnedGt });
    const pinnedWithIndex = jest.fn<any>((_name, applyIndex) => {
      applyIndex({ eq: pinnedEq });
      return { filter: pinnedFilter };
    });

    const page = {
      page: [unpinnedProject],
      isDone: true,
      continueCursor: "",
    };
    const paginate = jest.fn<any>().mockResolvedValue(page);
    const unpinnedOrder = jest.fn<any>().mockReturnValue({ paginate });
    const unpinnedFilter = jest
      .fn<any>()
      .mockReturnValue({ order: unpinnedOrder });
    const unpinnedWithIndex = jest.fn<any>().mockReturnValue({
      filter: unpinnedFilter,
    });
    const ctx = {
      auth: authenticated,
      db: {
        query: jest
          .fn<any>()
          .mockReturnValueOnce({ withIndex: pinnedWithIndex })
          .mockReturnValueOnce({ withIndex: unpinnedWithIndex }),
      },
    };

    await expect(
      listProjects.handler(ctx as any, {
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    ).resolves.toEqual({
      ...page,
      page: [pinnedProject, unpinnedProject],
    });
    expect(pinnedTake).toHaveBeenCalledWith(100);
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 10 });
  });

  it("updates and pins an owned project", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      auth: authenticated,
      db: {
        get: jest.fn<any>().mockResolvedValue(project),
        patch,
      },
    };

    await updateProject.handler(ctx as any, {
      projectId: "project-1" as any,
      name: "  Renamed  ",
    });
    expect(patch).toHaveBeenCalledWith("project-1", {
      name: "Renamed",
      updated_at: expect.any(Number),
    });

    await pinProject.handler(ctx as any, {
      projectId: "project-1" as any,
    });
    expect(patch).toHaveBeenCalledWith("project-1", {
      pinned_at: expect.any(Number),
    });
  });

  it("deletes a project while preserving its tasks", async () => {
    const tasks = [{ _id: "task-1" }, { _id: "task-2" }];
    const take = jest.fn<any>().mockResolvedValue(tasks);
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const deleteDocument = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      auth: authenticated,
      db: {
        get: jest
          .fn<any>()
          .mockResolvedValueOnce(project)
          .mockResolvedValueOnce({ ...project, deletion_started_at: 10 }),
        patch,
        delete: deleteDocument,
        query: jest.fn<any>().mockReturnValue({
          withIndex: jest.fn<any>().mockReturnValue({ take }),
        }),
      },
      scheduler: { runAfter: jest.fn() },
    };

    await deleteProject.handler(ctx as any, {
      projectId: "project-1" as any,
    });

    expect(patch).toHaveBeenCalledWith("project-1", {
      deletion_started_at: expect.any(Number),
    });
    expect(patch).toHaveBeenCalledWith("task-1", { project_id: undefined });
    expect(patch).toHaveBeenCalledWith("task-2", { project_id: undefined });
    expect(deleteDocument).toHaveBeenCalledWith("project-1");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("returns no tasks when the project is not owned by the user", async () => {
    const ctx = {
      auth: authenticated,
      db: {
        get: jest.fn<any>().mockResolvedValue({
          _id: "project-1",
          user_id: "another-user",
        }),
        query: jest.fn(),
      },
    };

    await expect(
      getProjectThreads.handler(ctx as any, {
        projectId: "project-1" as any,
        paginationOpts: { cursor: null, numItems: 5 },
      }),
    ).resolves.toEqual({ page: [], isDone: true, continueCursor: "" });
    expect(ctx.db.query).not.toHaveBeenCalled();
  });
});
