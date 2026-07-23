import { tool } from "ai";
import { z } from "zod";

export const toolBriefSchema = z
  .string()
  .optional()
  .describe(
    "Optional display metadata. Include a concise one-sentence preamble whenever possible so the user understands the operation; if omitted, HackerAI will show a generated fallback label.",
  );

export const RUN_TERMINAL_DEFAULT_STREAM_TIMEOUT_SECONDS = 60;
export const RUN_TERMINAL_MAX_TIMEOUT_SECONDS = 600;

export const createRunTerminalCmdToolSchema = ({
  approvalGated = false,
}: {
  approvalGated?: boolean;
} = {}) => {
  const commandCompositionGuidance = approvalGated
    ? `1. Prefer one static command per tool call so a safe argv prefix can be approved and reused:
   - Do not chain commands or use shell operators such as \`&&\`, \`|\`, \`;\`, redirects, or substitutions
   - Use separate tool calls for multi-step workflows`
    : `1. Use command chaining and pipes for efficiency:
   - Chain commands with \`&&\` to execute multiple commands together and handle errors cleanly (e.g., \`cd /app && npm install && npm start\`)
   - Use pipes \`|\` to pass outputs between commands and simplify workflows (e.g., \`cat log.txt | grep error | wc -l\`)`;
  const pagerGuidance = approvalGated
    ? "4. If the command would use a pager, pass the command's native non-pager flag."
    : "4. If the command would use a pager, append ` | cat` to the command.";
  const largeOutputGuidance = approvalGated
    ? `7. Handle large outputs and save scan results to files:
  - For complex and long-running scans (e.g., nmap, dirb, gobuster), use the tool's native output-file flags (e.g., \`-oN\` for nmap)
  - Keep each command static and use separate tool calls to inspect or extract relevant results
  - Never let full verbose output return to context (causes overflow)`
    : `7. Handle large outputs and save scan results to files:
  - For complex and long-running scans (e.g., nmap, dirb, gobuster), save results to files using appropriate output flags (e.g., -oN for nmap) if the tool supports it, otherwise use redirect with > operator.
  - For large outputs (>10KB expected: sqlmap --dump, nmap -A, nikto full scan):
    - Pipe to file: \`sqlmap ... 2>&1 | tee sqlmap_output.txt\`
    - Extract relevant information: \`grep -E "password|hash|Database:" sqlmap_output.txt\`
    - Anti-pattern: Never let full verbose output return to context (causes overflow)
  - Always redirect excessive output to files to avoid context overflow.`;

  return tool({
    description: `Execute a command on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly in the sandbox environment.
Commands run in the selected sandbox environment.${approvalGated ? " The platform will pause execution after you call this tool and ask the user to approve it; do not ask in chat instead of calling the tool when a command is needed." : ""}
${approvalGated ? "For every approval-gated command, provide a concise, user-facing justification describing the intended outcome; HackerAI displays it in the approval prompt, so do not merely repeat the command. prefix_rule is optional: provide it only for a narrow, useful category of similar commands the user can safely approve for this conversation. It must be an exact argv prefix represented as separate array elements. Prefer a stable safe prefix over copying the complete command, and omit it when no reusable scope is appropriate. Never provide prefix_rule for destructive commands, shell wrappers, compound commands, redirects, substitutions, environment assignments, wildcards, or other dynamic shell syntax." : ""}
In using these tools, adhere to the following guidelines:
${commandCompositionGuidance}
2. NEVER run code directly via interpreter inline commands (like \`python3 -c "..."\` or \`node -e "..."\`). ALWAYS save code to a file first, then execute the file.
3. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
${pagerGuidance}
5. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command. EXCEPTION: Never use background mode if you plan to retrieve the output file immediately afterward.
6. Dont include any newlines in the command.
${largeOutputGuidance}
8. Install missing tools when needed: Use \`apt install tool\` or \`pip install package\` (no sudo needed in container).
9. After creating files that the user needs (reports, scan results, generated documents), use the get_terminal_files tool to share them as downloadable attachments.
10. For pentesting tools, always use time-efficient flags and targeted scans to keep execution under 7 minutes (e.g., targeted ports for nmap, small wordlists for fuzzing, specific templates for nuclei, vulnerable-only enumeration for wpscan). Timeout handling: On timeout -> reduce scope, break into smaller operations.
11. When users make vague requests (e.g., "do recon", "scan this", "check security"), start with fast, lightweight tools and quick scans to provide initial results quickly. Use comprehensive/deep scans only when explicitly requested or after initial findings warrant deeper investigation.
12. When searching for text in files, prefer using \`rg\` (ripgrep) because it is much faster than alternatives like \`grep\`. When searching for files by name, prefer \`rg --files\` or \`find\`. If the \`rg\` command is not found, fall back to \`grep\` or \`find\`.
   - To read files, prefer the file tool over \`cat\`/\`head\`/\`tail\` when practical.`,
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      brief: toolBriefSchema,
      ...(approvalGated
        ? {
            justification: z
              .string()
              .max(240)
              .optional()
              .describe(
                "A concise, user-facing reason shown in HackerAI's approval prompt. Explain the intended outcome rather than repeating the command.",
              ),
            prefix_rule: z
              .array(z.string().min(1).max(256))
              .min(1)
              .max(16)
              .optional()
              .describe(
                'An optional reusable command scope the user may approve for this conversation. Supply separate argv elements that exactly match the beginning of the command. Choose the narrowest useful stable prefix for a category of similar commands, such as ["git", "status"] or ["ping", "-c", "4"], instead of copying the complete command. Omit it when reuse is unsafe or unnecessary, including destructive commands, shell wrappers, compound commands, redirects, substitutions, environment assignments, wildcards, and other dynamic shell syntax.',
              ),
          }
        : {}),
      is_background: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Run the command as a detached background process. Only meaningful when interactive=false; ignored otherwise. Detached processes return a PID but no reusable terminal session, so never pass that PID to interact_terminal_session. Use FALSE if you need output or a resumable session; TRUE only for long-running processes whose output you do not need to poll.",
        ),
      timeout: z
        .number()
        .optional()
        .default(RUN_TERMINAL_DEFAULT_STREAM_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for command output before returning. A quiet foreground command that is still running returns a reusable opaque session ID for interact_terminal_session; copy that returned session exactly and never derive one from its PID. Noisy foreground commands that already produced truncated output may be terminated to protect the session. Capped at ${RUN_TERMINAL_MAX_TIMEOUT_SECONDS} seconds. Defaults to ${RUN_TERMINAL_DEFAULT_STREAM_TIMEOUT_SECONDS} seconds.`,
        ),
      interactive: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, opens an input-capable PTY and returns a reusable `session` ID. Use `interact_terminal_session` to continue it with send/wait/view/kill actions. Use for anything that prompts: REPLs (python, node, mysql), SSH, sudo, confirmations, interactive installers. Foreground interactive=false commands can also return a wait/view/kill session if they exceed the initial timeout, but those sessions do not accept send. E2B and local (Centrifugo) sandboxes only.",
        ),
    }),
  });
};

export const runTerminalCmdTool = createRunTerminalCmdToolSchema();

export const INTERACT_TERMINAL_DEFAULT_WAIT_TIMEOUT_SECONDS = 10;
export const INTERACT_TERMINAL_MAX_WAIT_TIMEOUT_SECONDS = 300;

export const interactTerminalSessionTool = tool({
  description: `Interact with persistent shell sessions in the sandbox environment.

<supported_actions>
- \`view\`: View the content of a shell session
- \`wait\`: Wait for the running process in a shell session to return
- \`send\`: Send input to the active process (stdin) in a shell session
- \`kill\`: Terminate the running process in a shell session
</supported_actions>

<instructions>
- Only call this tool when the preceding \`run_terminal_cmd\` result contains an explicit \`session\` field; copy that value exactly
- A PID is not a session ID. Never derive a session from a PID (for example, never turn PID 1689 into \`cmd-1689\`)
- Input-capable sessions are created with \`interactive=true\`; timed-out foreground commands may return non-interactive sessions that support wait/view/kill but not send
- When using \`view\` action, ensure command has completed execution before using its output
- Set a short \`timeout\` (such as 5s) on \`wait\` for processes that don't return promptly to avoid meaningless waiting time
- Processes are NEVER killed on timeout - they keep running in the session; \`timeout\` only controls how long to wait for output before returning
- Use \`wait\` action when a process needs additional time to complete and return
- Only use \`wait\` after \`send\`, or after \`run_terminal_cmd\` returned without finishing and included an explicit \`session\` field; decide whether to wait based on the prior output
- DO NOT use \`wait\` for long-running daemon processes
- \`send\` writes input and captures only the immediate response chunk; if the process needs more time before it replies, follow up with \`action=wait\`
- \`input\` is sent verbatim. Without a trailing \\n (or \`Enter\`), the line is typed but NOT submitted - a follow-up \`send\` will append to the same line. ALWAYS include \\n unless you specifically want to type without pressing Enter (e.g. building up a key sequence)
- For special keys, use official tmux key names: C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), Up, Down, Left, Right, Home, End, Escape, Tab, Enter, Space, F1-F12, PageUp, PageDown
- For modifier combinations: M-key (Alt), C-S-key (Ctrl+Shift)
- Note: Use official tmux names (BSpace not Backspace, DC not Delete, Escape not Esc)
- For non-key strings in \`input\`, DO NOT perform any escaping; send the raw string directly
</instructions>

<recommended_usage>
- Use \`view\` to check shell session history and latest status
- Use \`wait\` to wait for the completion of long-running commands
- Use \`send\` to interact with processes that require user input (e.g., responding to prompts)
- Use \`send\` with special keys like C-c to interrupt, C-d to send EOF
- Use \`kill\` to stop background processes that are no longer needed
- Use \`kill\` to clean up dead or unresponsive processes
</recommended_usage>`,
  inputSchema: z.object({
    action: z
      .enum(["view", "wait", "send", "kill"])
      .describe("The action to perform"),
    brief: toolBriefSchema,
    input: z
      .string()
      .optional()
      .describe(
        'Input text to send to the interactive session. Required for `send`. Sent verbatim - without a trailing \\n (or `Enter`) the line is typed but NOT submitted, and a subsequent `send` will append to the same line. To submit just Enter, pass `"Enter"` or `"\\n"`.',
      ),
    session: z
      .string()
      .describe(
        "The exact opaque session identifier explicitly returned by run_terminal_cmd. Never pass a PID or construct a session identifier yourself.",
      ),
    timeout: z
      .number()
      .int()
      .optional()
      .default(INTERACT_TERMINAL_DEFAULT_WAIT_TIMEOUT_SECONDS)
      .describe(
        `Timeout in seconds to wait for output. Only used for \`wait\` action. Defaults to ${INTERACT_TERMINAL_DEFAULT_WAIT_TIMEOUT_SECONDS} seconds. Max ${INTERACT_TERMINAL_MAX_WAIT_TIMEOUT_SECONDS} seconds.`,
      ),
  }),
});

export const getTerminalFilesTool = tool({
  description: `Share files from the terminal sandbox with the user as downloadable attachments.

Usage:
- Use this tool when the user requests files or needs to download results from the sandbox
- Provide full file paths (e.g., /home/user/output.txt, /home/user/scan-results.xml)
- Files are automatically uploaded and made available for download
- Files larger than 250 MB cannot be shared; reduce, split, or exclude bulky generated/dependency directories before sharing
- Use this after generating reports, saving scan results, or creating any files the user needs to access
- Multiple files can be shared in a single call`,
  inputSchema: z.object({
    brief: toolBriefSchema,
    files: z
      .array(z.string())
      .describe(
        "Array of file paths to provide as attachments to the user. Use full paths like /home/user/output.txt",
      ),
  }),
});

export const FILE_ACTIONS_WITH_VIEW = [
  "view",
  "read",
  "write",
  "append",
  "edit",
] as const;
export const FILE_ACTIONS_TEXT_ONLY = [
  "read",
  "write",
  "append",
  "edit",
] as const;
export type FileToolAction = (typeof FILE_ACTIONS_WITH_VIEW)[number];

const fileEditSchema = z.object({
  find: z.string().describe("The exact text string to find in the file"),
  replace: z
    .string()
    .describe("The replacement text that will substitute the found text"),
  all: z
    .boolean()
    .optional()
    .describe(
      "Whether to replace all occurrences instead of just the first one. Defaults to false.",
    ),
});

export const createFileToolSchema = ({
  supportsView,
  approvalGated = false,
}: {
  supportsView: boolean;
  approvalGated?: boolean;
}) => {
  const actionSchema = (
    supportsView
      ? z.enum(FILE_ACTIONS_WITH_VIEW)
      : z.enum(FILE_ACTIONS_TEXT_ONLY)
  ) as z.ZodType<FileToolAction>;
  const supportedActionsDescription = [
    supportsView
      ? "- view: View raster image files through multimodal understanding."
      : null,
    "- read: Read file content as text (Markdown, code, logs).",
    "- write: Overwrite the full content of a text file.",
    "- append: Append content to a text file.",
    "- edit: Make targeted edits to a text file.",
  ]
    .filter(Boolean)
    .join("\n");
  const instructions = [
    "Prioritize using this tool instead of the shell tool for file content operations to avoid escaping errors.",
    approvalGated
      ? "Write, append, and edit actions are approval-gated. When one is needed, call this tool and let the platform request approval instead of asking in chat first."
      : null,
    "For file copying, moving, and deletion, use the shell tool.",
    ...(supportsView
      ? [
          "Use 'view' only for raster image files such as PNG, JPEG, GIF, and WebP.",
          "When the current Agent model is not vision-capable, calling 'view' automatically routes subsequent Agent steps to a vision-capable model.",
          "Do not use 'view' for PDFs. Use 'read' for extractable text, or use the shell tool to convert PDF pages to images first if visual inspection is required.",
          "Use 'read' for text-based or line-oriented formats.",
        ]
      : [
          "Use 'read' for text-based or line-oriented formats.",
          "This model cannot view sandbox images directly; ask the user to select a model with image viewing support.",
        ]),
    "Code MUST be saved to a file using this tool before execution via the shell tool.",
    "DO NOT write partial or truncated content; always output the full content.",
    "'edit' can make multiple targeted replacements at once; all must succeed or none are applied.",
    "For extensive modifications to shorter files, use 'write' to rewrite the entire file instead of 'edit'.",
    "Under read action, the range parameter represents line number ranges (1-indexed, -1 for end of file).",
    "If the range parameter is not specified, the entire file will be read by default.",
    "Oversized files are not loaded in full; read will return file metadata and range guidance instead.",
    "DO NOT use the range parameter when reading a file for the first time; if the content is too long and gets truncated, the result will include range hints.",
    "write and append actions will automatically create files if they do not exist.",
    "When writing and appending text, ensure necessary trailing newlines are used to comply with POSIX standards.",
    "DO NOT read files that were just written, as their content remains in context.",
    "Choose appropriate file extensions based on file content and syntax, e.g. Markdown syntax MUST use .md extension.",
  ];
  const instructionsDescription = instructions
    .filter((instruction): instruction is string => Boolean(instruction))
    .map((instruction, index) => `${index + 1}. ${instruction}`)
    .join("\n");

  return tool({
    description: `Perform operations on files in the sandbox file system.
This tool is the primary way to manage file content, allowing for reading, writing, appending, editing text-based files, and viewing raster image files.

### Supported Actions

${supportedActionsDescription}

### Instructions

${instructionsDescription}`,
    inputSchema: z.object({
      action: actionSchema.describe("The action to perform"),
      path: z.string().describe("The absolute path to the target file"),
      brief: toolBriefSchema,
      text: z
        .string()
        .optional()
        .describe(
          "The content to be written or appended. Required for `write` and `append` actions.",
        ),
      range: z
        .array(z.number().int())
        .length(2)
        .optional()
        .describe(
          "An array of two integers specifying the start and end of the range. For `read`, numbers are 1-indexed line numbers and -1 means read to the end of the file. Do not use range with `view`.",
        ),
      edits: z
        .array(fileEditSchema)
        .optional()
        .describe(
          "A list of edits to be sequentially applied to the file. Required for `edit` action.",
        ),
    }),
  });
};

export const todoWriteToolInputSchema = z.object({
  merge: z
    .boolean()
    .describe(
      "Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos.",
    ),
  todos: z
    .array(
      z.object({
        id: z.string().describe("Unique identifier for the todo item"),
        content: z
          .string()
          .refine((value) => value.trim().length > 0, {
            message: "Todo content cannot be blank",
          })
          .optional()
          .describe("The description/content of the todo item"),
        status: z
          .enum(["pending", "in_progress", "completed", "cancelled"])
          .optional()
          .describe("The current status of the todo item"),
      }),
    )
    .min(1)
    .describe(
      "Array of todo items to write to the workspace. For merge=false, new items should include content and status and replace the assistant-generated plan while preserving manually created todos. Partial items are treated as merge-style updates. For merge=true, existing items may be patched with partial updates, but new items should include content and status.",
    ),
});

export const todoWriteTool = tool({
  description: `Use this tool to create and manage a structured task list for your penetration testing session. This helps track progress, organize complex security assessments, and ensure thorough coverage.

Note: Other than when first creating todos, don't tell the user you're updating todos, just do it.

### When to Use This Tool

Use proactively for:
1. Complex multi-step security assessments (3+ distinct steps)
2. Non-trivial vulnerability testing requiring systematic approach
3. User explicitly requests todo list
4. User provides multiple targets or attack vectors (numbered/comma-separated)
5. After receiving new instructions - capture requirements as todos (use merge=false to replace the assistant plan, or merge=true to patch the current plan)
6. After completing tasks - mark complete with merge=true and add follow-ups
7. When starting new tasks - mark as in_progress (ideally only one at a time)

### When NOT to Use

Skip for:
1. Single, straightforward checks
2. Quick reconnaissance queries
3. Tasks completable in < 3 trivial steps
4. Purely informational requests about security concepts

NEVER INCLUDE THESE IN TODOS: basic enumeration steps; reading tool output; routine scanning operations.

### Examples

<example>
  User: Test the authentication system for vulnerabilities
  Assistant:
    - *Creates todo list:*
      1. Test login endpoint for SQL injection [in_progress]
      2. Check for authentication bypass vectors
      3. Analyze session management weaknesses
      4. Test password reset flow for flaws
    - [Immediately begins working on todo 1 in the same tool call batch]
<reasoning>
  Multi-step security assessment with multiple attack surfaces.
</reasoning>
</example>

<example>
  User: Perform a full security assessment of the /api endpoints
  Assistant: *Enumerates endpoints, identifies 12 routes across 5 controllers*
  *Creates todo list with specific items for each endpoint category*

<reasoning>
  Complex assessment requiring systematic tracking across multiple attack surfaces.
</reasoning>
</example>

<example>
  User: Check for IDOR, XSS, SSRF, and privilege escalation vulnerabilities
  Assistant: *Creates todo list breaking down each vulnerability class into specific tests*

<reasoning>
  Multiple vulnerability categories provided requiring organized testing approach.
</reasoning>
</example>

<example>
  User: The admin panel seems insecure - find all the issues
  Assistant: *Analyzes admin functionality, identifies attack vectors*
  *Creates todo list: 1) Test access controls, 2) Check for privilege escalation, 3) Analyze file upload functionality, 4) Test for CSRF, 5) Check sensitive data exposure*

<reasoning>
  Comprehensive security assessment requires multiple testing phases.
</reasoning>
</example>

### Examples of When NOT to Use the Todo List

<example>
  User: What is SQL injection?
  Assistant: SQL injection is a code injection technique...

<reasoning>
  Informational request with no testing task to complete.
</reasoning>
</example>

<example>
  User: Run a quick port scan on the target
  Assistant: *Executes port scan* Results show ports 22, 80, 443 open...

<reasoning>
  Single straightforward scan with immediate results.
</reasoning>
</example>

<example>
  User: Check if this URL is vulnerable to path traversal
  Assistant: *Tests for path traversal* The endpoint appears to sanitize input...

<reasoning>
  Single targeted test on one endpoint.
</reasoning>
</example>

### Task States and Management

1. **Task States:**
  - pending: Not yet started
  - in_progress: Currently testing
  - completed: Finished successfully
  - cancelled: No longer relevant

2. **Task Management:**
  - Update status in real-time
  - Mark complete IMMEDIATELY after finishing
  - Only ONE task in_progress at a time
  - Complete current tasks before starting new ones

3. **Task Breakdown:**
  - Create specific, actionable security tests
  - Break complex assessments into targeted checks
  - Use clear, descriptive names (e.g., "Test /api/users for IDOR")

4. **Parallel Todo Writes:**
  - Prefer creating the first todo as in_progress
  - Start working on todos by using tool calls in the same tool call batch as the todo write
  - Batch todo updates with other tool calls for efficiency

When in doubt, use this tool. Systematic task management ensures comprehensive security coverage and prevents missed vulnerabilities.`,
  inputSchema: todoWriteToolInputSchema,
});

export const PERPLEXITY_QUERY_MAX_LENGTH = 8192;
const webSearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(PERPLEXITY_QUERY_MAX_LENGTH);

export const webSearchToolInputSchema = z.object({
  queries: z
    .array(webSearchQuerySchema)
    .min(1)
    .max(3)
    .describe(
      "MAXIMUM 3 non-empty query variants (1-3 items only). Express the same search intent with different wording.",
    ),
  time: z
    .enum(["all", "past_day", "past_week", "past_month", "past_year"])
    .optional()
    .describe("Optional time filter to limit results to a recent time range"),
  brief: toolBriefSchema,
});

export const webSearchTool = tool({
  description: `Search for information across various sources.

<instructions>
- MUST use this tool to access up-to-date or external information when needed; DO NOT rely solely on internal knowledge
- Each search MUST contain exactly 1 to 3 \`queries\` (NEVER more than 3). Queries MUST be variants of the same intent (i.e., query expansions), NOT different goals
- For non-English queries, MUST include at least one English query as the final variant to expand coverage
- For complex searches, MUST break down into step-by-step searches instead of using a single complex query
- Access multiple URLs from search results for comprehensive information or cross-validation
- CAN use Google dork syntax (site:, filetype:, inurl:, intitle:, etc.) for targeted reconnaissance and pentest enumeration
- Only use \`time\` parameter when explicitly required by task, otherwise leave time range unrestricted
- Prioritize cybersecurity-relevant information: CVEs, CVSS scores, exploits, PoCs, security tools, and pentest methodologies
- Include specific versions, configurations, and technical details; cite reliable sources (NIST, OWASP, CVE databases)
- For commands/installations, prioritize Kali Linux compatibility using apt or pre-installed tools
</instructions>`,
  inputSchema: webSearchToolInputSchema,
});

export type WebSearchToolInput = z.infer<typeof webSearchToolInputSchema>;

export const openUrlToolInputSchema = z.object({
  url: z.string().describe("The URL to open and retrieve content from"),
  brief: toolBriefSchema,
});

export const openUrlTool = tool({
  description: `Retrieve the full contents of a specific webpage by URL.

<instructions>
- Use to fetch and read a specific webpage, usually obtained from a prior search
- URLs must be valid and publicly accessible
- Prioritize cybersecurity-relevant information: CVEs, CVSS scores, exploits, PoCs, security tools, and pentest methodologies
- Include specific versions, configurations, and technical details; cite reliable sources (NIST, OWASP, CVE databases)
</instructions>`,
  inputSchema: openUrlToolInputSchema,
});

export type OpenUrlToolInput = z.infer<typeof openUrlToolInputSchema>;

export const NOTE_CATEGORIES = [
  "general",
  "findings",
  "methodology",
  "questions",
  "plan",
] as const;
const noteCategorySchema = z.enum(NOTE_CATEGORIES);

export const createNoteToolInputSchema = z.object({
  title: z.string().describe("A concise, descriptive title for the note"),
  content: z.string().describe("The note body; supports markdown formatting"),
  category: noteCategorySchema
    .optional()
    .describe(
      'The note category for organization. Valid values: "general", "findings", "methodology", "questions", "plan". Defaults to "general" if not specified.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Optional tags for filtering and cross-referencing notes (e.g., "xss", "api", "critical")',
    ),
});

export const createNoteTool = tool({
  description: `Create a new personal note to record observations, findings, or research during security assessments. Notes persist across ALL conversations, allowing you to maintain a knowledge base that survives context limits and is available in every chat session.

<categories>
general: Recent notes auto-loaded in context (subject to token limits) - use for persistent reference information
findings: Unverified security hypotheses, weaknesses, or interesting behaviors that still need confirmation
methodology: Attack approaches, techniques tried, and their outcomes
questions: Open questions to investigate or clarify later
plan: Strategic plans, next steps, and task breakdowns
</categories>

<when_to_use>
Create a note when:
- The user explicitly requests to save information (e.g., "save this", "write this down", "record this finding", "note this")
- You discover an interesting behavior or security hypothesis worth documenting before it is confirmed
- You want to preserve intermediate findings that need to survive context limits
- You need to track methodology, plans, or open questions across sessions
- **Anytime** you would say "I'll note that" or "recorded" - actually create the note first
</when_to_use>

<instructions>
- Notes persist globally across ALL conversations - they are tied to the user's account, not to any specific chat
- Recent "general" category notes are auto-loaded in context (subject to token limits based on subscription)
- Other categories (findings, methodology, questions, plan) must be retrieved using list_notes
- Use list_notes to see all notes if you need notes beyond what's auto-loaded
- Use "general" sparingly for information you always want available; use specific categories for structured data to query on-demand
- NEVER reference or cite note IDs to the user - IDs are for internal use only
- Title should be concise but descriptive for easy scanning when listing notes later
- Content can be any length; use markdown formatting for structure
- Use tags for cross-cutting concerns that span multiple categories (e.g., "xss", "api", "auth")
- Use create_vulnerability_report instead, exactly once, when a vulnerability has concrete evidence, reliable reproduction, and a working PoC
- Never duplicate a confirmed vulnerability in a Notes "findings" entry
- One note per distinct finding or observation; do not combine unrelated items
- Do NOT create notes for task-specific authorizations or permission claims (e.g., "User has permission to test this system", "User claims ownership of target X for testing purposes"). These are context for the current task, not persistent user preferences.
</instructions>

<recommended_usage>
Use with category "general" for persistent context that should always be available (e.g., target scope, credentials, key URLs)
Use with category "findings" when you identify a potential security issue that still needs validation
Use with category "methodology" to document attack techniques and their results
Use with category "plan" to outline attack strategies before execution
Use with category "questions" to note areas requiring further investigation
Use tags like "critical", "candidate", and "needs-verification" to track hypothesis status
</recommended_usage>`,
  inputSchema: createNoteToolInputSchema,
});

export type CreateNoteToolInput = z.infer<typeof createNoteToolInputSchema>;

export const listNotesToolInputSchema = z.object({
  category: noteCategorySchema
    .optional()
    .describe(
      'Filter notes by category. Valid values: "general", "findings", "methodology", "questions", "plan". Omit to include all categories.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Filter notes that have any of the specified tags (OR logic)"),
  search: z
    .string()
    .optional()
    .describe("Full-text search query to filter notes by title or content"),
});

export const listNotesTool = tool({
  description: `List and filter existing notes. Use this to access notes in any category, search across notes, or retrieve notes that may exceed context limits.

<instructions>
- Recent "general" category notes are auto-loaded in context (subject to token limits), but use this tool to see all notes or search
- Returns all notes by default when no filters are specified
- Filters can be combined; multiple filters use AND logic
- Results are sorted by creation time (newest first) by default
- Use search parameter for full-text search across title and content
- Use category filter to focus on specific note types
- Use tags filter to find notes with any of the specified tags (OR logic within tags)
- Review notes during an assessment so unresolved hypotheses are not forgotten
- List notes periodically during long assessments to avoid duplicate observations
</instructions>

<recommended_usage>
Use with category "findings" to review potential issues that still need validation
Use with category "methodology" to recall what techniques have been tried
Use with category "questions" to identify outstanding investigation items
Use with category "plan" to review current attack strategy
Use with search query to find notes mentioning specific endpoints, parameters, or techniques
Use with tags filter to find all notes tagged with "critical" or "needs-verification"
Use before creating a new note to check if a similar observation already exists
</recommended_usage>`,
  inputSchema: listNotesToolInputSchema,
});

export type ListNotesToolInput = z.infer<typeof listNotesToolInputSchema>;

export const updateNoteToolInputSchema = z.object({
  note_id: z
    .string()
    .describe("The ID of the note to update, obtained from list_notes"),
  title: z
    .string()
    .optional()
    .describe("New title for the note. Omit to keep existing title."),
  content: z
    .string()
    .optional()
    .describe("New content for the note. Omit to keep existing content."),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "New tags array, replaces existing tags entirely. Omit to keep existing tags.",
    ),
});

export const updateNoteTool = tool({
  description: `Update an existing note's title, content, or tags.

<instructions>
- Requires the note ID obtained from list_notes
- Only specified fields are updated; omitted fields remain unchanged
- Use to add new details to unverified observations as you learn more
- Use to correct errors or refine observations
- Use to update tags as a hypothesis moves through validation
- Prefer updating existing notes over creating duplicates when information evolves
- Category cannot be changed after creation; create a new note if recategorization is needed
</instructions>

<recommended_usage>
Use to add investigation steps to an unverified observation
Use to append candidate affected endpoints while validation is still in progress
Use to refine hypotheses without claiming they are confirmed reports
Use to refine plan notes as the assessment progresses
Use to correct mistakes in previously recorded observations
Use to add technical details or evidence to an unverified hypothesis
</recommended_usage>`,
  inputSchema: updateNoteToolInputSchema,
});

export type UpdateNoteToolInput = z.infer<typeof updateNoteToolInputSchema>;

export const deleteNoteToolInputSchema = z.object({
  note_id: z
    .string()
    .describe("The ID of the note to delete, obtained from list_notes"),
});

export const deleteNoteTool = tool({
  description: `Delete a note by ID.

<instructions>
- Requires the note ID obtained from list_notes
- Deletion is permanent and cannot be undone
- Use sparingly; prefer keeping notes for audit trail
- Delete notes that are confirmed false positives to reduce noise
- Delete duplicate notes after consolidating information
- Delete plan notes that are no longer relevant after strategy changes
- Delete obsolete or disproven hypothesis notes when they no longer help the investigation
</instructions>

<recommended_usage>
Use to remove notes confirmed to be false positives after investigation
Use to clean up duplicate notes after merging their content
Use to remove outdated plan notes after strategy changes
Use to delete test or scratch notes created during experimentation
</recommended_usage>`,
  inputSchema: deleteNoteToolInputSchema,
});

export type DeleteNoteToolInput = z.infer<typeof deleteNoteToolInputSchema>;

const findingRequiredText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max.toLocaleString()} characters or fewer`);

const findingOptionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max.toLocaleString()} characters or fewer`)
    .nullable()
    .optional()
    .transform((value) => value || undefined);

const stripFindingBoundaryNewlines = (value: string) =>
  value.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");

const findingRequiredCodeText = (label: string, max: number) =>
  z
    .string()
    .transform(stripFindingBoundaryNewlines)
    .refine((value) => value.trim().length > 0, `${label} is required`)
    .refine(
      (value) => value.length <= max,
      `${label} must be ${max.toLocaleString()} characters or fewer`,
    );

const findingOptionalCodeText = (label: string, max: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) return undefined;
      const normalized = stripFindingBoundaryNewlines(value);
      return normalized.trim().length > 0 ? normalized : undefined;
    })
    .refine(
      (value) => value === undefined || value.length <= max,
      `${label} must be ${max.toLocaleString()} characters or fewer`,
    );

const getFindingLineCount = (value: string) => value.split(/\r?\n/).length;

const findingCodeLocationSchema = z
  .object({
    file: findingRequiredText("File", 500).superRefine((path, ctx) => {
      const segments = path.split("/");
      if (
        path.startsWith("/") ||
        path.startsWith("./") ||
        /^[A-Za-z]:/.test(path) ||
        path.includes("\\") ||
        path.includes("\0") ||
        segments.some((segment) => segment === ".." || segment === "")
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "File must be a relative repository path without traversal, empty segments, or backslashes",
        });
      }
    }),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    snippet: findingOptionalCodeText("Snippet", 16_000),
    label: findingOptionalText("Label", 200),
    fix_before: findingOptionalCodeText("Fix before", 16_000),
    fix_after: findingOptionalCodeText("Fix after", 16_000),
  })
  .strict()
  .superRefine((location, ctx) => {
    if (location.end_line < location.start_line) {
      ctx.addIssue({
        code: "custom",
        path: ["end_line"],
        message: "End line must be greater than or equal to start line",
      });
    }
    if (Boolean(location.fix_before) !== Boolean(location.fix_after)) {
      ctx.addIssue({
        code: "custom",
        path: [location.fix_before ? "fix_after" : "fix_before"],
        message: "fix_before and fix_after must be provided together",
      });
    }
    if (
      location.fix_before &&
      getFindingLineCount(location.fix_before) !==
        location.end_line - location.start_line + 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fix_before"],
        message:
          "fix_before must contain exactly the lines covered by start_line and end_line",
      });
    }
  });

export const createVulnerabilityReportToolInputSchema = z
  .object({
    title: findingRequiredText("Title", 200),
    description: findingRequiredText("Description", 4_000),
    impact: findingRequiredText("Impact", 4_000),
    target: findingRequiredText("Target", 1_000),
    technical_analysis: findingRequiredText("Technical analysis", 12_000),
    poc_description: findingRequiredText("PoC description", 8_000),
    poc_script_code: findingRequiredCodeText("PoC script/code", 32_000),
    remediation_steps: findingRequiredText("Remediation steps", 8_000),
    evidence: findingRequiredText("Evidence", 16_000),
    assumptions: findingRequiredText("Assumptions", 4_000),
    fix_effort: z.enum(["trivial", "low", "medium", "high"]),
    cvss_breakdown: z
      .object({
        attack_vector: z.enum(["N", "A", "L", "P"]),
        attack_complexity: z.enum(["L", "H"]),
        privileges_required: z.enum(["N", "L", "H"]),
        user_interaction: z.enum(["N", "R"]),
        scope: z.enum(["U", "C"]),
        confidentiality: z.enum(["N", "L", "H"]),
        integrity: z.enum(["N", "L", "H"]),
        availability: z.enum(["N", "L", "H"]),
      })
      .strict(),
    endpoint: findingOptionalText("Endpoint", 1_000),
    method: findingOptionalText("Method", 32),
    cve: z
      .string()
      .trim()
      .regex(/^(?:CVE-\d{4}-\d{4,})?$/, "CVE must use CVE-YYYY-NNNN format")
      .max(32)
      .nullable()
      .optional()
      .transform((value) => value || undefined),
    cwe: z
      .string()
      .trim()
      .regex(/^(?:CWE-\d+)?$/, "CWE must use CWE-NNN format")
      .max(24)
      .nullable()
      .optional()
      .transform((value) => value || undefined),
    code_locations: z
      .array(findingCodeLocationSchema)
      .max(50)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  })
  .strict()
  .superRefine((input, ctx) => {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(input)).length;
    if (payloadBytes > 128 * 1024) {
      ctx.addIssue({
        code: "custom",
        message: "Finding payload must be 131072 bytes or smaller",
      });
    }
  });

export type CreateVulnerabilityReportInput = z.infer<
  typeof createVulnerabilityReportToolInputSchema
>;

export const createVulnerabilityReportTool = tool({
  description: `Persist one fully confirmed vulnerability as a structured finding.

<when_to_use>
Use this tool only after all of the following are true:
- The issue is a concrete vulnerability on a specific target
- Concrete evidence demonstrates the vulnerable behavior
- The issue can be reproduced reliably
- A working proof of concept is available in poc_script_code
- Impact and exploitability prerequisites are understood
</when_to_use>

<when_not_to_use>
- Scanner output, suspicious behavior, or an unverified idea
- A hypothesis without demonstrated impact or a working PoC
- General hardening advice, informational observations, or methodology notes
- Dependency-only vulnerability reports based only on a published advisory
- A vulnerability already reported in this source chat
</when_not_to_use>

<instructions>
- Persist at most one successful report for each distinct confirmed root cause
- File one distinct root cause per call; do not combine unrelated vulnerabilities
- Call once after confirmation; if a non-duplicate response explicitly returns retryable: true, retry the same report once
- Never retry a duplicate response
- Use formal, objective, vendor-neutral markdown in the report fields
- Put numbered reproduction steps only in poc_description and executable exploit/payload code only in poc_script_code
- Put concrete requests, responses, observed behavior, logs, or code proof in evidence
- Keep remediation_steps as prose; put code replacements in code_locations
- Populate code_locations whenever source code is available, after reading the actual file
- Verify start_line and end_line instead of guessing; fix_before must be a verbatim copy of exactly that range and fix_after must be the complete replacement
- Split non-contiguous changes into separate labeled code locations and do not duplicate the same change
- Pass bare CVE/CWE identifiers only when certain; omit unknown identifiers instead of sending empty strings, and prefer the most specific applicable CWE
- CVSS 3.1 must include all eight base metrics; the server calculates the score and severity
- Choose Base metrics from the exploitability and impact demonstrated by the evidence and working PoC, not a theoretical worst case
- Score the privileges the attacker must already have before exploiting this vulnerability; do not treat credentials or access obtained through another vulnerability as free prerequisites
- Set User Interaction to Required whenever a separate user must act for exploitation to succeed
- Set Scope to Changed only when the demonstrated impact crosses a security authority boundary
- Do not infer High confidentiality, integrity, or availability impact from the vulnerability class alone; reserve High for demonstrated broad or critical consequences and use Low or None when the observed effect is limited
- Do not mention internal agents, models, prompts, sandboxes, report IDs, or tester-only paths in report content
</instructions>`,
  inputSchema: createVulnerabilityReportToolInputSchema,
});

export type AgentToolSchemaMode = "agent" | "ask";

export const createAgentToolSchemaSet = ({
  mode = "agent",
  notesEnabled = true,
  isTemporary = false,
  hasPerplexityApiKey = false,
  hasJinaApiKey = false,
}: {
  mode?: AgentToolSchemaMode;
  notesEnabled?: boolean;
  isTemporary?: boolean;
  hasPerplexityApiKey?: boolean;
  hasJinaApiKey?: boolean;
} = {}) => {
  const notes =
    !isTemporary && notesEnabled
      ? {
          create_note: createNoteTool,
          list_notes: listNotesTool,
          update_note: updateNoteTool,
          delete_note: deleteNoteTool,
        }
      : {};
  const networkTools = {
    ...(hasPerplexityApiKey ? { web_search: webSearchTool } : {}),
    ...(hasJinaApiKey ? { open_url: openUrlTool } : {}),
  };

  if (mode === "ask") {
    return {
      ...notes,
      ...networkTools,
    };
  }

  return {
    run_terminal_cmd: runTerminalCmdTool,
    interact_terminal_session: interactTerminalSessionTool,
    get_terminal_files: getTerminalFilesTool,
    file: createFileToolSchema({ supportsView: true }),
    todo_write: todoWriteTool,
    ...(!isTemporary && {
      create_vulnerability_report: createVulnerabilityReportTool,
    }),
    ...notes,
    ...networkTools,
  };
};
