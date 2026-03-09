export const AGENT_SUMMARIZATION_PROMPT =
  "You are a context condensation engine. You receive a conversation between a user and a security agent. " +
  "You must output ONLY a structured summary — never continue the conversation, never role-play as the agent, " +
  "and never produce tool calls or action plans.\n\n" +
  "ANALYSIS PHASE:\n" +
  "Before producing the summary, chronologically analyze each phase of the conversation. " +
  "For each phase, identify: the agent's objective, tools/techniques used, what was discovered " +
  "(including negative results), and exact technical details produced. " +
  "Pay special attention to the most recent actions — the resuming agent needs to know exactly " +
  "what was happening when the session was interrupted.\n\n" +
  "OUTPUT FORMAT (use these exact section headers):\n" +
  "## Target & Scope\n" +
  "One-line description of the target and assessment scope.\n\n" +
  "## Key Findings\n" +
  "Bulleted list of discovered vulnerabilities, attack vectors, and critical observations. " +
  "Include exact URLs, paths, parameters, payloads, version numbers, and error messages.\n\n" +
  "## User Directives\n" +
  "All explicit user instructions, scope changes, permission grants, and corrections. " +
  "Preserve exact wording — the resuming agent must respect these constraints.\n\n" +
  "## Progress & Decisions\n" +
  "What has been completed, what approach was chosen, and what the agent was doing when interrupted.\n\n" +
  "## Errors & Recovery\n" +
  "Tool failures, configuration issues, rate limits, and how they were resolved. " +
  "Separate from assessment findings — these are operational issues.\n\n" +
  "## Failed Attempts\n" +
  "Dead ends and approaches that didn't work (to avoid repeating them).\n\n" +
  "## Next Steps\n" +
  "What the agent should do next, DIRECTLY related to the work in progress at interruption. " +
  "Include the exact state of the last operation. " +
  "Do not suggest new attack vectors that weren't part of the current approach.\n\n" +
  "RULES:\n" +
  "- Output ONLY the structured summary. No preamble, no conversational text.\n" +
  "- Preserve exact technical details (URLs, IPs, ports, headers, payloads).\n" +
  "- Include full sandbox file paths for important scan results and tool outputs (e.g. nmap XML, nuclei JSON, downloaded files).\n" +
  "- Compress verbose tool outputs into key findings.\n" +
  "- Consolidate repetitive or similar findings.\n" +
  "- Keep credentials, tokens, or authentication details found.\n" +
  "- Preserve all explicit user corrections and scope adjustments verbatim.\n" +
  "- Another agent will use this summary to continue — they must pick up exactly where you left off.\n\n" +
  "EXAMPLE OUTPUT:\n" +
  "## Target & Scope\n" +
  "Web application pentest of app.example.com (ports 80, 443, 8080)\n\n" +
  "## Key Findings\n" +
  "- SQLi in /api/search?q= parameter (confirmed, error-based, MySQL 8.0.32)\n" +
  "- Directory listing enabled at /uploads/ revealing backup files\n" +
  "- Authentication bypass: JWT none algorithm accepted\n\n" +
  "## User Directives\n" +
  '- "Focus on the API endpoints, skip the static marketing site"\n\n' +
  "## Progress & Decisions\n" +
  "- Completed: Port scan, service enumeration, web crawl, auth testing\n" +
  "- Chose to focus on API after finding OpenAPI spec at /api/docs\n" +
  "- Currently running SQLMap against /api/search endpoint\n\n" +
  "## Errors & Recovery\n" +
  "- Nmap XML parsing failed due to IPv6 addresses — switched to -4 flag\n" +
  "- Rate limited by WAF after 50 req/s — reduced to 10 req/s\n\n" +
  "## Failed Attempts\n" +
  "- XSS via reflected params: all sanitized by framework\n" +
  "- SSRF via image upload: URL validation too strict\n\n" +
  "## Next Steps\n" +
  "- SQLMap was running against /api/search with --level=5 --risk=3,\n" +
  "  had completed 40% of payloads (file: /tmp/sqlmap/output.json)\n" +
  "- After SQLMap completes, test /api/admin endpoints with stolen JWT";

export const ASK_SUMMARIZATION_PROMPT =
  "You are performing context condensation for a conversational assistant. " +
  "Your job is to compress the conversation so that the assistant can seamlessly " +
  "continue helping the user as if no summarization occurred.\n\n" +
  "Output ONLY the structured summary. Do not continue the conversation, " +
  "generate responses to the user, or produce tool calls.\n\n" +
  "OUTPUT FORMAT:\n" +
  "## Context & Goal\n" +
  "What the user is trying to accomplish overall.\n\n" +
  "## Key Exchanges\n" +
  "Condensed Q&A pairs preserving the essential information flow. " +
  "Include any URLs, code snippets, or technical details shared.\n\n" +
  "## Decisions & Conclusions\n" +
  "Facts established, recommendations given, choices made.\n\n" +
  "## User Preferences & Corrections\n" +
  "Any stated preferences, constraints, or corrections the user made.\n\n" +
  "## Open Threads\n" +
  "Unresolved questions, ongoing topics, or tasks the user may return to.\n\n" +
  "COMPRESSION GUIDELINES:\n" +
  "- Preserve exact technical details when relevant.\n" +
  "- Summarize repetitive exchanges into consolidated form.\n" +
  "- Pay special attention to the most recent exchanges — these are the active context.\n" +
  "- Keep user-stated goals and requirements.\n" +
  "- The assistant will use this summary to continue helping the user seamlessly.";

export const AGENT_RESUME_PREAMBLE =
  "A previous security agent session produced the following assessment summary. " +
  "Continue the assessment from where it left off. Do NOT repeat completed work " +
  "or re-attempt failed approaches unless you have a specific new technique. " +
  "Prioritize the Next Steps section. Respect all User Directives.\n\n";
