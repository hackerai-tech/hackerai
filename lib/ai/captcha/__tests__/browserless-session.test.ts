import { EventEmitter } from "node:events";
import { openBrowserlessFallback } from "../browserless-session";

const mockSockets: MockSocket[] = [];
class MockSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  send = jest.fn((_message: string) => {
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit("close");
    });
  });
  terminate = jest.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  constructor(
    readonly address: URL,
    readonly options: unknown,
  ) {
    super();
    mockSockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }
}
jest.mock("ws", () => ({
  __esModule: true,
  get default() {
    return MockSocket;
  },
}));
const originalFetch = global.fetch;
const fetchMock = jest.fn();
const key = "a".repeat(32);
const url = "https://www.google.com/recaptcha/api2/demo";
beforeEach(() => {
  mockSockets.length = 0;
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        solve: { found: true, solved: true },
        reconnect: {
          browserWSEndpoint: `wss://production-sfo.browserless.io/reconnect/private-session?token=${key}`,
        },
      },
    }),
  });
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
});

it("uses header authentication, strips reconnect credentials, and closes the hosted browser", async () => {
  const result = await openBrowserlessFallback(
    url,
    key,
    new AbortController().signal,
  );
  const [endpoint, options] = fetchMock.mock.calls[0];
  expect(endpoint.toString()).not.toContain(key);
  expect(options.body).not.toContain(key);
  expect(options.headers.Authorization).toBe(`Bearer ${key}`);
  expect(options.redirect).toBe("error");
  expect(mockSockets[0].address.searchParams.has("token")).toBe(false);
  expect(mockSockets[0].options).toMatchObject({
    headers: { Authorization: `Bearer ${key}` },
  });
  await result.close();
  await result.close();
  expect(mockSockets[0].send).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(mockSockets[0].send.mock.calls[0][0] as string).method,
  ).toBe("Browser.close");
});

it.each([
  "wss://attacker.test/",
  "ws://production-sfo.browserless.io/",
  "wss://production-sfo.browserless.io.attacker.test/",
  "wss://user@production-sfo.browserless.io/",
])(
  "rejects an untrusted reconnect endpoint without sending credentials (%s)",
  async (address) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          solve: { found: true, solved: true },
          reconnect: { browserWSEndpoint: address },
        },
      }),
    });
    await expect(
      openBrowserlessFallback(url, key, new AbortController().signal),
    ).rejects.toThrow("do not retry");
    expect(mockSockets).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("closes allocated sessions after unsuccessful solving and redacts provider failures", async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: {
        solve: { found: true, solved: false },
        reconnect: {
          browserWSEndpoint: `wss://production-sfo.browserless.io/reconnect?token=${key}`,
        },
      },
      errors: [{ message: key }],
    }),
  });
  await expect(
    openBrowserlessFallback(url, key, new AbortController().signal),
  ).rejects.toThrow("Browserless fallback failed; do not retry this run.");
  expect(mockSockets[0].send).toHaveBeenCalledTimes(1);
  fetchMock.mockRejectedValueOnce(new Error(key));
  await expect(
    openBrowserlessFallback(url, key, new AbortController().signal),
  ).rejects.not.toThrow(key);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("cancels an adopted session without a second provider allocation", async () => {
  const controller = new AbortController();
  const session = await openBrowserlessFallback(url, key, controller.signal);
  controller.abort();
  await session.close();
  expect(mockSockets[0].send).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
