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

  it("includes curated pentest playbooks in agent mode", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("<curated_pentest_playbook>");
    expect(prompt).toContain("agent-browser open <url>");
    expect(prompt).toContain("httpx -l hosts.txt");
    expect(prompt).toContain("-noninteractive");
    expect(prompt).toContain("JWT/OIDC");
    expect(prompt).toContain("IDOR/BOLA");
    expect(prompt).toContain("SSRF");
    expect(prompt).toContain("XXE");
  });

  it("keeps terminal-only pentest playbooks out of ask mode", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      false,
      null,
    );

    expect(prompt).not.toContain("<curated_pentest_playbook>");
    expect(prompt).not.toContain("agent-browser open <url>");
  });
});
