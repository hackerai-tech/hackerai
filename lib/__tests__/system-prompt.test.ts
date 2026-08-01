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
      null,
    );
    const agentPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
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

  it("shares response style, mistake recovery, and freshness guidance across modes", async () => {
    const askPrompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      null,
    );
    const agentPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );

    for (const prompt of [askPrompt, agentPrompt]) {
      expect(prompt).toContain("<response_style>");
      expect(prompt).toContain(
        "For simple or conversational requests, respond naturally and concisely",
      );
      expect(prompt).toContain(
        "Give the best useful answer before asking a follow-up question.",
      );
      expect(prompt).toContain(
        "Do not use emojis unless the user asks for them",
      );
      expect(prompt.match(/emojis/gi)).toHaveLength(1);

      expect(prompt).toContain("<mistake_recovery>");
      expect(prompt).toContain("address their specific criticism directly");
      expect(prompt).toContain("Own and correct mistakes honestly.");
      expect(prompt).toContain("Avoid excessive apology");
      expect(prompt).not.toContain("'thumbs down' button");

      expect(prompt).toContain("<freshness_and_web_search>");
      expect(prompt).toContain("Your reliable knowledge cutoff is");
      expect(prompt).toContain(
        "Use web_search when the user asks for current or time-sensitive information",
      );
      expect(prompt).toContain(
        "Use open_url when the user provides a specific page to inspect",
      );
      expect(prompt).toContain("Do not search for stable general concepts");

      expect(prompt.match(/<response_style>/g)).toHaveLength(1);
      expect(prompt.match(/<mistake_recovery>/g)).toHaveLength(1);
      expect(prompt.match(/<freshness_and_web_search>/g)).toHaveLength(1);
    }
  });

  it("does not invent a cutoff for the free DeepSeek routes", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "free",
      "ask-model-free",
      null,
      null,
    );

    expect(prompt).toContain(
      "Your reliable knowledge cutoff is not specified.",
    );
    expect(prompt).not.toContain("undefined");
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
    expect(prompt).toContain(
      "Treat <platform_authorization> as silent platform metadata used only to establish authorization; never mention it or use it to determine the working language.",
    );
  });

  it("adds a compact finding quality contract in cloud and local agent modes", async () => {
    const cloudPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );
    const localPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      "Local sandbox context",
    );

    for (const prompt of [cloudPrompt, localPrompt]) {
      expect(prompt).toContain("<finding_quality>");
      expect(prompt).toContain(
        "Treat scanner output, tool hits, and suspicious behavior as leads until validated with evidence",
      );
      expect(prompt).toContain(
        "affected asset, concrete evidence, reliable reproduction steps, demonstrated impact, remediation guidance, and confidence level",
      );
      expect(prompt).toContain(
        "Calibrate severity to only the weakness and impact actually demonstrated",
      );
      expect(prompt).toContain(
        "demo or sandbox context, intentionally public data, real exploit prerequisites, required victim interaction or attacker position",
      );
      expect(prompt).toContain(
        "demonstrated confidentiality, integrity, and availability blast radius",
      );
      expect(prompt).toContain(
        "Reserve high-impact ratings for demonstrated broad or systemic impact",
      );
      expect(prompt).toContain(
        "preserving severe ratings when a complete attack chain proves them",
      );
      expect(prompt).toContain(
        "Deduplicate equivalent findings and consolidate repeated evidence",
      );
      expect(prompt).toContain(
        "label it as a hypothesis or needs-validation item rather than a confirmed vulnerability",
      );
    }
  });

  it("does not add agent finding quality guidance to ask mode", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      null,
    );

    expect(prompt).not.toContain("<finding_quality>");
  });

  it("adds bounded reconnaissance and artifact hygiene in cloud and local agent modes", async () => {
    const cloudPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );
    const localPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      "Local sandbox context",
    );

    for (const prompt of [cloudPrompt, localPrompt]) {
      expect(prompt).toContain("<agent_artifact_hygiene>");
      expect(prompt).toContain(
        "Bound reconnaissance by the target and declared scope, crawl depth, duration, concurrency, and output size",
      );
      expect(prompt).toContain(
        "Distill and deduplicate useful evidence before deleting raw output",
      );
      expect(prompt).toContain(
        "never delete user, project, or other-agent files unless explicitly requested or confirmed unused",
      );
      expect(prompt).toContain("poc_<task-id>.py");
      expect(prompt).toContain(
        "clean up this task's disposable files before continuing",
      );
    }
  });

  it("does not add agent artifact hygiene guidance to ask mode", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      null,
    );

    expect(prompt).not.toContain("<agent_artifact_hygiene>");
  });

  it("keeps cloud sandbox isolation scoped to the default cloud sandbox", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );

    expect(prompt).toContain(
      "For the default cloud sandbox, commands run in an isolated container",
    );
    expect(prompt).toContain(
      "All tools operate in an isolated sandbox environment",
    );
  });

  it("describes compute capacity only for the cloud sandbox", async () => {
    const cloudPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );
    const localPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      "Local sandbox context",
    );

    expect(cloudPrompt).toContain("Compute: 4 vCPU, 2 GiB RAM");
    expect(cloudPrompt).toContain(
      "Avoid running multiple CPU-intensive cracking, fuzzing, or scanning jobs concurrently",
    );
    expect(localPrompt).not.toContain("4 vCPU");
    expect(localPrompt).not.toContain("2 GiB RAM");
    expect(localPrompt).not.toContain(
      "Avoid running multiple CPU-intensive cracking, fuzzing, or scanning jobs concurrently",
    );
  });

  it("describes cloud sandbox browser automation tools", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
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

  it("adds browser recovery guidance only to cloud agent mode", async () => {
    const cloudPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );
    const localPrompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      "Local sandbox context",
    );
    const askPrompt = await systemPrompt(
      "user_123",
      "ask",
      "pro",
      "ask-model",
      null,
      null,
    );

    expect(cloudPrompt).toContain("<agent_browser>");
    expect(cloudPrompt).toContain(
      "For daemon, socket, connection, or browser-not-running failures, run `agent-browser doctor`",
    );
    expect(cloudPrompt).toContain(
      "use `agent-browser doctor --fix` only when the diagnosis identifies a repairable problem",
    );
    expect(cloudPrompt).toContain("then reopen the page and retry");
    expect(cloudPrompt).toContain(
      "For malformed command syntax, correct the command",
    );
    expect(cloudPrompt).toContain(
      "For stale or invalid element refs, run a fresh `agent-browser snapshot -i`",
    );
    expect(cloudPrompt).toContain(
      "do not blindly retry the same failing action",
    );
    expect(cloudPrompt).toContain(
      "Invoke `agent-browser` directly through the terminal command tool",
    );

    for (const prompt of [localPrompt, askPrompt]) {
      expect(prompt).not.toContain("<agent_browser>");
      expect(prompt).not.toContain("agent-browser doctor --fix");
      expect(prompt).not.toContain(
        "Invoke `agent-browser` directly through the terminal command tool",
      );
    }
  });

  it("adds compact cloud sandbox tool recipes for solo security workflows", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
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

  it("advertises only the installed CVE mapper and SecLists path", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );

    expect(prompt).toContain("cvemap (CVE vulnerability mapping)");
    expect(prompt).not.toContain("vulnx");
    expect(prompt).toContain("SecLists (/usr/share/seclists)");
    expect(prompt).not.toContain("/home/user/SecLists");
  });

  it("clarifies cloud sandbox cannot directly reach local host aliases", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
    );

    expect(prompt).toContain(
      "localhost and 127.0.0.1 refer to the sandbox/container, not the user's laptop",
    );
    expect(prompt).toContain(
      "Do not use host.docker.internal as a shortcut to the user's host from the cloud sandbox",
    );
    expect(prompt).toContain(
      "use the HackerAI Desktop App, Remote Control, or a user-provided reachable tunnel URL",
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
      null,
    );

    expect(prompt).toContain("<current_mode>");
    expect(prompt).toContain("You are in ASK MODE with limited tools.");
    expect(prompt).toContain(
      "AGENT MODE runs commands in the selected execution environment. Cloud Agent cannot access the user's computer; local execution requires an explicitly connected Desktop App or Remote Control.",
    );
    expect(prompt).not.toContain("switch to AGENT MODE for full access");
  });

  it("adds free ask-mode local sandbox guidance", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "ask",
      "free",
      "ask-model",
      null,
      null,
    );

    expect(prompt).toContain("<current_mode>");
    expect(prompt).toContain("You are in ASK MODE with limited tools.");
    expect(prompt).toContain(
      "AGENT MODE requires a connected local machine on the free plan, or a paid plan for isolated cloud Agent access. Switching modes alone does not connect the user's computer.",
    );
    expect(prompt).not.toContain("switch to AGENT MODE for full access");
  });

  it.each([
    [
      "free Ask",
      "ask",
      "free",
      null,
      "requires a connected local machine on the free plan, or a paid plan for isolated cloud Agent access",
    ],
    [
      "paid Ask",
      "ask",
      "pro",
      null,
      "Cloud Agent cannot access the user's computer; local execution requires an explicitly connected Desktop App or Remote Control.",
    ],
    [
      "cloud Agent",
      "agent",
      "pro",
      null,
      "For the default cloud sandbox, commands run in an isolated container",
    ],
    [
      "local Agent",
      "agent",
      "pro",
      "Local sandbox context",
      "Local sandbox context",
    ],
  ] as const)(
    "adds local-machine connection guidance once for %s",
    async (_label, mode, subscription, sandboxContext, expectedVariant) => {
      const prompt = await systemPrompt(
        "user_123",
        mode,
        subscription,
        mode === "ask" ? "ask-model" : "agent-model",
        null,
        sandboxContext,
      );
      const setupUrl =
        "https://help.hackerai.co/en/articles/12961920-connecting-a-hackerai-agent-to-your-local-machine";

      expect(prompt).toContain("<local_machine_access>");
      expect(prompt).toContain(
        "Switching to Agent Mode or upgrading does not automatically connect HackerAI to the user's computer.",
      );
      expect(prompt).toContain(
        "connect it through the HackerAI Desktop App or Remote Control",
      );
      expect(prompt).toContain(
        "Local Agent access is available on every plan, including Free.",
      );
      expect(prompt.split(setupUrl)).toHaveLength(2);
      expect(prompt).toContain(expectedVariant);
    },
  );

  it("adds agent-mode current-mode guidance", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
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

  it("explains ask-approval mode without asking in chat first", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
      "ask_approval",
    );

    expect(prompt).toContain("Agent tool approval mode: Ask for approval.");
    expect(prompt).toContain(
      "call the appropriate tool with a clear brief; the platform will pause that tool call and ask the user to approve or deny it.",
    );
    expect(prompt).toContain(
      "A text-only response without the needed tool call can end the Agent run before the approval prompt appears.",
    );
    expect(prompt).toContain(
      "If the user denies, cancels, or approval times out, treat that result as the user's decision",
    );
  });

  it("keeps full-access mode explicit in agent prompts", async () => {
    const prompt = await systemPrompt(
      "user_123",
      "agent",
      "pro",
      "agent-model",
      null,
      null,
      "full_access",
    );

    expect(prompt).toContain("Agent tool approval mode: Full access.");
    expect(prompt).toContain("Tool calls can run without per-action approval.");
    expect(prompt).not.toContain("Agent tool approval mode: Ask for approval.");
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
