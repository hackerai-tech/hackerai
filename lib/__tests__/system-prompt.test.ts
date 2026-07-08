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
    expect(prompt).not.toContain(
      "agent-browser is installed in the cloud sandbox",
    );
  });

  it("treats user-provided targets as active authorized scope", async () => {
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
      "provided by the user in the current conversation are the active user-declared scope",
    );
    expect(prompt).toContain(
      "Treat those targets as authorized for the task without asking the user to restate permission",
    );
    expect(prompt).toContain(
      "authorized security validation, reproduction, confirmation, assessment, and remediation",
    );
    expect(prompt).toContain(
      "Do NOT ask for proof of authorization for a user-declared target",
    );
    expect(prompt).toContain(
      "before expanding materially to unrelated third-party assets",
    );
  });

  it("adds a compact finding quality contract for agent security work", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("<finding_quality>");
    expect(prompt).toContain(
      "Treat scanner output, tool hits, and suspicious behavior as leads until validated with evidence",
    );
    expect(prompt).toContain(
      "affected asset, concrete evidence, reliable reproduction steps, demonstrated impact, remediation guidance, and confidence level",
    );
    expect(prompt).toContain(
      "Deduplicate equivalent findings and consolidate repeated evidence",
    );
    expect(prompt).toContain(
      "label it as a hypothesis or needs-validation item rather than a confirmed vulnerability",
    );
  });

  it("does not add agent finding quality guidance to ask mode", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      false,
      null,
    );

    expect(prompt).not.toContain("<finding_quality>");
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
    expect(prompt).toContain("Inline image attachments are already visible");
    expect(prompt).toContain("do not call the file view action");
  });

  it("adds compact cloud sandbox tool recipes for solo security workflows", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("<sandbox_tool_recipes>");
    expect(prompt).toContain("interactsh-client: use for blind callback proof");
    expect(prompt).toContain("blind SSRF, XXE, blind XSS");
    expect(prompt).toContain("jwt-tool (jwt_tool): use for JWT decoding");
    expect(prompt).toContain("arjun: use after endpoints are known");
    expect(prompt).toContain(
      "dirsearch: use for scoped directory/file discovery",
    );
    expect(prompt).toContain("wafw00f: use early to fingerprint WAF/CDN");
    expect(prompt).toContain("cvemap: use after identifying product names");
    expect(prompt).toContain("Browser screenshot flow: use agent-browser");
  });

  it("clarifies cloud sandbox cannot directly reach local host aliases", async () => {
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
      "localhost and 127.0.0.1 refer to the sandbox/container, not the user's laptop",
    );
    expect(prompt).toContain(
      "Do not use host.docker.internal as a shortcut to the user's host from the cloud sandbox",
    );
    expect(prompt).toContain(
      "use the HackerAI Desktop App, Remote Connection, or a user-provided reachable tunnel URL",
    );
    expect(prompt).toContain(
      "Do not invent host aliases or imply the cloud sandbox can directly reach private/internal assets",
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
    expect(prompt).not.toContain("<sandbox_tool_recipes>");
    expect(prompt).not.toContain("interactsh-client: use for blind callback");
  });

  it("adds paid ask-mode current-mode guidance", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("<current_mode>");
    expect(prompt).toContain("You are in ASK MODE with limited tools.");
    expect(prompt).toContain(
      "inform them to switch to AGENT MODE for full access including file operations, terminal commands, and code execution.",
    );
  });

  it("adds free ask-mode local sandbox guidance", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "free",
      "ask-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("<current_mode>");
    expect(prompt).toContain("You are in ASK MODE with limited tools.");
    expect(prompt).toContain(
      "AGENT MODE requires a connected local sandbox on the free plan, or Pro for cloud Agent access.",
    );
    expect(prompt).not.toContain(
      "inform them to switch to AGENT MODE for full access",
    );
  });

  it("adds agent-mode current-mode guidance", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      false,
      null,
    );

    expect(prompt).toContain("<current_mode>");
    expect(prompt).toContain("You are in AGENT MODE.");
    expect(prompt).toContain(
      "Use the available tools to read files, edit code, run terminal commands, and execute code when useful.",
    );
    expect(prompt).toContain("Do not tell the user to switch to Agent mode.");
    expect(prompt).not.toContain("You are in ASK MODE");
  });

  it("does not claim cloud-only recipes or browser tools are installed on local hosts", async () => {
    const localHostContext = `You are executing commands on Linux 6.8 (x64) in DANGEROUS MODE.
Commands run directly on the host OS "labbox" without Docker isolation.`;

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
    expect(prompt).not.toContain("<sandbox_tool_recipes>");
    expect(prompt).not.toContain("interactsh-client: use for blind callback");
    expect(prompt).not.toContain(
      "agent-browser is installed in the cloud sandbox",
    );
  });
});
