import {
  MAX_NARROW_NMAP_PORTS,
  classifyCloudPortScan,
} from "../cloud-port-scan-guard";

describe("classifyCloudPortScan", () => {
  test.each([
    ["nmap example.com", { scanner: "nmap", scanKind: "raw" }],
    ["nmap -sT example.com", { scanner: "nmap", scanKind: "broad_tcp" }],
    ["sudo nmap -sS -p 443 example.com", { scanner: "nmap", scanKind: "raw" }],
    ["nmap -sU -p 53 example.com", { scanner: "nmap", scanKind: "udp" }],
    ["nmap -sT -p- example.com", { scanner: "nmap", scanKind: "broad_tcp" }],
    [
      `timeout 30s nmap -sT --top-ports ${MAX_NARROW_NMAP_PORTS + 1} example.com`,
      { scanner: "nmap", scanKind: "broad_tcp" },
    ],
    ["naabu -host example.com", { scanner: "naabu", scanKind: "broad_tcp" }],
    ["masscan 192.0.2.0/24 -p0-65535", { scanner: "masscan", scanKind: "raw" }],
    [
      "nc -zv example.com 1-1000",
      { scanner: "netcat", scanKind: "zero_io_connect" },
    ],
    [
      "curl example.com | env FOO=bar naabu -silent",
      { scanner: "naabu", scanKind: "broad_tcp" },
    ],
    [
      "bash -lc 'nmap -sT -p 1-1000 example.com'",
      { scanner: "nmap", scanKind: "broad_tcp" },
    ],
    [
      "busybox nc -zv example.com 1-1000",
      { scanner: "netcat", scanKind: "zero_io_connect" },
    ],
    [
      "nmap -sT --privileged example.com",
      { scanner: "nmap", scanKind: "broad_tcp" },
    ],
    ["nmap -sT -p 443 -A example.com", { scanner: "nmap", scanKind: "raw" }],
  ])("classifies blocked scan command %s", (command, expected) => {
    expect(classifyCloudPortScan(command)).toEqual(expected);
  });

  test.each([
    "curl -I https://example.com",
    "openssl s_client -connect example.com:443",
    "ssh -o BatchMode=yes example.com",
    "nc example.com 443",
    "nmap -sT -sV -p 22,80,443 example.com",
    `nmap -sT --top-ports ${MAX_NARROW_NMAP_PORTS} example.com`,
    "nmap -sT --top-ports=3 example.com",
    "nmap -sL 192.0.2.0/24",
    "echo 'nmap -sS -p- example.com'",
    "printf '%s\\n' 'nc -zv example.com 1-1000'",
    "# nmap -sS -p- example.com\ncurl https://example.com",
  ])("allows non-scan or narrow application command %s", (command) => {
    expect(classifyCloudPortScan(command)).toBeNull();
  });
});
