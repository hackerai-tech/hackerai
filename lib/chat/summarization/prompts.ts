export const AGENT_SUMMARIZATION_PROMPT = `You are a context condensation engine for a penetration testing conversation. You receive a conversation between a user and a security assessment agent. You must output ONLY a structured summary — never continue the conversation, never role-play as the agent, and never produce tool calls or action plans.

Before writing the summary, analyze the conversation in <analysis> tags:
1. Chronologically go through each exchange identifying:
   - The user's explicit requests, scope changes, and priority shifts
   - The agent's actions and their outcomes
   - Key discoveries and exact technical details
   - Failed approaches and their specific failure reasons
2. Pay special attention to the most recent messages to accurately capture the current assessment state
3. Double-check that critical technical details (IPs, ports, URLs, payloads, credentials, file paths) are preserved exactly as they appeared

Then output the structured summary using these exact section headers:

## Engagement Scope & Objectives
What the user explicitly requested. Include target definition (domains, IPs, applications), assessment type (black-box, grey-box, specific focus areas), and any scope changes or priority shifts during the conversation. Capture the user's exact words for scope boundaries.

## Attack Surface & Technology Stack
Discovered infrastructure and technology details:
- Network topology (hosts, subnets, routing observed)
- Services and versions (web servers, databases, frameworks, CMS)
- Authentication mechanisms and session handling
- API endpoints and architectures
- Cloud/hosting/CDN details

## Key Findings & Vulnerabilities
Bulleted list of discovered vulnerabilities and critical observations. For each finding include:
- Vulnerability type and severity (with CVE IDs where applicable)
- Exact vulnerable URL/endpoint/parameter
- Proof-of-concept payload used and the confirming response
- Exploitation status (confirmed/suspected/partially-exploited)

## Credentials & Sensitive Data
Any credentials, tokens, API keys, session cookies, hashes, or sensitive information discovered. Include the exact values, where they were found, and whether they have been validated or used.

## Failed Attacks & Dead Ends
Approaches that did not work — critical for avoiding repetition. For each include:
- What was attempted and the exact payload/technique
- Why it failed (WAF/IDS detection, patched, misconfigured, incorrect assumption)
- Specific error messages or blocking responses received

## User Directives
All explicit user instructions, feedback, and scope modifications in chronological order:
- Initial engagement request and objectives
- Scope changes ("focus on X", "skip Y", "try Z instead")
- Priority shifts and methodology preferences
- Constraints or special instructions given
This section ensures the continuing agent respects every user directive without re-asking.

## Artifacts & File Paths
Full sandbox file paths for all important results: scan outputs (nmap XML, nuclei JSON), downloaded files, screenshots, captured traffic, exploit scripts. Include a brief description of each artifact's contents and relevance.

## Assessment Progress & Current State
Current phase (reconnaissance/enumeration/exploitation/post-exploitation/lateral-movement) and what has been completed. Describe exactly what the agent was doing when interrupted and the overall progression through the kill chain.

## Next Steps
What the agent should do next to continue the assessment, in priority order. Be specific — include exact targets, techniques to try, and why they are the next logical step based on findings so far.

RULES:
- Output the <analysis> block first, then the structured summary. No other preamble or conversational text.
- Preserve exact technical details verbatim (URLs, IPs, ports, headers, payloads, command flags, file paths).
- Never omit credentials, tokens, or authentication details found during the assessment.
- Compress verbose tool outputs (full nmap/nuclei output) into key findings while preserving actionable details.
- Consolidate repetitive or similar findings.
- Another agent will use this summary to continue the assessment — they must pick up exactly where you left off without context loss.`;

export const ASK_SUMMARIZATION_PROMPT = `You are performing context condensation for a security knowledge assistant. You receive a conversation between a user and an assistant about cybersecurity topics. Your job is to compress the conversation while preserving key information for continuity.

Before writing the summary, briefly analyze the conversation in <analysis> tags:
1. Identify all user questions and the key points of each answer
2. Note follow-up context that builds on earlier exchanges
3. Track unresolved questions or ongoing threads
4. Pay special attention to the most recent exchanges — the assistant must seamlessly continue from there

Then output the compressed summary preserving:

CRITICAL ELEMENTS TO PRESERVE:
- Every user question/request and the substance of each answer
- Key facts, decisions, and conclusions reached
- Exact technical details: URLs, IPs, commands, code snippets, CVE references, tool names
- User preferences, stated goals, and assessment context
- Unresolved questions or ongoing discussion threads
- Any scope or priority changes expressed by the user

COMPRESSION GUIDELINES:
- Preserve exact technical details when relevant
- Summarize repetitive exchanges into consolidated form
- Maintain the conversational flow and context
- Keep user-stated goals and requirements prominent
- Pay special attention to the most recent messages — the assistant must seamlessly continue from where the conversation left off

RULES:
- Output the <analysis> block first, then the compressed summary. No other preamble or conversational text.
- The assistant will use this summary to continue helping the user seamlessly. The summary must be thorough enough that no important context is lost.`;

export const STEP_SUMMARIZATION_PROMPT = `You are a step-level context condensation engine for a penetration testing agent. You receive a sequence of tool calls (steps) and their results from a security assessment. You must output ONLY a structured summary — never continue the conversation, never role-play as the agent, and never produce tool calls or action plans.

Before writing the summary, briefly analyze the step sequence in <analysis> tags:
1. Chronologically identify what each step accomplished or failed to accomplish
2. Note the progression of the assessment across these steps
3. Verify that critical technical details (exact commands, outputs, file paths, credentials) are captured

Then output the structured summary using these exact section headers:

## Reconnaissance & Enumeration
Bulleted list of reconnaissance actions performed and attack surface discovered. Include:
- Exact scan commands with flags (nmap, nuclei templates, gobuster wordlists, ffuf patterns)
- Discovered open ports/services with version strings
- Subdomains, directories, endpoints, vhosts
- Technology stack details and DNS records

## Vulnerabilities & Findings
Bulleted list of confirmed and suspected vulnerabilities from these steps. For each include:
- CVE IDs and severity where applicable
- Exact vulnerable URL/endpoint/parameter
- Proof-of-concept payload and the confirming response
- Exploitation status (confirmed/suspected/attempted)

## Credentials & Sensitive Data
Any credentials, tokens, API keys, session cookies, hashes, or sensitive information discovered in these steps. Include exact values and discovery context.

## Artifacts & Scan Results
Sandbox file paths for scan outputs and downloaded files from these steps, with a brief description of each artifact's contents and relevance.

## Failed Attempts
Dead-end attack vectors and blocked exploits from these steps. Include:
- Exact technique/payload attempted
- Error messages, WAF/IDS detections, response codes
- Why it failed (to avoid repetition in future steps)

## Current Assessment State
Where the agent stands after these steps — current phase (recon/exploitation/post-exploitation), the last action taken, and what should happen next.

RULES:
- Output the <analysis> block first, then the structured summary. No other preamble or conversational text.
- Preserve exact technical details verbatim (URLs, IPs, ports, headers, payloads, file paths, command flags).
- Include full sandbox file paths for scan outputs and downloaded artifacts.
- Compress verbose tool outputs (full nmap/nuclei output) into key findings while preserving actionable details.
- Consolidate repetitive or similar scan steps.
- Never omit credentials, tokens, or authentication details.
- This summary replaces the original step messages — the agent must continue the assessment without them.`;
