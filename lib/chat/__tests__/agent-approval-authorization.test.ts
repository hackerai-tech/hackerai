import {
  AGENT_APPROVAL_AUTHORIZATION_MAX_AGE_MS,
  AgentApprovalAuthorizationError,
  signAgentToolApprovalInput,
  verifyAgentToolApprovalInputAuthorization,
} from "@/lib/chat/agent-approval-authorization";
import {
  AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
  type UnsignedAgentToolApprovalInputRecord,
} from "@/types";

const NOW = Date.parse("2026-07-12T12:00:00Z");
const SECRET = "test-agent-approval-secret";

const buildInput = (): UnsignedAgentToolApprovalInputRecord => ({
  type: "agent-tool-approval",
  protocolVersion: AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
  approvalId: "approval-1",
  toolCallId: "tool-call-1",
  decision: "approve",
  grant: "full_access",
  at: NOW,
  authorization: {
    issuedAt: NOW,
    userId: "user-1",
    chatId: "chat-1",
    runId: "run-1",
    approvalSessionId: "session-1",
    subscription: "pro",
    organizationId: "org-1",
  },
});

const expected = {
  userId: "user-1",
  chatId: "chat-1",
  runId: "run-1",
  approvalSessionId: "session-1",
  approvalId: "approval-1",
  toolCallId: "tool-call-1",
};

describe("Agent approval authorization", () => {
  it("accepts a fresh signed approval bound to the current run", () => {
    const input = signAgentToolApprovalInput(buildInput(), { secret: SECRET });

    expect(
      verifyAgentToolApprovalInputAuthorization({
        input,
        expected,
        now: NOW,
        secret: SECRET,
      }),
    ).toMatchObject({ subscription: "pro", organizationId: "org-1" });
  });

  it("rejects an incompatible protocol version", () => {
    const input = signAgentToolApprovalInput(buildInput(), { secret: SECRET });
    const incompatible = { ...input, protocolVersion: 3 } as typeof input;

    expect(() =>
      verifyAgentToolApprovalInputAuthorization({
        input: incompatible,
        expected,
        now: NOW,
        secret: SECRET,
      }),
    ).toThrow(
      expect.objectContaining<Partial<AgentApprovalAuthorizationError>>({
        code: "unsupported_protocol",
      }),
    );
  });

  it("rejects a decision changed after the route signs it", () => {
    const input = signAgentToolApprovalInput(buildInput(), { secret: SECRET });
    const tampered = { ...input, decision: "deny" as const };

    expect(() =>
      verifyAgentToolApprovalInputAuthorization({
        input: tampered,
        expected,
        now: NOW,
        secret: SECRET,
      }),
    ).toThrow(
      expect.objectContaining<Partial<AgentApprovalAuthorizationError>>({
        code: "invalid_signature",
      }),
    );
  });

  it("rejects entitlement context changed after the route signs it", () => {
    const input = signAgentToolApprovalInput(buildInput(), { secret: SECRET });
    const tampered = {
      ...input,
      authorization: {
        ...input.authorization!,
        subscription: "ultra" as const,
      },
    };

    expect(() =>
      verifyAgentToolApprovalInputAuthorization({
        input: tampered,
        expected,
        now: NOW,
        secret: SECRET,
      }),
    ).toThrow(
      expect.objectContaining<Partial<AgentApprovalAuthorizationError>>({
        code: "invalid_signature",
      }),
    );
  });

  it("rejects stale authorization after a long approval wait", () => {
    const input = signAgentToolApprovalInput(buildInput(), { secret: SECRET });

    expect(() =>
      verifyAgentToolApprovalInputAuthorization({
        input,
        expected,
        now: NOW + AGENT_APPROVAL_AUTHORIZATION_MAX_AGE_MS + 1,
        secret: SECRET,
      }),
    ).toThrow(
      expect.objectContaining<Partial<AgentApprovalAuthorizationError>>({
        code: "stale_authorization",
      }),
    );
  });

  it("rejects a signed authorization for a different run", () => {
    const input = signAgentToolApprovalInput(buildInput(), { secret: SECRET });

    expect(() =>
      verifyAgentToolApprovalInputAuthorization({
        input,
        expected: { ...expected, runId: "run-2" },
        now: NOW,
        secret: SECRET,
      }),
    ).toThrow(
      expect.objectContaining<Partial<AgentApprovalAuthorizationError>>({
        code: "authorization_mismatch",
      }),
    );
  });
});
