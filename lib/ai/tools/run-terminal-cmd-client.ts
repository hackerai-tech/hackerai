import { tool } from "ai";
import { z } from "zod";

const DEFAULT_STREAM_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;

/**
 * Client-side version of run_terminal_cmd for Tauri browser relay mode.
 *
 * This tool is defined WITHOUT an `execute` function, making it a client-side
 * tool in the Vercel AI SDK. When the AI model calls this tool:
 * 1. The tool call is streamed to the browser (no server-side execution)
 * 2. The browser's `onToolCall` handler intercepts it
 * 3. The browser calls the Tauri desktop app's local HTTP command server
 * 4. The result is sent back via `addToolOutput`
 *
 * This enables Vercel-hosted apps to execute commands on the user's local
 * machine through their Tauri desktop app, without needing a relay service.
 */
export const createRunTerminalCmdClientSide = () => {
  return tool({
    description: `Execute a command on behalf of the user.
If you have this tool, note that you DO have the ability to run commands directly on the user's local machine via the HackerAI Desktop app.
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
9. For pentesting tools, always use time-efficient flags and targeted scans to keep execution under 7 minutes (e.g., targeted ports for nmap, small wordlists for fuzzing, specific templates for nuclei, vulnerable-only enumeration for wpscan). Timeout handling: On timeout → reduce scope, break into smaller operations.
10. When users make vague requests (e.g., "do recon", "scan this", "check security"), start with fast, lightweight tools and quick scans to provide initial results quickly. Use comprehensive/deep scans only when explicitly requested or after initial findings warrant deeper investigation.
11. Avoid using the terminal for file search operations (\`find\`, \`grep\`, \`rg\`, \`cat\`, \`head\`, \`tail\`) unless explicitly instructed or truly necessary for the task. Instead, prefer the dedicated tools:
   - File search by name: Use the match tool with glob action (NOT find or ls)
   - Content search: Use the match tool with grep action (NOT grep or rg)
   - Read files: Use the file tool (NOT cat/head/tail)

IMPORTANT: You are executing commands on the user's LOCAL machine via the HackerAI Desktop app.
Commands run directly on the host OS. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)

When making charts for the user: 1) never use seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never set any specific colors – unless explicitly asked to by the user.
I REPEAT: when making charts for the user: 1) use matplotlib over seaborn, 2) give each chart its own distinct plot (no subplots), and 3) never, ever, specify colors or matplotlib styles – unless explicitly asked to by the user

If you are generating files:
- You MUST use the instructed library for each supported file format. (Do not assume any other libraries are available):
    - pdf --> reportlab
    - docx --> python-docx
    - xlsx --> openpyxl
    - pptx --> python-pptx
    - csv --> pandas
    - rtf --> pypandoc
    - txt --> pypandoc
    - md --> pypandoc
    - ods --> odfpy
    - odt --> odfpy
    - odp --> odfpy
- If you are generating a pdf:
    - You MUST prioritize generating text content using reportlab.platypus rather than canvas
    - If you are generating text in korean, chinese, OR japanese, you MUST use the following built-in UnicodeCIDFont. To use these fonts, you must call pdfmetrics.registerFont(UnicodeCIDFont(font_name)) and apply the style to all text elements:
        - japanese --> HeiseiMin-W3 or HeiseiKakuGo-W5
        - simplified chinese --> STSong-Light
        - traditional chinese --> MSung-Light
        - korean --> HYSMyeongJo-Medium
- If you are to use pypandoc, you are only allowed to call the method pypandoc.convert_text and you MUST include the parameter extra_args=['--standalone']. Otherwise the file will be corrupt/incomplete
    - For example: pypandoc.convert_text(text, 'rtf', format='md', outputfile='output.rtf', extra_args=['--standalone'])`,
    parameters: z.object({
      command: z.string().describe("The terminal command to execute"),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
      is_background: z
        .boolean()
        .describe(
          "Whether the command should be run in the background. Set to FALSE if you need to retrieve output files immediately after with get_terminal_files. Only use TRUE for indefinite processes where you don't need immediate file access.",
        ),
      timeout: z
        .number()
        .optional()
        .default(DEFAULT_STREAM_TIMEOUT_SECONDS)
        .describe(
          `Timeout in seconds to wait for command execution. On timeout, command continues running in background. Capped at ${MAX_TIMEOUT_SECONDS} seconds. Defaults to ${DEFAULT_STREAM_TIMEOUT_SECONDS} seconds.`,
        ),
    }),
    // No `execute` function — this is a client-side tool.
    // The browser handles execution via Tauri's local HTTP command server.
  });
};
