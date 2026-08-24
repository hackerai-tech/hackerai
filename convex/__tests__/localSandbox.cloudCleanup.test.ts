import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { webcrypto } from "node:crypto";

const originalCrypto = globalThis.crypto;

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
});

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
    expect(query).toHaveBeenCalledWith("user_deletion_fences");
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps a healthy active session pinned across region and image changes", async () => {
    const now = Date.now();
    const active = {
      _id: "session-row-1",
      user_id: "user-1",
      session_id: "session-1",
      provider: "aws-lambda-microvm",
      status: "active",
      microvm_id: "microvm-1",
      connection_id: "connection-1",
      bootstrap_expires_at: now + 60_000,
      region: "us-east-1",
      image_identifier: "east-image",
      image_version: "14.0",
      egress_connector_arn:
        "arn:aws:lambda:us-east-1:123:network-connector:retained:7",
      egress_ipv4_address: "192.0.2.7",
      created_at: now - 1_000,
      updated_at: now - 500,
    };
    const query = jest.fn((table: string) => {
      if (table === "user_deletion_fences") {
        return {
          withIndex: jest.fn(() => ({
            first: jest.fn().mockResolvedValue(null),
          })),
        };
      }
      expect(table).toBe("cloud_sandbox_sessions");
      return {
        withIndex: jest.fn((_index, buildRange) => {
          let status = "";
          const range = {
            eq: jest.fn((_field: string, value: string) => {
              if (
                value === "starting" ||
                value === "active" ||
                value === "running"
              ) {
                status = value;
              }
              return range;
            }),
          };
          buildRange(range);
          return {
            order: jest.fn(() => ({
              take: jest
                .fn()
                .mockResolvedValue(status === "active" ? [active] : []),
            })),
          };
        }),
      };
    });
    const insert = jest.fn();
    const patch = jest.fn();
    const { beginCloudSession } = await import("../localSandbox");

    await expect(
      beginCloudSession.handler({ db: { query, insert, patch } } as never, {
        serviceKey: "service-key",
        userId: "user-1",
        region: "eu-west-1",
        imageIdentifier: "eu-image",
        imageVersion: "2.0",
        egressConnectorArn:
          "arn:aws:lambda:eu-west-1:123:network-connector:new:8",
        egressIpv4Address: "192.0.2.8",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        created: false,
        session: expect.objectContaining({
          sessionId: "session-1",
          region: "us-east-1",
          imageIdentifier: "east-image",
          imageVersion: "14.0",
          egressConnectorArn:
            "arn:aws:lambda:us-east-1:123:network-connector:retained:7",
          egressIpv4Address: "192.0.2.7",
        }),
        cleanupCandidates: [],
      }),
    );
    expect(insert).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("persists regional failover placement metadata on the replacement session", async () => {
    const query = jest.fn((table: string) => {
      if (table === "user_deletion_fences") {
        return {
          withIndex: jest.fn(() => ({
            first: jest.fn().mockResolvedValue(null),
          })),
        };
      }
      expect(table).toBe("cloud_sandbox_sessions");
      return {
        withIndex: jest.fn(() => ({
          order: jest.fn(() => ({
            take: jest.fn().mockResolvedValue([]),
          })),
        })),
      };
    });
    const insert = jest.fn().mockResolvedValue("session-row-failover");
    const { beginCloudSession } = await import("../localSandbox");

    await expect(
      beginCloudSession.handler({ db: { query, insert } } as never, {
        serviceKey: "service-key",
        userId: "user-failover",
        region: "us-west-2",
        requestedRegion: "us-east-1",
        placementReason: "regional_capacity_failover",
        imageIdentifier: "west-image",
        imageVersion: "15.0",
        egressConnectorArn:
          "arn:aws:lambda:us-west-2:123:network-connector:west:3",
        egressIpv4Address: "192.0.2.33",
        failoverFromRegion: "us-east-1",
        failoverErrorName: "ThrottlingException",
        failoverStartedAt: 1_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        created: true,
        session: expect.objectContaining({
          region: "us-west-2",
          requestedRegion: "us-east-1",
          placementReason: "regional_capacity_failover",
          failoverFromRegion: "us-east-1",
          failoverErrorName: "ThrottlingException",
          failoverStartedAt: 1_000,
          egressConnectorArn:
            "arn:aws:lambda:us-west-2:123:network-connector:west:3",
          egressIpv4Address: "192.0.2.33",
        }),
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "cloud_sandbox_sessions",
      expect.objectContaining({
        region: "us-west-2",
        requested_region: "us-east-1",
        placement_reason: "regional_capacity_failover",
        failover_from_region: "us-east-1",
        failover_error_name: "ThrottlingException",
        failover_started_at: 1_000,
        egress_connector_arn:
          "arn:aws:lambda:us-west-2:123:network-connector:west:3",
        egress_ipv4_address: "192.0.2.33",
      }),
    );
  });

  it("records successful regional failover timing when the endpoint is ready", async () => {
    const failoverStartedAt = Date.now() - 25;
    const patch = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(() => ({
      withIndex: jest.fn(() => ({
        unique: jest.fn().mockResolvedValue({
          _id: "session-row-ready",
          user_id: "user-failover-ready",
          session_id: "session-failover-ready",
          status: "starting",
          microvm_id: "microvm-failover-ready",
          failover_started_at: failoverStartedAt,
        }),
      })),
    }));
    const { markCloudDirectReady } = await import("../localSandbox");

    await expect(
      markCloudDirectReady.handler({ db: { query, patch } } as never, {
        serviceKey: "service-key",
        userId: "user-failover-ready",
        sessionId: "session-failover-ready",
        microvmId: "microvm-failover-ready",
      }),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "session-row-ready",
      expect.objectContaining({
        status: "active",
        aws_state: "RUNNING",
        aws_state_checked_at: expect.any(Number),
        failover_completed_at: expect.any(Number),
        failover_duration_ms: expect.any(Number),
        failover_outcome: "succeeded",
      }),
    );
  });

  it("records an authenticated guest lifecycle transition", async () => {
    const bootstrapToken = "hcs_lifecycle_test";
    const bootstrapHash = Array.from(
      new Uint8Array(
        await webcrypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(bootstrapToken),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const patch = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(() => ({
      withIndex: jest.fn(() => ({
        unique: jest.fn().mockResolvedValue({
          _id: "session-row-lifecycle",
          user_id: "user-lifecycle",
          session_id: "session-lifecycle",
          status: "active",
          microvm_id: "microvm-lifecycle",
          bootstrap_token_hash: bootstrapHash,
          bootstrap_expires_at: Date.now() + 60_000,
        }),
      })),
    }));
    const { reportCloudLifecycleState } = await import("../localSandbox");

    await expect(
      reportCloudLifecycleState.handler({ db: { query, patch } } as never, {
        sessionId: "session-lifecycle",
        bootstrapToken,
        microvmId: "microvm-lifecycle",
        state: "SUSPENDING",
      }),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "session-row-lifecycle",
      expect.objectContaining({
        aws_state: "SUSPENDING",
        aws_state_checked_at: expect.any(Number),
      }),
    );
  });

  it("marks a physically terminated legacy session terminal", async () => {
    const patch = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(() => ({
      withIndex: jest.fn(() => ({
        unique: jest.fn().mockResolvedValue({
          _id: "session-row-stale",
          user_id: "user-stale",
          session_id: "session-stale",
          status: "running",
          microvm_id: "microvm-stale",
        }),
      })),
    }));
    const { recordCloudMicrovmStateForBackend } =
      await import("../localSandbox");

    await expect(
      recordCloudMicrovmStateForBackend.handler(
        { db: { query, patch } } as never,
        {
          serviceKey: "service-key",
          userId: "user-stale",
          sessionId: "session-stale",
          microvmId: "microvm-stale",
          state: "TERMINATED",
          failureCode: "microvm_ended",
        },
      ),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "session-row-stale",
      expect.objectContaining({
        status: "terminated",
        aws_state: "TERMINATED",
        failure_code: "microvm_ended",
        ended_at: expect.any(Number),
      }),
    );
  });

  it("records failed regional failover timing when the replacement ends", async () => {
    const failoverStartedAt = Date.now() - 25;
    const patch = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn(() => ({
      withIndex: jest.fn(() => ({
        unique: jest.fn().mockResolvedValue({
          _id: "session-row-failed",
          user_id: "user-failover-failed",
          session_id: "session-failover-failed",
          status: "starting",
          failover_started_at: failoverStartedAt,
        }),
      })),
    }));
    const { markCloudSessionEnded } = await import("../localSandbox");

    await expect(
      markCloudSessionEnded.handler({ db: { query, patch } } as never, {
        serviceKey: "service-key",
        userId: "user-failover-failed",
        sessionId: "session-failover-failed",
        status: "failed",
        failureCode: "quota_exceeded",
      }),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "session-row-failed",
      expect.objectContaining({
        status: "failed",
        failover_completed_at: expect.any(Number),
        failover_duration_ms: expect.any(Number),
        failover_outcome: "failed",
      }),
    );
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
