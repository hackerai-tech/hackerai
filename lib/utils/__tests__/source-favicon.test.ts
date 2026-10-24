import { sourceFaviconUrl } from "../source-favicon";

describe("source favicon disclosure", () => {
  it.each([
    [
      "https://user:password@WWW.OWASP.ORG:8443/private?token=secret#finding",
      "www.owasp.org",
    ],
    ["http://example.com./report", "example.com"],
    ["https://bücher.de/", "xn--bcher-kva.de"],
    ["https://internal-tools.com/", "internal-tools.com"],
  ])("sends only the normalized hostname of %s", (input, host) => {
    const icon = new URL(sourceFaviconUrl(input)!);
    expect(icon.origin).toBe("https://www.google.com");
    expect(icon.pathname).toBe("/s2/favicons");
    expect([...icon.searchParams.entries()]).toEqual([
      ["domain", host],
      ["sz", "32"],
    ]);
    expect(icon.hash).toBe("");
  });

  it.each([
    "",
    "not-a-url?token=secret",
    "//example.com/report",
    "/relative",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/file",
    "https://localhost/",
    "http://localhost./",
    "https://printer/",
    "https://host.local/",
    "https://host.localdomain/",
    "https://home.arpa/",
    "https://host.home.arpa/",
    "https://node.tailnet.ts.net/",
    "https://service.internal/",
    "https://service.lan/",
    "https://service.onion/",
    "https://service.test/",
    "https://service.invalid/",
    "https://service.example/",
    "https://service.private/",
    "https://service.home/",
    "https://service.alt/",
    "https://service.corp/",
    "https://service.intranet/",
    "https://grafana.internal.example.com/",
    "https://corp.example.com/",
    "https://INTRANET.example.com./",
    "http://10.0.0.1/",
    "http://172.16.1.2/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://8.8.8.8/",
    "http://[2606:4700:4700::1111]/",
    "https://example.com../",
    "https://bad_host.com/",
    "https://-bad.com/",
    "https://bad-.com/",
    "https://a..com/",
    `https://${"a".repeat(64)}.com/`,
    `https://${Array(5).fill("a".repeat(60)).join(".")}/`,
  ])("uses a local icon without disclosing %s", (input) => {
    expect(sourceFaviconUrl(input)).toBeNull();
  });
});
