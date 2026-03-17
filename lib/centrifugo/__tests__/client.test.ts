import { publishCommand } from "../client";

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("publishCommand", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CENTRIFUGO_API_URL: "http://centrifugo:8000",
      CENTRIFUGO_API_KEY: "test-api-key",
    };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when CENTRIFUGO_API_URL is missing", async () => {
    delete process.env.CENTRIFUGO_API_URL;

    await expect(
      publishCommand("channel", {
        type: "command",
        commandId: "1",
        command: "echo",
      }),
    ).rejects.toThrow("CENTRIFUGO_API_URL environment variable is not set");
  });

  it("throws when CENTRIFUGO_API_KEY is missing", async () => {
    delete process.env.CENTRIFUGO_API_KEY;

    await expect(
      publishCommand("channel", {
        type: "command",
        commandId: "1",
        command: "echo",
      }),
    ).rejects.toThrow("CENTRIFUGO_API_KEY environment variable is not set");
  });

  it("throws on non-OK HTTP response with status code in error message", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    await expect(
      publishCommand("ch", {
        type: "command",
        commandId: "1",
        command: "echo",
      }),
    ).rejects.toThrow("503");
  });

  it("throws on Centrifugo API-level error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { code: 100, message: "namespace not found" },
      }),
    });

    await expect(
      publishCommand("ch", {
        type: "command",
        commandId: "1",
        command: "echo",
      }),
    ).rejects.toThrow("namespace not found");
  });

  it("does not throw on successful publish", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await expect(
      publishCommand("ch", {
        type: "command",
        commandId: "1",
        command: "echo",
      }),
    ).resolves.toBeUndefined();
  });

  it("sends correct request shape: POST to /api/publish with proper headers and body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const data = {
      type: "command" as const,
      commandId: "cmd-1",
      command: "ls -la",
    };
    await publishCommand("sandbox:user#abc", data);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];

    expect(url).toBe("http://centrifugo:8000/api/publish");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "apikey test-api-key",
    });

    const body = JSON.parse(options.body);
    expect(body).toEqual({
      channel: "sandbox:user#abc",
      data,
    });
  });
});
