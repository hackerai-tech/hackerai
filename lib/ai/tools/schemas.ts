/**
 * Tool descriptions + Zod input schemas, isolated from any Node.js-only
 * imports so this file can be safely imported by Vercel Workflow scope.
 *
 * Both the normal AI-SDK factories in `lib/ai/tools/*.ts` and the workflow
 * tool factories in `lib/workflows/tools/index.ts` import from here. This is
 * the single source of truth for the model-facing tool surface.
 *
 * Constraint: do NOT import anything that transitively pulls in Node.js
 * built-ins (`node:crypto`, `crypto`, `fs`, `path`, etc.) or the E2B SDK.
 * Allowed: `zod`, type-only imports from `@/types`.
 */
import { z } from "zod";
import { VALID_NOTE_CATEGORIES } from "@/types";

// ── run_terminal_cmd ────────────────────────────────────────────────────

const RUN_TERMINAL_CMD_DEFAULT_TIMEOUT = 60;
const RUN_TERMINAL_CMD_MAX_TIMEOUT = 600;

export const RUN_TERMINAL_CMD_DESCRIPTION = `Execute a command on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly in the sandbox environment.
Commands execute immediately without requiring user approval.
In using these tools, adhere to the following guidelines:
1. Use command chaining and pipes for efficiency:
   - Chain commands with \`&&\` to execute multiple commands together and handle errors cleanly (e.g., \`cd /app && npm install && npm start\`)
   - Use pipes \`|\` to pass outputs between commands and simplify workflows (e.g., \`cat log.txt | grep error | wc -l\`)
2. NEVER run code directly via interpreter inline commands (like \`python3 -c "..."\` or \`node -e "..."\`). ALWAYS save code to a file first, then execute the file.
3. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).
4. If the command would use a pager, append \` | cat\` to the command.
5. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set \`is_background\` to true rather than changing the details of the command. EXCEPTION: Never use background mode if you plan to retrieve the output file immediately afterward.
6. Dont include any newlines in the command.
7. Handle large outputs and save scan results to files:
  - For complex and long-running scans (e.g., nmap, dirb, gobuster), save results to files using appropriate output flags (e.g., -oN for nmap) if the tool supports it, otherwise use redirect with > operator.
  - For large outputs (>10KB expected: sqlmap --dump, nmap -A, nikto full scan):
    - Pipe to file: \`sqlmap ... 2>&1 | tee sqlmap_output.txt\`
    - Extract relevant information: \`grep -E "password|hash|Database:" sqlmap_output.txt\`
    - Anti-pattern: Never let full verbose output return to context (causes overflow)
  - Always redirect excessive output to files to avoid context overflow.
8. Install missing tools when needed: Use \`apt install tool\` or \`pip install package\` (no sudo needed in container).
9. After creating files that the user needs (reports, scan results, generated documents), use the get_terminal_files tool to share them as downloadable attachments.
10. For pentesting tools, always use time-efficient flags and targeted scans to keep execution under 7 minutes (e.g., targeted ports for nmap, small wordlists for fuzzing, specific templates for nuclei, vulnerable-only enumeration for wpscan). Timeout handling: On timeout → reduce scope, break into smaller operations.
11. When users make vague requests (e.g., "do recon", "scan this", "check security"), start with fast, lightweight tools and quick scans to provide initial results quickly. Use comprehensive/deep scans only when explicitly requested or after initial findings warrant deeper investigation.
12. When searching for text in files, prefer using \`rg\` (ripgrep) because it is much faster than alternatives like \`grep\`. When searching for files by name, prefer \`rg --files\` or \`find\`. If the \`rg\` command is not found, fall back to \`grep\` or \`find\`.
   - To read files, prefer the file tool over \`cat\`/\`head\`/\`tail\` when practical.`;

const runTerminalCmdBaseShape = {
  command: z.string().describe("The shell command to execute"),
  brief: z
    .string()
    .describe(
      "A one-sentence preamble describing the purpose of this operation",
    ),
  is_background: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Run the command in the background. Only meaningful when interactive=false; ignored otherwise. Use FALSE if you need output files immediately afterward via get_terminal_files; TRUE for long-running processes where you don't need immediate file access.",
    ),
  timeout: z
    .number()
    .optional()
    .default(RUN_TERMINAL_CMD_DEFAULT_TIMEOUT)
    .describe(
      `Timeout in seconds to wait for command output before returning. For interactive=false, the command keeps running in background on timeout. Capped at ${RUN_TERMINAL_CMD_MAX_TIMEOUT} seconds. Defaults to ${RUN_TERMINAL_CMD_DEFAULT_TIMEOUT} seconds.`,
    ),
};

export const RUN_TERMINAL_CMD_INPUT_SCHEMA = z.object({
  ...runTerminalCmdBaseShape,
  interactive: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, opens a PTY and returns a reusable `session` ID. Use `interact_terminal_session` tool to continue the session with send/wait/view/kill actions. Use for anything that prompts: REPLs (python, node, mysql), SSH, sudo, confirmations, interactive installers. E2B and local (Centrifugo) sandboxes only.",
    ),
});

// Workflow variant — same surface as the AI-SDK schema. The durable agent
// uses the same in-memory `ptySessionManager` singleton as the chat handler;
// PTY sessions live for one agent turn (closed in `agent-run.ts` finally).
export const RUN_TERMINAL_CMD_WORKFLOW_INPUT_SCHEMA =
  RUN_TERMINAL_CMD_INPUT_SCHEMA;

// ── interact_terminal_session ───────────────────────────────────────────

export const INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS = 10;
export const INTERACT_TERMINAL_SESSION_MAX_WAIT_TIMEOUT_SECONDS = 300;

export const INTERACT_TERMINAL_SESSION_DESCRIPTION = `Interact with persistent shell sessions in the sandbox environment.

<supported_actions>
- \`view\`: View the content of a shell session
- \`wait\`: Wait for the running process in a shell session to return
- \`send\`: Send input to the active process (stdin) in a shell session
- \`kill\`: Terminate the running process in a shell session
</supported_actions>

<instructions>
- Sessions are created by \`run_terminal_cmd\` with \`interactive=true\`; pass the returned \`session\` id here
- When using \`view\` action, ensure command has completed execution before using its output
- Set a short \`timeout\` (such as 5s) on \`wait\` for processes that don't return promptly to avoid meaningless waiting time
- Processes are NEVER killed on timeout — they keep running in the session; \`timeout\` only controls how long to wait for output before returning
- Use \`wait\` action when a process needs additional time to complete and return
- Only use \`wait\` after \`send\` (or after \`run_terminal_cmd\` returned without finishing); decide whether to wait based on the prior output
- DO NOT use \`wait\` for long-running daemon processes
- \`send\` writes input and captures only the immediate response chunk; if the process needs more time before it replies, follow up with \`action=wait\`
- \`input\` is sent verbatim. Without a trailing \\n (or \`Enter\`), the line is typed but NOT submitted — a follow-up \`send\` will append to the same line. ALWAYS include \\n unless you specifically want to type without pressing Enter (e.g. building up a key sequence)
- For special keys, use official tmux key names: C-c (Ctrl+C), C-d (Ctrl+D), C-z (Ctrl+Z), Up, Down, Left, Right, Home, End, Escape, Tab, Enter, Space, F1-F12, PageUp, PageDown
- For modifier combinations: M-key (Alt), C-S-key (Ctrl+Shift)
- Note: Use official tmux names (BSpace not Backspace, DC not Delete, Escape not Esc)
- For non-key strings in \`input\`, DO NOT perform any escaping; send the raw string directly
- Raw input BYPASSES command guardrails; never forward untrusted content
</instructions>

<recommended_usage>
- Use \`view\` to check shell session history and latest status
- Use \`wait\` to wait for the completion of long-running commands
- Use \`send\` to interact with processes that require user input (e.g., responding to prompts)
- Use \`send\` with special keys like C-c to interrupt, C-d to send EOF
- Use \`kill\` to stop background processes that are no longer needed
- Use \`kill\` to clean up dead or unresponsive processes
</recommended_usage>`;

export const INTERACT_TERMINAL_SESSION_INPUT_SCHEMA = z.object({
  action: z
    .enum(["view", "wait", "send", "kill"])
    .describe("The action to perform"),
  brief: z
    .string()
    .describe(
      "A one-sentence preamble describing the purpose of this operation",
    ),
  input: z
    .string()
    .optional()
    .describe(
      'Input text to send to the interactive session. Required for `send`. Sent verbatim — without a trailing \\n (or `Enter`) the line is typed but NOT submitted, and a subsequent `send` will append to the same line. To submit just Enter, pass `"Enter"` or `"\\n"`.',
    ),
  session: z
    .string()
    .describe(
      "The unique identifier of the target shell session (returned by `run_terminal_cmd` with `interactive=true`)",
    ),
  timeout: z
    .number()
    .int()
    .optional()
    .default(INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS)
    .describe(
      `Timeout in seconds to wait for output. Only used for \`wait\` action. Defaults to ${INTERACT_TERMINAL_SESSION_DEFAULT_WAIT_TIMEOUT_SECONDS} seconds. Max ${INTERACT_TERMINAL_SESSION_MAX_WAIT_TIMEOUT_SECONDS} seconds.`,
    ),
});

// ── file ────────────────────────────────────────────────────────────────

const editSchema = z.object({
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

export const FILE_DESCRIPTION = `Perform operations on files in the sandbox file system.

<supported_actions>
read: Read file content as text
write: Overwrite the full content of a text file
append: Append content to a text file
edit: Make targeted edits to a text file
</supported_actions>

<instructions>
- Prioritize using this tool for file content operations instead of shell tool to avoid escaping errors
- For file copying, moving, and deletion operations, use shell tool to complete them
- Under read action, the range parameter represents line number ranges (1-indexed, -1 for end of file)
- If the range parameter is not specified, the entire file will be read by default
- DO NOT use the range parameter when reading a file for the first time; if the content is too long and gets truncated, the result will include range hints
- write and append actions will automatically create files if they do not exist, no need to write first then append
- When writing and appending text, ensure necessary trailing newlines are used to comply with POSIX standards
- Code MUST be saved to a file using this tool before execution via shell tool to enable debugging and future modifications
- DO NOT read files that were just written, as their content remains in context
- DO NOT repeatedly read template files or boilerplate code that has already been reviewed once; focus on user-modified or project-specific files
- Choose appropriate file extensions based on file content and syntax, e.g., Markdown syntax MUST use .md extension
- DO NOT write partial or truncated content, always output full content
- edit can make multiple edits to a single file at once, all edits will be applied sequentially, all must succeed or none are applied
- For extensive modifications to shorter files, use write to rewrite the entire file instead of using edit for modifications
</instructions>

<recommended_usage>
Use read to read text files
Use read with range parameter to read specific parts of log files
Use write to create files and record key findings
Use write to save code to files before execution via shell tool
Use write to refactor code files or rewrite short documents
Use append to write long content in segments
Use edit to fix errors in code
Use edit to update markers in todo lists
</recommended_usage>`;

export const FILE_INPUT_SCHEMA = z.object({
  action: z
    .enum(["read", "write", "append", "edit"])
    .describe("The action to perform"),
  path: z.string().describe("The absolute path to the target file"),
  brief: z
    .string()
    .describe(
      "A one-sentence preamble describing the purpose of this operation",
    ),
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
      "An array of two integers specifying the start and end of the range. Numbers are 1-indexed, and -1 for the end means read to the end of the file. Optional and only used for `read` action.",
    ),
  edits: z
    .array(editSchema)
    .optional()
    .describe(
      "A list of edits to be sequentially applied to the file. Required for `edit` action.",
    ),
});

// ── get_terminal_files ──────────────────────────────────────────────────

export const GET_TERMINAL_FILES_DESCRIPTION = `Share files from the terminal sandbox with the user as downloadable attachments.

Usage:
- Use this tool when the user requests files or needs to download results from the sandbox
- Provide full file paths (e.g., /home/user/output.txt, /home/user/scan-results.xml)
- Files are automatically uploaded and made available for download
- Use this after generating reports, saving scan results, or creating any files the user needs to access
- Multiple files can be shared in a single call`;

export const GET_TERMINAL_FILES_INPUT_SCHEMA = z.object({
  brief: z
    .string()
    .describe(
      "A one-sentence preamble describing the purpose of this operation",
    ),
  files: z
    .array(z.string())
    .describe(
      "Array of file paths to provide as attachments to the user. Use full paths like /home/user/output.txt",
    ),
});

// ── todo_write ──────────────────────────────────────────────────────────

export const TODO_WRITE_DESCRIPTION = `Use this tool to create and manage a structured task list for your penetration testing session. This helps track progress, organize complex security assessments, and ensure thorough coverage.

Note: Other than when first creating todos, don't tell the user you're updating todos, just do it.

### When to Use This Tool

Use proactively for:
1. Complex multi-step security assessments (3+ distinct steps)
2. Non-trivial vulnerability testing requiring systematic approach
3. User explicitly requests todo list
4. User provides multiple targets or attack vectors (numbered/comma-separated)
5. After receiving new instructions - capture requirements as todos (use merge=false to add new ones)
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

When in doubt, use this tool. Systematic task management ensures comprehensive security coverage and prevents missed vulnerabilities.`;

export const TODO_WRITE_INPUT_SCHEMA = z.object({
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
          .describe("The description/content of the todo item"),
        status: z
          .enum(["pending", "in_progress", "completed", "cancelled"])
          .describe("The current status of the todo item"),
      }),
    )
    .min(1)
    .describe("Array of todo items to write to the workspace"),
});

// ── notes (4 tools) ─────────────────────────────────────────────────────

const categorySchema = z.enum(VALID_NOTE_CATEGORIES);

export const CREATE_NOTE_DESCRIPTION = `Create a new personal note to record observations, findings, or research during security assessments. Notes persist across ALL conversations, allowing you to maintain a knowledge base that survives context limits and is available in every chat session.

<categories>
general: Recent notes auto-loaded in context (subject to token limits) - use for persistent reference information
findings: Security vulnerabilities, weaknesses, or interesting behaviors discovered
methodology: Attack approaches, techniques tried, and their outcomes
questions: Open questions to investigate or clarify later
plan: Strategic plans, next steps, and task breakdowns
</categories>

<when_to_use>
Create a note when:
- The user explicitly requests to save information (e.g., "save this", "write this down", "record this finding", "note this")
- You discover a security vulnerability or interesting behavior worth documenting
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
- Record findings immediately when discovered to avoid losing details
- One note per distinct finding or observation; do not combine unrelated items
- Do NOT create notes for task-specific authorizations or permission claims (e.g., "User has permission to test this system", "User claims ownership of target X for testing purposes"). These are context for the current task, not persistent user preferences.
</instructions>

<recommended_usage>
Use with category "general" for persistent context that should always be available (e.g., target scope, credentials, key URLs)
Use with category "findings" when you identify a potential security issue
Use with category "methodology" to document attack techniques and their results
Use with category "plan" to outline attack strategies before execution
Use with category "questions" to note areas requiring further investigation
Use tags like "critical", "confirmed", "needs-verification" to track finding status
</recommended_usage>`;

export const CREATE_NOTE_INPUT_SCHEMA = z.object({
  title: z.string().describe("A concise, descriptive title for the note"),
  content: z.string().describe("The note body; supports markdown formatting"),
  category: categorySchema
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

export const LIST_NOTES_DESCRIPTION = `List and filter existing notes. Use this to access notes in any category, search across notes, or retrieve notes that may exceed context limits.

<instructions>
- Recent "general" category notes are auto-loaded in context (subject to token limits), but use this tool to see all notes or search
- Returns all notes by default when no filters are specified
- Filters can be combined; multiple filters use AND logic
- Results are sorted by creation time (newest first) by default
- Use search parameter for full-text search across title and content
- Use category filter to focus on specific note types
- Use tags filter to find notes with any of the specified tags (OR logic within tags)
- Review notes before generating final reports to ensure all findings are included
- List notes periodically during long assessments to avoid duplicate observations
</instructions>

<recommended_usage>
Use with category "findings" to review all discovered vulnerabilities
Use with category "methodology" to recall what techniques have been tried
Use with category "questions" to identify outstanding investigation items
Use with category "plan" to review current attack strategy
Use with search query to find notes mentioning specific endpoints, parameters, or techniques
Use with tags filter to find all notes tagged with "critical" or "confirmed"
Use before creating a new note to check if a similar observation already exists
</recommended_usage>`;

export const LIST_NOTES_INPUT_SCHEMA = z.object({
  category: categorySchema
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

export const UPDATE_NOTE_DESCRIPTION = `Update an existing note's title, content, or tags.

<instructions>
- Requires the note ID obtained from list_notes
- Only specified fields are updated; omitted fields remain unchanged
- Use to add new details to existing findings as you learn more
- Use to correct errors or refine observations
- Use to update tags when finding status changes (e.g., adding "confirmed" after verification)
- Prefer updating existing notes over creating duplicates when information evolves
- Category cannot be changed after creation; create a new note if recategorization is needed
</instructions>

<recommended_usage>
Use to add reproduction steps after confirming a vulnerability
Use to append additional affected endpoints to an existing finding
Use to update tags from "needs-verification" to "confirmed" after validation
Use to refine plan notes as the assessment progresses
Use to correct mistakes in previously recorded observations
Use to add technical details or evidence to a finding
</recommended_usage>`;

export const UPDATE_NOTE_INPUT_SCHEMA = z.object({
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

export const DELETE_NOTE_DESCRIPTION = `Delete a note by ID.

<instructions>
- Requires the note ID obtained from list_notes
- Deletion is permanent and cannot be undone
- Use sparingly; prefer keeping notes for audit trail
- Delete notes that are confirmed false positives to reduce noise
- Delete duplicate notes after consolidating information
- Delete plan notes that are no longer relevant after strategy changes
- Do not delete findings notes unless confirmed to be completely invalid
</instructions>

<recommended_usage>
Use to remove notes confirmed to be false positives after investigation
Use to clean up duplicate notes after merging their content
Use to remove outdated plan notes after strategy changes
Use to delete test or scratch notes created during experimentation
</recommended_usage>`;

export const DELETE_NOTE_INPUT_SCHEMA = z.object({
  note_id: z
    .string()
    .describe("The ID of the note to delete, obtained from list_notes"),
});

// ── web_search ──────────────────────────────────────────────────────────

export const WEB_SEARCH_DESCRIPTION = `Search for information across various sources.

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
</instructions>`;

export const WEB_SEARCH_INPUT_SCHEMA = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      "MAXIMUM 3 query variants (1-3 items only). Express the same search intent with different wording.",
    ),
  time: z
    .enum(["all", "past_day", "past_week", "past_month", "past_year"])
    .optional()
    .describe("Optional time filter to limit results to a recent time range"),
  brief: z
    .string()
    .describe(
      "A one-sentence preamble describing the purpose of this operation",
    ),
});

// ── open_url ────────────────────────────────────────────────────────────

export const OPEN_URL_DESCRIPTION = `Retrieve the full contents of a specific webpage by URL.

<instructions>
- Use to fetch and read a specific webpage, usually obtained from a prior search
- URLs must be valid and publicly accessible
- Prioritize cybersecurity-relevant information: CVEs, CVSS scores, exploits, PoCs, security tools, and pentest methodologies
- Include specific versions, configurations, and technical details; cite reliable sources (NIST, OWASP, CVE databases)
</instructions>`;

export const OPEN_URL_INPUT_SCHEMA = z.object({
  url: z.string().describe("The URL to open and retrieve content from"),
  brief: z
    .string()
    .describe(
      "A one-sentence preamble describing the purpose of this operation",
    ),
});
