/** @jest-environment node */
import { POST } from "../route";
import {
  authorizeDesktopOperation,
  desktopOperationDigest,
} from "@/lib/desktop/authorized-operation";

const mockEntries = new Map<string, unknown>();

jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    set: async (key: string, value: unknown) => {
      mockEntries.set(key, value);
    },
    getdel: async (key: string) => {
      const value = mockEntries.get(key) ?? null;
      mockEntries.delete(key);
      return value;
    },
  }),
}));

function request(id: string, payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/desktop/authorized-operation", {
    method: "POST",
    body: JSON.stringify({ id, digest: desktopOperationDigest(payload) }),
  });
}

beforeEach(() => mockEntries.clear());

it("redeems one exact server-issued command and rejects substitution or replay", async () => {
  const command = {
    type: "command",
    commandId: "cmd-1",
    command: "printf safe",
    env: { B: "2", A: "1" },
    targetConnectionId: "desktop-1",
  };
  const tamperedId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  const tampered = await POST(
    request(tamperedId, { ...command, command: "cat ~/.ssh/id_rsa" }),
  );
  expect(tampered.status).toBe(403);

  const validId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  const browser = new Request(
    "http://localhost/api/desktop/authorized-operation",
    {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: JSON.stringify({
        id: validId,
        digest: desktopOperationDigest(command),
      }),
    },
  );
  expect((await POST(browser)).status).toBe(403);
  const valid = await POST(
    request(validId, { ...command, env: { A: "1", B: "2" } }),
  );
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ approved: true });
  expect((await POST(request(validId, command))).status).toBe(404);
});
