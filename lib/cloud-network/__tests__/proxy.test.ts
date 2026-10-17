import { normalizeProxyInput } from "../proxy";
import { cloudNetworkPrompt, CLOUD_NETWORK_PROMPT_TOKENS } from "../prompt";
import { safeCountTokens } from "@/lib/token-utils";

it("normalizes SOCKS5 endpoints without interpreting embedded credentials", () => {
  expect(
    normalizeProxyInput({
      address: " Proxy.Example.Test:01080 ",
      credentials: null,
    }),
  ).toEqual({ address: "proxy.example.test:1080", credentials: null });
  expect(normalizeProxyInput({ address: "192.0.2.10:1080" }).address).toBe(
    "192.0.2.10:1080",
  );
});
it.each([
  "https://proxy.test:1080",
  "user:secret@proxy.test:1080",
  "proxy.test:0",
  "proxy.test:65536",
  "proxy.test:1080/path",
  "proxy.test:1080\nextra",
  "127.1:1080",
  "999.1.1.1:1080",
])("rejects an ambiguous endpoint without echoing it: %s", (address) => {
  expect(() => normalizeProxyInput({ address })).toThrow();
  try {
    normalizeProxyInput({ address });
  } catch (error) {
    expect(String(error)).not.toContain(address);
  }
});
it("bounds credential bytes and rejects unknown secret fields", () => {
  expect(() =>
    normalizeProxyInput({
      address: "proxy.test:1080",
      credentials: { username: "é".repeat(128), password: "" },
    }),
  ).toThrow();
  expect(() =>
    normalizeProxyInput({
      address: "proxy.test:1080",
      credentials: { username: "", password: "secret" },
    }),
  ).toThrow();
  expect(() =>
    normalizeProxyInput({
      address: "proxy.test:1080",
      secretId: "someone-else",
    }),
  ).toThrow();
});
it.each(["ready", "failed", "applying"] as const)(
  "keeps proxy context secret-free and within the existing token budget when %s",
  (status) => {
    const prompt = cloudNetworkPrompt({
      policy: {
        mode: "restricted",
        allow: Array.from(
          { length: 100 },
          (_, i) => `${"long".repeat(12)}${i}.example.test`,
        ),
      },
      revision: 2,
      status,
      proxy: {
        address: "private-proxy.example.test:1080",
        authenticated: true,
        revision: "secret-version",
      },
    });
    expect(prompt).toContain("SOCKS5");
    expect(prompt).not.toContain("private-proxy");
    expect(prompt).not.toContain("secret-version");
    expect(safeCountTokens(prompt)).toBeLessThanOrEqual(
      CLOUD_NETWORK_PROMPT_TOKENS,
    );
  },
);
