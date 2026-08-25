import {
  detectCloudScanCommand,
  enforceCloudScanSafety,
  updateTerminalScanSafetyInput,
} from "../cloud-scan-safety";

describe("Cloud scan safety", () => {
  it.each([
    ["cd /tmp && masscan 203.0.113.0/24 -p-", "masscan"],
    ["cat targets.txt | zmap -p 443", "zmap"],
    ["RATE=1000 nmap -p- 203.0.113.10", "nmap"],
    ["nmap -sV 203.0.113.0/24", "nmap"],
    ["nmap -p 1-1001 203.0.113.10", "nmap"],
    ["nmap --top-ports=1001 203.0.113.10", "nmap"],
    ["nmap -sV 203.0.113.10 203.0.113.11", "nmap"],
    ["nmap -iL targets.txt", "nmap"],
    ["time nmap -p- 203.0.113.10", "nmap"],
    [`"nmap" -p- 203.0.113.10`, "nmap"],
    [String.raw`n\map -p- 203.0.113.10`, "nmap"],
    ["xargs nmap -p- < targets.txt", "nmap"],
    ["nmap -p 80 203.0.113.{1..254}", "nmap"],
    ["nmap -p 80 hosts?", "nmap"],
    ["naabu -list targets.txt", "naabu"],
    ["naabu -host 203.0.113.10 -p 1-1001", "naabu"],
    [`bash -lc 'nmap -p- 203.0.113.10'`, "nmap"],
    [`bash -c "nmap -p- 203.0.113.10" sentinel`, "nmap"],
    ["bash -c nmap -p- 203.0.113.10", "nmap"],
    [`eval "nmap -p- 203.0.113.10"`, "nmap"],
    ["nuclei --list targets.txt", "bulk_http_probe"],
    ["nuclei -list targets.txt", "bulk_http_probe"],
    ["httpx -l targets.txt", "bulk_http_probe"],
    ["httpx -list targets.txt", "bulk_http_probe"],
    ["cat targets.txt | nuclei", "bulk_http_probe"],
    ["cat targets.txt | httpx", "bulk_http_probe"],
    ["httpx -u https://one.example -u https://two.example", "bulk_http_probe"],
    ["nuclei -target 203.0.113.0/24", "bulk_http_probe"],
    ["httpx -u 'https://site{1..10}.example'", "bulk_http_probe"],
  ])("detects broad or high-throughput command %s", (command, scanner) => {
    expect(detectCloudScanCommand(command)).toMatchObject({ scanner });
  });

  it.each([
    "curl https://example.com/api",
    "python3 -m pytest",
    "echo nmap",
    "command -v nmap",
    "nmap --version",
    "printf 'use naabu on Desktop'",
    "nuclei -u https://example.com",
    "httpx -u https://example.com",
    "httpx --version",
    "httpx",
    "nuclei",
    "sudo apt install nmap",
    "sudo apt install httpx",
    "nmap -sV 203.0.113.10",
    "nmap -p 1-1000 203.0.113.10",
    "nmap -p 22,80,443 example.com",
    "nmap -sV 203.0.113.10/32",
    "naabu -host 203.0.113.10",
    "naabu --host=example.com --ports=80,443",
    "nmap --script-timeout 10s -p 80 example.com",
    "bash -lc 'nmap -sV 203.0.113.10'",
    "cat > notes.txt <<'EOF'\nnmap -p- 203.0.113.10\nEOF",
  ])("allows non-fan-out command %s", (command) => {
    expect(detectCloudScanCommand(command)).toBeNull();
  });

  it("terminates only an AWS Cloud MicroVM and does not log its target", async () => {
    const resetSandbox = jest.fn(async () => undefined);
    const terminate = jest.fn(async () => ({
      status: "terminated" as const,
    }));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const target = "203.0.113.77";
    const result = await enforceCloudScanSafety({
      command: `nmap -p- ${target}`,
      sandbox: {
        sandboxKind: "centrifugo",
        getCloudProvider: () => "aws-lambda-microvm",
        getConnectionId: () => "microvm-owned",
      } as never,
      context: {
        chatId: "chat-1",
        sandboxManager: { resetSandbox } as never,
        subscription: "pro",
        triggerRunId: "run-1",
        userID: "user-1",
      },
      toolCallId: "tool-1",
      source: "terminal_exec",
      dependencies: { terminate },
    });

    expect(result).toMatchObject({
      blocked: true,
      microvmId: "microvm-owned",
      scanner: "nmap",
      terminationStatus: "terminated",
    });
    expect(terminate).toHaveBeenCalledWith({
      userId: "user-1",
      microvmId: "microvm-owned",
      scanner: "nmap",
    });
    expect(resetSandbox).toHaveBeenCalledWith("cloud_scan_safety_guard");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(target);
    warn.mockRestore();
  });

  it("does not apply the guard to Desktop or Remote sandboxes", async () => {
    const terminate = jest.fn();
    const result = await enforceCloudScanSafety({
      command: "nmap -sV 203.0.113.77",
      sandbox: {
        sandboxKind: "centrifugo",
        getCloudProvider: () => null,
        getConnectionId: () => "desktop-1",
      } as never,
      context: {
        chatId: "chat-1",
        sandboxManager: {} as never,
        userID: "user-1",
      },
      toolCallId: "tool-1",
      source: "terminal_exec",
      dependencies: { terminate },
    });

    expect(result).toEqual({ blocked: false });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("retains an unsubmitted PTY line so split sends cannot bypass detection", () => {
    const first = updateTerminalScanSafetyInput("", "nm");
    expect(detectCloudScanCommand(first.inspection)).toBeNull();

    const second = updateTerminalScanSafetyInput(
      first.currentLine,
      "ap -p- 203.0.113.10\r",
    );
    expect(detectCloudScanCommand(second.inspection)).toMatchObject({
      scanner: "nmap",
    });
    expect(second.currentLine).toBe("");
  });

  it("models terminal cancellation and editing without retaining stale input", () => {
    expect(updateTerminalScanSafetyInput("nmap -p-", "\u0003")).toEqual({
      inspection: "",
      currentLine: "",
    });
    expect(updateTerminalScanSafetyInput("nma", "\bap host")).toEqual({
      inspection: "nmap host",
      currentLine: "nmap host",
    });
  });
});
