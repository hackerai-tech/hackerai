import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalMutation: jest.fn((config) => config),
  mutation: jest.fn((config) => config),
  query: jest.fn((config) => config),
}));

jest.mock("convex/values", () => ({
  v: new Proxy(
    {},
    {
      get: () => jest.fn(() => "validator"),
    },
  ),
  ConvexError: class ConvexError extends Error {},
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

describe("cloud sandbox session cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not create a MicroVM session after account deletion starts", async () => {
    const query = jest.fn((table: string) => {
      expect(table).toBe("user_deletion_fences");
      return {
        withIndex: jest.fn(() => ({
          first: jest.fn().mockResolvedValue({ _id: "fence-1" }),
        })),
      };
    });
    const insert = jest.fn();
    const { beginCloudSession } = await import("../localSandbox");

    await expect(
      beginCloudSession.handler({ db: { query, insert } } as never, {
        serviceKey: "service-key",
        userId: "user-1",
        region: "us-east-1",
        imageIdentifier: "image-1",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(insert).not.toHaveBeenCalled();
  });

  it("purges only terminal rows and disconnects their relay records", async () => {
    const statuses: string[] = [];
    const rowsByStatus = {
      failed: [
        {
          _id: "session-failed",
          status: "failed",
          connection_id: "connection-1",
        },
      ],
      terminated: [{ _id: "session-terminated", status: "terminated" }],
    } as const;
    const patch = jest.fn().mockResolvedValue(undefined);
    const deleteRow = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn((table: string) => {
      if (table === "local_sandbox_connections") {
        return {
          withIndex: jest.fn(() => ({
            unique: jest.fn().mockResolvedValue({
              _id: "connection-row-1",
              status: "connected",
            }),
          })),
        };
      }
      return {
        withIndex: jest.fn((_index, buildRange) => {
          let selectedStatus = "";
          buildRange({
            eq: jest.fn((_field, status: string) => {
              selectedStatus = status;
              statuses.push(status);
              return { lt: jest.fn(() => ({})) };
            }),
          });
          return {
            order: jest.fn(() => ({
              take: jest.fn(async (limit: number) =>
                (
                  rowsByStatus[selectedStatus as keyof typeof rowsByStatus] ??
                  []
                ).slice(0, limit),
              ),
            })),
          };
        }),
      };
    });
    const { purgeStaleCloudSessions } = await import("../localSandbox");

    await expect(
      purgeStaleCloudSessions.handler(
        { db: { query, patch, delete: deleteRow } } as never,
        { cutoffTimeMs: 1_000, limit: 10 },
      ),
    ).resolves.toEqual({ deletedCount: 2 });

    expect(statuses).toEqual(["failed", "terminated"]);
    expect(patch).toHaveBeenCalledWith(
      "connection-row-1",
      expect.objectContaining({
        status: "disconnected",
        disconnect_reason: "client_disconnect",
      }),
    );
    expect(deleteRow.mock.calls).toEqual([
      ["session-failed"],
      ["session-terminated"],
    ]);
  });
});
