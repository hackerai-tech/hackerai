import { describe, expect, it } from "@jest/globals";
import { systemPrompt } from "@/lib/system-prompt";

describe("systemPrompt security instructions", () => {
  it("does not claim isolated container execution for dangerous local hosts", async () => {
    const localHostContext = `You are executing commands on macOS 15.0 (arm64) in DANGEROUS MODE.
Commands are invoked via /bin/bash -c.
Commands run directly on the host OS "workstation" without Docker isolation. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)`;

    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      localHostContext,
    );

    expect(prompt).toContain(localHostContext);
    expect(prompt).toContain("terminal commands can affect the user's host OS");
    expect(prompt).toContain(
      "request confirmation before executing destructive, irreversible, credential-exfiltrating, persistence-affecting, or broad host-impacting commands",
    );
    expect(prompt).not.toContain(
      "All operations execute in isolated sandbox containers",
    );
  });

  it("keeps cloud sandbox isolation scoped to the default cloud sandbox", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain(
      "For the default cloud sandbox, commands run in an isolated container",
    );
    expect(prompt).toContain(
      "All tools operate in an isolated sandbox environment",
    );
  });

  it("describes cloud sandbox browser automation tools", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("whois");
    expect(prompt).toContain("Chromium and agent-browser");
    expect(prompt).toContain("agent-browser snapshot -i");
    expect(prompt).toContain("agent-browser set viewport 1920 1080");
    expect(prompt).toContain("/home/user/agent-browser-screenshots");
    expect(prompt).toContain("file tool's view action");
  });

  it("does not describe a command sandbox in ask mode", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("This chat has no terminal command environment.");
    expect(prompt).not.toContain(
      "For the default cloud sandbox, commands run in an isolated container",
    );
  });
});
