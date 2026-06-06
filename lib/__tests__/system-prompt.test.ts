import { describe, expect, it } from "@jest/globals";
import { systemPrompt } from "@/lib/system-prompt";

describe("systemPrompt security instructions", () => {
  it("answers general questions directly without cybersecurity scope disclaimers", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain(
      "Answer general questions, everyday tech support, education, writing, and factual requests directly in the user's language.",
    );
    expect(prompt).toContain("Do not say the request is outside cybersecurity");
    expect(prompt).toContain(
      'do not start with "as an AI penetration testing assistant."',
    );
  });

  it("applies the working-language instruction in ask and agent modes", async () => {
    const askPrompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      false,
      null,
    );
    const agentPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    for (const prompt of [askPrompt, agentPrompt]) {
      expect(prompt).toContain("<language>");
      expect(prompt).toContain(
        "Use the language of the user's first message as the working language.",
      );
      expect(prompt.match(/<language>/g)).toHaveLength(1);
    }
  });

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
});
