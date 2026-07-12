import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  getAgentApprovalConnectionSandboxIdentity,
  serializeSandboxScopedAgentApprovalTargetPrefix,
} from "../../types/agent";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    array: jest.fn(() => "array"),
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    any: jest.fn(() => "any"),
  },
  ConvexError: class ConvexError extends Error {},
}));

jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

jest.mock("../_generated/api", () => ({
  internal: { chats: {}, redisPubsub: {}, s3Cleanup: {} },
}));

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

const mockValidateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => mockValidateServiceKey(...args),
}));

jest.mock("../lib/suspensionGuards", () => ({
  CHAT_ACCESS_SUSPENDED_CODE: "CHAT_ACCESS_SUSPENDED",
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
}));

const { persistAgentApprovalGrant } =
  require("../chats") as typeof import("../chats");

const commandTargetPrefix = '["npm","test"]';
const grant = {
  kind: "terminal_command" as const,
  targetPrefix: serializeSandboxScopedAgentApprovalTargetPrefix({
    sandboxIdentity: "e2b",
    targetPrefix: commandTargetPrefix,
  }),
  executable: "npm",
  argv: ["npm", "test"],
};

const makeCtx = (chat: Record<string, unknown> | null) => {
  const first = jest.fn<any>().mockResolvedValue(chat);
  const withIndex = jest.fn(() => ({ first }));
  const query = jest.fn(() => ({ withIndex }));
  const patch = jest.fn<any>().mockResolvedValue(undefined);
  return {
    ctx: { db: { query, patch } } as any,
    patch,
  };
};

describe("persistAgentApprovalGrant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores a server-derived grant on the owning chat", async () => {
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      user_id: "user-1",
      agent_approval_grants: [],
    });

    await persistAgentApprovalGrant.handler(ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
      userId: "user-1",
      grant,
    });

    expect(mockValidateServiceKey).toHaveBeenCalledWith("service-key");
    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      agent_approval_grants: [grant],
    });
  });

  it("deduplicates the same grant and rejects cross-user writes", async () => {
    const duplicate = makeCtx({
      _id: "chat-doc-1",
      user_id: "user-1",
      agent_approval_grants: [grant],
    });
    await persistAgentApprovalGrant.handler(duplicate.ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
      userId: "user-1",
      grant,
    });
    expect(duplicate.patch).not.toHaveBeenCalled();

    const otherUser = makeCtx({
      _id: "chat-doc-1",
      user_id: "other-user",
      agent_approval_grants: [],
    });
    await persistAgentApprovalGrant.handler(otherUser.ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
      userId: "user-1",
      grant,
    });
    expect(otherUser.patch).not.toHaveBeenCalled();
  });

  it("stores the same target separately for different sandbox identities", async () => {
    const desktopGrant = {
      ...grant,
      targetPrefix: serializeSandboxScopedAgentApprovalTargetPrefix({
        sandboxIdentity: getAgentApprovalConnectionSandboxIdentity(
          "desktop-connection-1",
        ),
        targetPrefix: commandTargetPrefix,
      }),
    };
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      user_id: "user-1",
      agent_approval_grants: [grant],
    });

    await persistAgentApprovalGrant.handler(ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
      userId: "user-1",
      grant: desktopGrant,
    });

    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      agent_approval_grants: [grant, desktopGrant],
    });
  });

  it("rejects legacy grants without a sandbox scope", async () => {
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      user_id: "user-1",
      agent_approval_grants: [],
    });

    await persistAgentApprovalGrant.handler(ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
      userId: "user-1",
      grant: { ...grant, targetPrefix: commandTargetPrefix },
    });

    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps only the 100 most recent grants", async () => {
    const existingGrants = Array.from({ length: 100 }, (_, index) => ({
      ...grant,
      targetPrefix: JSON.stringify(["npm", `script-${index}`]),
      argv: ["npm", `script-${index}`],
    }));
    const { ctx, patch } = makeCtx({
      _id: "chat-doc-1",
      user_id: "user-1",
      agent_approval_grants: existingGrants,
    });

    await persistAgentApprovalGrant.handler(ctx, {
      serviceKey: "service-key",
      chatId: "chat-1",
      userId: "user-1",
      grant,
    });

    expect(patch).toHaveBeenCalledWith("chat-doc-1", {
      agent_approval_grants: [...existingGrants.slice(1), grant],
    });
  });
});
