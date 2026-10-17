const originalEnv = { ...process.env };
afterAll(() => {
  process.env = originalEnv;
});
const api = {
  readObjectByName: jest.fn(),
  createObject: jest.fn(),
  updateObject: jest.fn(),
  deleteObject: jest.fn(),
};
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({ vault: api })),
}));
import {
  readProxySecret,
  writeProxySecret,
  deleteProxySecret,
} from "../proxy-vault";
const settings = {
  address: "proxy.example.test:1080",
  authenticated: true,
  revision: "rev-1",
};
const proxy = {
  address: settings.address,
  username: "test-user",
  password: "synthetic-password",
};
const object = (revision = settings.revision, userId = "owner") => ({
  id: "vault-object",
  name: `hackerai-cloud-proxy:${userId}`,
  value: JSON.stringify({ userId, revision, proxy }),
  metadata: {
    versionId: "vault-version-1",
    context: { purpose: "hackerai-cloud-proxy" },
  },
});
beforeEach(() => {
  jest.resetAllMocks();
  process.env.WORKOS_API_KEY = "test-only";
  process.env.WORKOS_CLIENT_ID = "test-client";
  // Restore constructor implementation after reset; the module's lazy client is reused.
  require("@workos-inc/node").WorkOS.mockImplementation(() => ({ vault: api }));
  api.readObjectByName.mockResolvedValue(object());
  api.updateObject.mockResolvedValue({});
  api.createObject.mockResolvedValue({});
  api.deleteObject.mockResolvedValue(undefined);
});
it("derives the object name from the server owner and validates the stored owner and revision", async () => {
  expect(await readProxySecret("owner", settings)).toEqual(proxy);
  expect(api.readObjectByName).toHaveBeenCalledWith({
    name: "hackerai-cloud-proxy:owner",
  });
  api.readObjectByName.mockResolvedValueOnce(object("rev-1", "other"));
  await expect(readProxySecret("owner", settings)).rejects.toThrow(
    "could not be read",
  );
  await expect(
    readProxySecret("owner", { ...settings, revision: "rev-2" }),
  ).rejects.toThrow("saved again");
});
it("rotates credentials with a Vault version check and verifies the saved revision", async () => {
  api.readObjectByName
    .mockResolvedValueOnce(object())
    .mockResolvedValueOnce(object("rev-2"));
  await writeProxySecret(
    "owner",
    { ...settings, revision: "rev-2" },
    {
      address: settings.address,
      credentials: { username: proxy.username, password: proxy.password },
    },
    settings,
  );
  expect(api.updateObject).toHaveBeenCalledWith({
    id: "vault-object",
    versionCheck: "vault-version-1",
    value: JSON.stringify({ userId: "owner", revision: "rev-2", proxy }),
  });
});
it("creates missing secrets and never treats a provider outage as a missing secret", async () => {
  api.readObjectByName.mockRejectedValueOnce({ status: 404 });
  await writeProxySecret("owner", settings, {
    address: settings.address,
    credentials: { username: proxy.username, password: proxy.password },
  });
  expect(api.createObject).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "hackerai-cloud-proxy:owner",
      context: { purpose: "hackerai-cloud-proxy" },
    }),
  );
  api.createObject.mockClear();
  api.readObjectByName.mockRejectedValueOnce(new Error("synthetic-password"));
  await expect(
    writeProxySecret("owner", settings, { address: settings.address }),
  ).rejects.toThrow("could not be saved");
  expect(api.createObject).not.toHaveBeenCalled();
});
it("does not forward retained credentials to a changed endpoint", async () => {
  await expect(
    writeProxySecret(
      "owner",
      { ...settings, address: "other.test:1080" },
      { address: "other.test:1080" },
      settings,
    ),
  ).rejects.toThrow("could not be saved");
  expect(api.updateObject).not.toHaveBeenCalled();
});
it("removes only the owned object with a version check, and sanitizes failures", async () => {
  await deleteProxySecret("owner");
  expect(api.deleteObject).toHaveBeenCalledWith({
    id: "vault-object",
    versionCheck: "vault-version-1",
  });
  api.readObjectByName.mockRejectedValueOnce(new Error("synthetic-password"));
  await expect(deleteProxySecret("owner")).rejects.toThrow(
    "could not be removed",
  );
});
