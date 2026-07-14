import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
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

const { createProject, getProjectThreads, listProjects } =
  require("../projects") as typeof import("../projects");

describe("projects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a trimmed user-owned project with an explicit folder", async () => {
    const insert = jest.fn<any>().mockResolvedValue("project-1");
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-1" }),
      },
      db: { insert },
    };

    await expect(
      createProject.handler(ctx as any, {
        name: "  Acme target  ",
        folderPath: "  /Users/hackerai/targets/acme  ",
      }),
    ).resolves.toBe("project-1");

    expect(insert).toHaveBeenCalledWith("projects", {
      user_id: "user-1",
      name: "Acme target",
      folder_path: "/Users/hackerai/targets/acme",
      created_at: expect.any(Number),
      updated_at: expect.any(Number),
    });
  });

  it("returns no threads when the project is not owned by the user", async () => {
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-1" }),
      },
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

  it("bounds the project list returned for a user", async () => {
    const take = jest.fn<any>().mockResolvedValue([]);
    const order = jest.fn<any>().mockReturnValue({ take });
    const eq = jest.fn<any>().mockReturnThis();
    const withIndex = jest.fn<any>((_indexName, applyIndex) => {
      applyIndex({ eq });
      return { order };
    });
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-1" }),
      },
      db: {
        query: jest.fn<any>().mockReturnValue({ withIndex }),
      },
    };

    await expect(listProjects.handler(ctx as any, {})).resolves.toEqual([]);

    expect(withIndex).toHaveBeenCalledWith(
      "by_user_and_updated",
      expect.any(Function),
    );
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(order).toHaveBeenCalledWith("desc");
    expect(take).toHaveBeenCalledWith(100);
  });
});
