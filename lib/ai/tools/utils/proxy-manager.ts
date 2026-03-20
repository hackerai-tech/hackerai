/**
 * ProxyManager — TypeScript port of Strix's proxy_manager.py
 *
 * Executes Caido GraphQL queries by running curl on the sandbox, so the
 * requests originate on the remote machine where Caido is actually listening.
 * This works identically for desktop and remote-connection sandboxes.
 */

import type { ToolContext } from "@/types";
import { CAIDO_DEFAULTS } from "./caido-proxy";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { truncateContent, TRUNCATION_MESSAGE } from "@/lib/token-utils";

const CAIDO_TOKEN_FILE = "/tmp/caido-token";
const CAIDO_LOG = "/tmp/caido.log";

/**
 * Per-session lock: ensures only one ensureCaido runs at a time per sandboxManager.
 * Concurrent callers await the same Promise instead of racing.
 * Once resolved, subsequent calls are a no-op unless invalidated.
 */
const caidoLock = new WeakMap<object, Promise<void>>();

/** Detects Caido's broken-database error in response content. */
function isCaidoBroken(text: string): boolean {
  return (
    text.includes("Could not acquire a connection to the database") ||
    text.includes("Repository operation failed")
  );
}

/**
 * Clear the setup lock AND kill the broken caido-cli process.
 * Just clearing the lock isn't enough — the GraphQL API may still respond
 * while the proxy module is broken, causing ensureCaido to think it's healthy.
 * Killing the process forces a full restart on the next ensureCaido call.
 */
async function invalidateAndKillCaido(context: ToolContext): Promise<void> {
  caidoLock.delete(context.sandboxManager);
  try {
    const { sandbox } = await context.sandboxManager.getSandbox();
    const options = buildSandboxCommandOptions(sandbox);
    const port = CAIDO_DEFAULTS.port;
    console.warn(
      `[Caido] Database error detected — killing caido-cli on port ${port} for restart`,
    );
    await sandbox.commands.run(
      `CAIDO_PID=$(pgrep -f "caido-cli.*--listen.*${port}" || true); [ -n "$CAIDO_PID" ] && kill $CAIDO_PID 2>/dev/null || true; rm -f ${CAIDO_TOKEN_FILE}`,
      options,
    );
  } catch (e) {
    console.warn("[Caido] Failed to kill broken caido-cli:", e);
  }
}

/**
 * Ensure Caido is running on the sandbox.
 *
 * Runs as a single shell script to minimise sandbox round-trips:
 * - Fast path (Docker / already running + token exists): exits immediately.
 * - Slow path: starts caido-cli, waits for readiness, authenticates, creates project.
 *
 * Uses a Promise-based lock: parallel tool calls await the same setup instead of racing.
 */
export async function ensureCaido(context: ToolContext): Promise<void> {
  const existing = caidoLock.get(context.sandboxManager);
  if (existing) return existing;

  const setup = doEnsureCaido(context);
  caidoLock.set(context.sandboxManager, setup);

  try {
    await setup;
  } catch (e) {
    console.warn("[Caido] Setup failed:", e);
    caidoLock.delete(context.sandboxManager);
    throw e;
  }
}

async function doEnsureCaido(context: ToolContext): Promise<void> {
  const { sandbox } = await context.sandboxManager.getSandbox();
  const config = CAIDO_DEFAULTS;
  const baseUrl = `http://${config.host}:${config.port}`;
  const options = buildSandboxCommandOptions(sandbox);

  const authB64 = Buffer.from(
    JSON.stringify({
      query: "mutation LoginAsGuest { loginAsGuest { token { accessToken } } }",
    }),
  ).toString("base64");

  const createB64 = Buffer.from(
    JSON.stringify({
      query:
        'mutation { createProject(input: {name: "hackerai", temporary: true}) { project { id } error { ... on NameTakenUserError { code } ... on PermissionDeniedUserError { code } ... on OtherUserError { code } } } }',
    }),
  ).toString("base64");

  const listProjectsB64 = Buffer.from(
    JSON.stringify({
      query: "{ projects { id name } }",
    }),
  ).toString("base64");

  const healthCheck =
    `curl -s -o /dev/null -w "%{http_code}" -X POST "${baseUrl}/graphql"` +
    ` -H "Content-Type: application/json" -d '{"query":"{ __typename }"}' 2>/dev/null`;

  // Query that requires a valid token AND a selected project — if this returns
  // 200 with valid JSON, Caido is fully operational and we can skip setup.
  const projectCheck = [
    `curl -s -X POST "$CAIDO_API/graphql"`,
    `-H "Content-Type: application/json"`,
    `-H "Authorization: Bearer $(cat "$TOKEN_FILE" 2>/dev/null)"`,
    `-d '{"query":"{ requestsByOffset(limit:1) { count { value } } }"}'`,
    `2>/dev/null`,
  ].join(" ");

  // Auto-install function embedded in the shell script.
  // Detects OS/arch, downloads caido-cli from caido.download, extracts to ~/.local/bin or /usr/local/bin.
  const installFn = [
    `install_caido_cli() {`,
    `  CAIDO_VERSION=$(curl -sL https://api.github.com/repos/caido/caido/releases/latest | grep '"tag_name"' | head -1 | cut -d'"' -f4)`,
    `  [ -z "$CAIDO_VERSION" ] && echo "install_failed" && exit 1`,
    `  case "$(uname -s)" in`,
    `    Linux*)  CAIDO_OS="linux" ;;`,
    `    Darwin*) CAIDO_OS="mac" ;;`,
    `    MINGW*|MSYS*|CYGWIN*) CAIDO_OS="win" ;;`,
    `    *) echo "install_failed" && exit 1 ;;`,
    `  esac`,
    `  case "$(uname -m)" in`,
    `    x86_64|amd64) CAIDO_ARCH="x86_64" ;;`,
    `    aarch64|arm64) CAIDO_ARCH="aarch64" ;;`,
    `    *) echo "install_failed" && exit 1 ;;`,
    `  esac`,
    `  CAIDO_URL="https://caido.download/releases/\${CAIDO_VERSION}/caido-cli-\${CAIDO_VERSION}-\${CAIDO_OS}-\${CAIDO_ARCH}.tar.gz"`,
    `  INSTALL_DIR="$HOME/.local/bin"`,
    `  mkdir -p "$INSTALL_DIR" 2>/dev/null`,
    `  # Try ~/.local/bin first, fall back to /usr/local/bin with sudo`,
    `  if curl -sL "$CAIDO_URL" | tar -xz -C "$INSTALL_DIR" 2>/dev/null && [ -f "$INSTALL_DIR/caido-cli" ]; then`,
    `    chmod +x "$INSTALL_DIR/caido-cli"`,
    `    export PATH="$INSTALL_DIR:$PATH"`,
    `  elif curl -sL "$CAIDO_URL" | sudo tar -xz -C /usr/local/bin 2>/dev/null && [ -f /usr/local/bin/caido-cli ]; then`,
    `    sudo chmod +x /usr/local/bin/caido-cli`,
    `  else`,
    `    echo "install_failed" && exit 1`,
    `  fi`,
    `}`,
  ].join("\n");

  const script = [
    installFn,
    ``,
    `CAIDO_API="${baseUrl}"`,
    `TOKEN_FILE="${CAIDO_TOKEN_FILE}"`,
    ``,
    `# Fast path: running + token valid + project selected`,
    `STATUS=$(${healthCheck})`,
    `if [ "$STATUS" = "200" ] || [ "$STATUS" = "400" ]; then`,
    `  if [ -s "$TOKEN_FILE" ]; then`,
    `    CHECK=$(${projectCheck})`,
    `    if ! echo "$CHECK" | grep -q '"errors"'; then`,
    `      echo "ok" && exit 0`,
    `    fi`,
    `  fi`,
    `fi`,
    ``,
    `# Caido not running or not healthy — request external start`,
    `if ! ([ "$STATUS" = "200" ] || [ "$STATUS" = "400" ]); then`,
    `  which caido-cli >/dev/null 2>&1 || install_caido_cli`,
    `  echo "needs_start"`,
    `  exit 0`,
    `fi`,
    ``,
    `# Authenticate as guest`,
    `AUTH=$(echo '${authB64}' | base64 -d | curl -sL -X POST "$CAIDO_API/graphql" \\`,
    `  -H "Content-Type: application/json" --data @-)`,
    `TOKEN=$(echo "$AUTH" | grep -Eo '"accessToken":"[^"]*"' | cut -d'"' -f4 || echo "")`,
    `if [ -z "$TOKEN" ]; then echo "needs_start" && exit 0; fi`,
    `printf '%s' "$TOKEN" > "$TOKEN_FILE"`,
    ``,
    `# Find or create the "hackerai" project`,
    `PROJECTS=$(echo '${listProjectsB64}' | base64 -d | curl -sL -X POST "$CAIDO_API/graphql" \\`,
    `  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" --data @-)`,
    `PROJECT_ID=$(echo "$PROJECTS" | grep -o '"id":"[^"]*","name":"hackerai"' | grep -Eo '"id":"[^"]*"' | cut -d'"' -f4 || echo "")`,
    `if [ -z "$PROJECT_ID" ]; then`,
    `  CREATE=$(echo '${createB64}' | base64 -d | curl -sL -X POST "$CAIDO_API/graphql" \\`,
    `    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" --data @-)`,
    `  PROJECT_ID=$(echo "$CREATE" | grep -Eo '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")`,
    `fi`,
    `if [ -n "$PROJECT_ID" ]; then`,
    `  SELECT_BODY='{"query":"mutation { selectProject(id: \\"'"$PROJECT_ID"'\\"){ currentProject { project { id } } } }"}'`,
    `  echo "$SELECT_BODY" | curl -sL -X POST "$CAIDO_API/graphql" \\`,
    `    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \\`,
    `    --data @- >/dev/null 2>&1 || true`,
    `fi`,
    `echo "ok"`,
  ].join("\n");

  const result = await sandbox.commands.run(script, {
    ...options,
    timeoutMs: 45000,
  });

  // Status is on the last non-empty line
  const lastLine =
    result.stdout
      .trim()
      .split("\n")
      .findLast((l: string) => l.trim() !== "") ?? "";

  if (lastLine === "not_installed" || lastLine === "install_failed") {
    throw new Error(
      "caido-cli could not be installed automatically.\n" +
        "Please install Caido CLI manually: https://caido.io/download\n" +
        "Caido starts automatically inside the Docker sandbox.",
    );
  }
  if (lastLine === "timeout") {
    throw new Error(
      `Caido did not become ready in 30 s. Check ${CAIDO_LOG} for errors.`,
    );
  }
  if (lastLine === "auth_failed") {
    throw new Error(
      `Caido authentication failed. Check ${CAIDO_LOG} for errors.`,
    );
  }

  // Script detected Caido needs to be started — launch it as a proper background
  // process via the sandbox API (not inside a shell script where it may get killed).
  if (lastLine === "needs_start") {
    // Get the public hostname for --ui-domain so the Caido UI is accessible externally
    let uiDomainFlag = "";
    try {
      const host = sandbox.getHost(config.port);
      // getHost returns "hostname" or "https://hostname" — extract just the domain
      const domain = host.replace(/^https?:\/\//, "").split("/")[0];
      if (
        domain &&
        !domain.startsWith("127.0.0.1") &&
        !domain.startsWith("localhost")
      ) {
        uiDomainFlag = ` --ui-domain ${domain}`;
      }
    } catch {
      /* local sandbox — no external domain needed */
    }

    // Start caido-cli as a persistent background process
    await sandbox.commands.run(
      `caido-cli --listen 0.0.0.0:${config.port} --allow-guests --no-logging --no-open${uiDomainFlag} > ${CAIDO_LOG} 2>&1`,
      { ...options, background: true },
    );

    // Wait for Caido to become healthy
    const waitResult = await sandbox.commands.run(
      [
        `for i in $(seq 1 15); do`,
        `  STATUS=$(${healthCheck})`,
        `  ([ "$STATUS" = "200" ] || [ "$STATUS" = "400" ]) && echo "ready" && exit 0`,
        `  sleep 2`,
        `done`,
        `echo "timeout"`,
      ].join("\n"),
      { ...options, timeoutMs: 35000 },
    );

    if (!waitResult.stdout.includes("ready")) {
      throw new Error(
        `Caido did not become ready in 30 s. Check ${CAIDO_LOG} for errors.`,
      );
    }

    // Re-run the setup script — this time Caido is running, so it will auth + create project
    const setupResult = await sandbox.commands.run(script, {
      ...options,
      timeoutMs: 45000,
    });

    const setupLastLine =
      setupResult.stdout
        .trim()
        .split("\n")
        .findLast((l: string) => l.trim() !== "") ?? "";

    if (setupLastLine === "auth_failed") {
      throw new Error(
        `Caido authentication failed after restart. Check ${CAIDO_LOG} for errors.`,
      );
    }
    if (setupLastLine !== "ok") {
      throw new Error(
        `Caido setup failed after restart: ${setupResult.stdout || setupResult.stderr}`,
      );
    }
    return;
  }

  if (lastLine !== "ok") {
    throw new Error(`Caido setup failed: ${result.stdout || result.stderr}`);
  }

  // Cache the Caido UI URL and set it as an env var on the sandbox
  let uiUrl = `http://127.0.0.1:${config.port}`;
  try {
    const host = sandbox.getHost(config.port);
    uiUrl = host.startsWith("http") ? host : `https://${host}`;
  } catch {
    /* local sandbox */
  }
  console.log(`[Caido] UI available at: ${uiUrl}`);

  // Write env var so the AI can retrieve it via `echo $CAIDO_UI_URL`
  await sandbox.commands
    .run(
      `echo 'export CAIDO_UI_URL="${uiUrl}"' >> /etc/profile.d/caido.sh`,
      options,
    )
    .catch(() => {
      // Fallback for non-root: write to user profile
      sandbox.commands
        .run(`echo 'export CAIDO_UI_URL="${uiUrl}"' >> ~/.bashrc`, options)
        .catch(() => {});
    });
}

const SORT_MAPPING: Record<string, string> = {
  timestamp: "CREATED_AT",
  host: "HOST",
  method: "METHOD",
  path: "PATH",
  status_code: "RESP_STATUS_CODE",
  response_time: "RESP_ROUNDTRIP_TIME",
  response_size: "RESP_LENGTH",
  source: "SOURCE",
};

function getBaseUrl(): string {
  return `http://${CAIDO_DEFAULTS.host}:${CAIDO_DEFAULTS.port}`;
}

/**
 * Execute a Caido GraphQL query by running curl on the sandbox.
 * Uses base64 to pass JSON body safely through shell without escaping issues.
 */
async function runGql(
  context: ToolContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  await ensureCaido(context);

  const { sandbox } = await context.sandboxManager.getSandbox();
  const baseUrl = getBaseUrl();

  const body = JSON.stringify({ query, variables: variables ?? {} });
  // base64-encode the body to avoid any shell escaping issues
  const bodyB64 = Buffer.from(body).toString("base64");

  const cmd =
    `TOKEN=$(cat ${CAIDO_TOKEN_FILE} 2>/dev/null || echo "")\n` +
    `echo '${bodyB64}' | base64 -d | curl -sL -X POST ${baseUrl}/graphql \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  \${TOKEN:+-H "Authorization: Bearer \${TOKEN}"} \\\n` +
    `  --connect-timeout 10 --max-time 15 \\\n` +
    `  --data @-`;

  const options = buildSandboxCommandOptions(sandbox);
  const result = await sandbox.commands.run(cmd, options);

  const stdout = result.stdout.trim();

  // Check for real curl errors (empty stdout + connection error in stderr/stdout)
  if (!stdout) {
    const msg = result.stderr || result.stdout;
    if (msg.includes("Connection refused") || msg.includes("curl: (7)")) {
      throw new Error(
        `Caido is not reachable at ${baseUrl}. Check ${CAIDO_LOG} for errors.`,
      );
    }
    throw new Error(
      `No response from Caido (exit ${result.exitCode}): ${msg || "empty output"}`,
    );
  }

  // Parse JSON — if stdout is non-empty, curl succeeded regardless of exit code
  // (some sandbox implementations return non-zero exit codes for multi-command scripts)
  const json = JSON.parse(stdout) as { data?: unknown; errors?: unknown[] };
  if (json.errors?.length) {
    const errStr = JSON.stringify(json.errors);
    // If Caido's DB is broken, invalidate the lock so the next call restarts it
    if (isCaidoBroken(errStr)) {
      void invalidateAndKillCaido(context);
    }
    throw new Error(`Caido GraphQL errors: ${errStr}`);
  }
  return json.data;
}

// ─── list_requests ────────────────────────────────────────────────────────────

export async function listRequests(
  context: ToolContext,
  opts: {
    httpqlFilter?: string;
    startPage?: number;
    endPage?: number;
    pageSize?: number;
    sortBy?: string;
    sortOrder?: string;
    scopeId?: string;
  } = {},
) {
  const {
    httpqlFilter,
    startPage = 1,
    endPage = 1,
    pageSize = 50,
    sortBy = "timestamp",
    sortOrder = "desc",
    scopeId,
  } = opts;

  const offset = (startPage - 1) * pageSize;
  const limit = (endPage - startPage + 1) * pageSize;

  const data = (await runGql(
    context,
    `query GetRequests(
      $limit: Int, $offset: Int, $filter: HTTPQL,
      $order: RequestResponseOrderInput, $scopeId: ID
    ) {
      requestsByOffset(
        limit: $limit, offset: $offset, filter: $filter,
        order: $order, scopeId: $scopeId
      ) {
        edges {
          node {
            id method host path query createdAt length isTls port
            source alteration fileExtension
            response { id statusCode length roundtripTime createdAt }
          }
        }
        count { value }
      }
    }`,
    {
      limit,
      offset,
      filter: httpqlFilter ?? null,
      order: {
        by: SORT_MAPPING[sortBy] ?? "CREATED_AT",
        ordering: sortOrder.toUpperCase(),
      },
      scopeId: scopeId ?? null,
    },
  )) as {
    requestsByOffset: { edges: { node: unknown }[]; count: { value: number } };
  };

  const nodes = data.requestsByOffset.edges.map((e) => e.node);
  return {
    requests: nodes,
    total_count: data.requestsByOffset.count?.value ?? 0,
    start_page: startPage,
    end_page: endPage,
    page_size: pageSize,
    offset,
    returned_count: nodes.length,
    sort_by: sortBy,
    sort_order: sortOrder,
  };
}

// ─── view_request ─────────────────────────────────────────────────────────────

export async function viewRequest(
  context: ToolContext,
  opts: {
    requestId: string;
    part?: "request" | "response";
    searchPattern?: string;
    page?: number;
    pageSize?: number;
  },
) {
  const {
    requestId,
    part = "request",
    searchPattern,
    page = 1,
    pageSize = 50,
  } = opts;

  const queries = {
    request: `query GetRequest($id: ID!) {
      request(id: $id) {
        id method host path query createdAt length isTls port
        source alteration edited raw
      }
    }`,
    response: `query GetRequest($id: ID!) {
      request(id: $id) {
        id response { id statusCode length roundtripTime createdAt raw }
      }
    }`,
  };

  const data = (await runGql(context, queries[part], { id: requestId })) as {
    request: Record<string, unknown> & {
      raw?: string;
      response?: Record<string, unknown> & { raw?: string };
    };
  };

  const requestData = data.request;
  if (!requestData) return { error: `Request ${requestId} not found` };

  // Decode base64 raw content
  let rawContent: string | null = null;
  if (part === "request" && requestData.raw) {
    rawContent = Buffer.from(requestData.raw as string, "base64").toString(
      "utf-8",
    );
    requestData.raw = rawContent;
  } else if (part === "response" && requestData.response?.raw) {
    rawContent = Buffer.from(
      requestData.response.raw as string,
      "base64",
    ).toString("utf-8");
    (requestData.response as Record<string, unknown>).raw = rawContent;
  }

  if (!rawContent) return { error: "No content available" };

  if (searchPattern)
    return searchContent(requestData, rawContent, searchPattern);
  return paginateContent(requestData, rawContent, page, pageSize);
}

function searchContent(
  requestData: unknown,
  content: string,
  pattern: string,
): Record<string, unknown> {
  try {
    const regex = new RegExp(pattern, "gim");
    const matches: {
      match: string;
      before: string;
      after: string;
      position: number;
    }[] = [];
    let m: RegExpExecArray | null;

    while ((m = regex.exec(content)) !== null && matches.length < 20) {
      const start = m.index;
      const end = start + m[0].length;
      matches.push({
        match: m[0],
        before: content
          .slice(Math.max(0, start - 120), start)
          .replace(/\s+/g, " ")
          .slice(-100),
        after: content
          .slice(end, end + 120)
          .replace(/\s+/g, " ")
          .slice(0, 100),
        position: start,
      });
    }

    return {
      id: (requestData as Record<string, unknown>).id,
      matches,
      total_matches: matches.length,
      search_pattern: pattern,
      truncated: matches.length >= 20,
    };
  } catch {
    return { error: `Invalid regex: ${pattern}` };
  }
}

function paginateContent(
  requestData: unknown,
  content: string,
  page: number,
  pageSize: number,
): Record<string, unknown> {
  const displayLines: string[] = [];
  for (const line of content.split("\n")) {
    if (line.length <= 80) {
      displayLines.push(line);
    } else {
      for (let i = 0; i < line.length; i += 80) {
        const chunk = line.slice(i, i + 80);
        displayLines.push(chunk + (i + 80 < line.length ? " \\" : ""));
      }
    }
  }

  const totalLines = displayLines.length;
  const totalPages = Math.max(1, Math.ceil(totalLines / pageSize));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const startLine = (clampedPage - 1) * pageSize;
  const endLine = Math.min(totalLines, startLine + pageSize);

  return {
    id: (requestData as Record<string, unknown>).id,
    content: displayLines.slice(startLine, endLine).join("\n"),
    page: clampedPage,
    total_pages: totalPages,
    showing_lines: `${startLine + 1}-${endLine} of ${totalLines}`,
    has_more: clampedPage < totalPages,
  };
}

// ─── send_request ─────────────────────────────────────────────────────────────

const INTERESTING_HEADERS = new Set([
  "content-type",
  "content-length",
  "server",
  "set-cookie",
  "location",
  "x-powered-by",
  "www-authenticate",
  "access-control-allow-origin",
]);

/**
 * Parse an HTTP response with headers (curl -i output).
 * Returns structured {status_code, headers, body, ...}.
 */
function parseHttpResponse(raw: string): {
  status_code: number;
  headers: Record<string, string>;
  body: string;
  body_truncated: boolean;
  body_size: number;
} {
  // curl -i output: HTTP/1.1 200 OK\r\nHeader: val\r\n\r\nbody
  // There may be multiple status lines (redirects with -L), take the last one
  const parts = raw.split(/\r?\n\r?\n/);

  let statusCode = 0;
  const headers: Record<string, string> = {};
  let bodyStartIdx = 0;

  // Walk through parts to find the last HTTP header block
  for (let i = 0; i < parts.length - 1; i++) {
    const section = parts[i]!;
    if (section.match(/^HTTP\/[\d.]+\s+\d+/)) {
      // This is a header section
      const lines = section.split(/\r?\n/);
      const statusMatch = lines[0]?.match(/^HTTP\/[\d.]+\s+(\d+)/);
      if (statusMatch) statusCode = parseInt(statusMatch[1]!, 10);

      // Reset headers for this response (handles redirects)
      for (const key of Object.keys(headers)) delete headers[key];
      for (let j = 1; j < lines.length; j++) {
        const colonIdx = lines[j]!.indexOf(":");
        if (colonIdx > 0) {
          const key = lines[j]!.slice(0, colonIdx).trim().toLowerCase();
          const val = lines[j]!.slice(colonIdx + 1).trim();
          if (INTERESTING_HEADERS.has(key)) {
            headers[key] = val;
          }
        }
      }
      bodyStartIdx = i + 1;
    }
  }

  const fullBody = parts.slice(bodyStartIdx).join("\n\n");
  const bodySize = fullBody.length;
  const body = truncateContent(fullBody, TRUNCATION_MESSAGE);
  const truncated = body.length < fullBody.length;

  return {
    status_code: statusCode,
    headers,
    body,
    body_truncated: truncated,
    body_size: bodySize,
  };
}

export async function sendRequest(
  context: ToolContext,
  opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  },
) {
  await ensureCaido(context);

  const { method, url, headers = {}, body = "", timeout = 30 } = opts;
  const { sandbox } = await context.sandboxManager.getSandbox();
  const proxyUrl = `http://${CAIDO_DEFAULTS.host}:${CAIDO_DEFAULTS.port}`;

  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `-H "${k}: ${v}"`)
    .join(" ");

  const bodyArg = body ? `--data-raw '${body.replace(/'/g, "'\\''")}'` : "";

  // -i includes response headers, -w appends timing metadata on a separate line
  const cmd = [
    `curl -siL --proxy ${proxyUrl} --insecure`,
    `-X ${method.toUpperCase()}`,
    headerArgs,
    bodyArg,
    `--max-time ${timeout}`,
    `-w '\n__CURL_META__{"status":%{http_code},"time_ms":%{time_total},"url_effective":"%{url_effective}"}'`,
    `"${url}"`,
  ]
    .filter(Boolean)
    .join(" ");

  const options = buildSandboxCommandOptions(sandbox);
  const result = await sandbox.commands.run(cmd, options);
  const stdout = result.stdout;

  // Extract curl metadata from the __CURL_META__ marker
  const metaIdx = stdout.lastIndexOf("__CURL_META__");
  let curlMeta = { status: 0, time_ms: 0, url_effective: url };

  if (metaIdx >= 0) {
    try {
      curlMeta = JSON.parse(
        stdout.slice(metaIdx + "__CURL_META__".length).trim(),
      );
    } catch {
      /* use defaults */
    }
  }

  const httpPart = metaIdx >= 0 ? stdout.slice(0, metaIdx) : stdout;
  const parsed = parseHttpResponse(httpPart);

  // If Caido returned its own error page instead of proxying, invalidate the lock
  // so the next call restarts it. Return the error clearly instead of the HTML page.
  if (isCaidoBroken(parsed.body)) {
    void invalidateAndKillCaido(context);
    return {
      status_code: 502,
      headers: {},
      body: "Caido proxy database error — the proxy will auto-restart on the next request. Please retry.",
      body_truncated: false,
      body_size: 0,
      response_time_ms: Math.round(curlMeta.time_ms * 1000),
      url: curlMeta.url_effective,
      message:
        "Caido proxy encountered a database error and will be restarted automatically",
    };
  }

  return {
    status_code: parsed.status_code || curlMeta.status,
    headers: parsed.headers,
    body: parsed.body,
    body_truncated: parsed.body_truncated,
    body_size: parsed.body_size,
    response_time_ms: Math.round(curlMeta.time_ms * 1000),
    url: curlMeta.url_effective,
    message:
      "Request sent through Caido proxy — check list_requests for captured traffic",
  };
}

// ─── repeat_request ───────────────────────────────────────────────────────────

export async function repeatRequest(
  context: ToolContext,
  opts: {
    requestId: string;
    modifications?: {
      url?: string;
      params?: Record<string, string>;
      headers?: Record<string, string>;
      body?: string;
      cookies?: Record<string, string>;
    };
  },
) {
  const { requestId, modifications = {} } = opts;

  // Fetch original request details
  const original = await viewRequest(context, { requestId, part: "request" });
  if ("error" in original) return original;

  const rawContent = original.content as string | undefined;
  if (!rawContent) return { error: "No raw request content found" };

  // Parse request line + headers + body
  const lines = rawContent.split("\n");
  const [reqMethod = "GET", urlPath = "/"] = (lines[0] ?? "").trim().split(" ");
  const reqHeaders: Record<string, string> = {};
  let bodyStart = lines.length;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "") {
      bodyStart = i + 1;
      break;
    }
    const colonIdx = lines[i]!.indexOf(":");
    if (colonIdx > 0) {
      reqHeaders[lines[i]!.slice(0, colonIdx).trim()] = lines[i]!.slice(
        colonIdx + 1,
      ).trim();
    }
  }

  const reqBody = lines.slice(bodyStart).join("\n").trim();
  const host = reqHeaders["Host"] ?? "";
  if (!host) return { error: "No Host header in original request" };

  const protocol = host.includes(":443") ? "https" : "http";
  let fullUrl = modifications.url ?? `${protocol}://${host}${urlPath}`;

  // Apply param modifications
  if (modifications.params) {
    const url = new URL(fullUrl);
    for (const [k, v] of Object.entries(modifications.params)) {
      url.searchParams.set(k, v);
    }
    fullUrl = url.toString();
  }

  const finalHeaders = { ...reqHeaders, ...(modifications.headers ?? {}) };

  if (modifications.cookies) {
    const cookies: Record<string, string> = {};
    if (finalHeaders["Cookie"]) {
      for (const part of finalHeaders["Cookie"].split(";")) {
        const [k, v] = part.split("=");
        if (k && v) cookies[k.trim()] = v.trim();
      }
    }
    Object.assign(cookies, modifications.cookies);
    finalHeaders["Cookie"] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  const finalBody = modifications.body ?? reqBody;
  const sendResult = await sendRequest(context, {
    method: reqMethod,
    url: fullUrl,
    headers: finalHeaders,
    body: finalBody,
  });

  return {
    ...sendResult,
    original_request_id: requestId,
    modifications_applied: modifications,
    request: {
      method: reqMethod,
      url: fullUrl,
      headers: finalHeaders,
      has_body: Boolean(finalBody),
    },
  };
}

// ─── scope_rules ──────────────────────────────────────────────────────────────

export async function scopeRules(
  context: ToolContext,
  opts: {
    action: "get" | "list" | "create" | "update" | "delete";
    allowlist?: string[];
    denylist?: string[];
    scopeId?: string;
    scopeName?: string;
  },
) {
  const { action, allowlist, denylist, scopeId, scopeName } = opts;

  switch (action) {
    case "list": {
      const data = (await runGql(
        context,
        "query { scopes { id name allowlist denylist indexed } }",
      )) as { scopes: unknown[] };
      return { scopes: data.scopes, count: data.scopes.length };
    }

    case "get": {
      if (!scopeId) {
        const data = (await runGql(
          context,
          "query { scopes { id name allowlist denylist indexed } }",
        )) as { scopes: unknown[] };
        return { scopes: data.scopes, count: data.scopes.length };
      }
      const data = (await runGql(
        context,
        "query GetScope($id: ID!) { scope(id: $id) { id name allowlist denylist indexed } }",
        { id: scopeId },
      )) as { scope: unknown };
      return data.scope
        ? { scope: data.scope }
        : { error: `Scope ${scopeId} not found` };
    }

    case "create": {
      if (!scopeName) return { error: "scope_name required for create" };
      const data = (await runGql(
        context,
        `mutation CreateScope($input: CreateScopeInput!) {
          createScope(input: $input) {
            scope { id name allowlist denylist indexed }
            error {
              ... on InvalidGlobTermsUserError { code terms }
              ... on OtherUserError { code }
            }
          }
        }`,
        {
          input: {
            name: scopeName,
            allowlist: allowlist ?? [],
            denylist: denylist ?? [],
          },
        },
      )) as { createScope: { scope: unknown; error?: unknown } };
      const payload = data.createScope;
      if (payload.error)
        return {
          error: `Invalid glob patterns: ${JSON.stringify(payload.error)}`,
        };
      return { scope: payload.scope, message: "Scope created successfully" };
    }

    case "update": {
      if (!scopeId || !scopeName)
        return { error: "scope_id and scope_name required for update" };
      const data = (await runGql(
        context,
        `mutation UpdateScope($id: ID!, $input: UpdateScopeInput!) {
          updateScope(id: $id, input: $input) {
            scope { id name allowlist denylist indexed }
            error {
              ... on InvalidGlobTermsUserError { code terms }
              ... on OtherUserError { code }
            }
          }
        }`,
        {
          id: scopeId,
          input: {
            name: scopeName,
            allowlist: allowlist ?? [],
            denylist: denylist ?? [],
          },
        },
      )) as { updateScope: { scope: unknown; error?: unknown } };
      const payload = data.updateScope;
      if (payload.error)
        return {
          error: `Invalid glob patterns: ${JSON.stringify(payload.error)}`,
        };
      return { scope: payload.scope, message: "Scope updated successfully" };
    }

    case "delete": {
      if (!scopeId) return { error: "scope_id required for delete" };
      const data = (await runGql(
        context,
        "mutation DeleteScope($id: ID!) { deleteScope(id: $id) { deletedId } }",
        { id: scopeId },
      )) as { deleteScope: { deletedId?: string } };
      const deletedId = data.deleteScope?.deletedId;
      if (!deletedId) return { error: `Failed to delete scope ${scopeId}` };
      return { message: `Scope ${scopeId} deleted`, deletedId };
    }

    default:
      return {
        error: `Unknown action: ${action}. Use get, list, create, update, or delete`,
      };
  }
}

// ─── list_sitemap ─────────────────────────────────────────────────────────────

export async function listSitemap(
  context: ToolContext,
  opts: {
    scopeId?: string;
    parentId?: string;
    depth?: "DIRECT" | "ALL";
    page?: number;
    pageSize?: number;
  } = {},
) {
  const { scopeId, parentId, depth = "DIRECT", page = 1, pageSize = 30 } = opts;

  let data: { edges: { node: unknown }[]; count: { value: number } };

  if (parentId) {
    const result = (await runGql(
      context,
      `query GetSitemapDescendants($parentId: ID!, $depth: SitemapDescendantsDepth!) {
        sitemapDescendantEntries(parentId: $parentId, depth: $depth) {
          edges { node {
            id kind label hasDescendants
            request { method path response { statusCode } }
          } }
          count { value }
        }
      }`,
      { parentId, depth },
    )) as { sitemapDescendantEntries: typeof data };
    data = result.sitemapDescendantEntries;
  } else {
    const result = (await runGql(
      context,
      `query GetSitemapRoots($scopeId: ID) {
        sitemapRootEntries(scopeId: $scopeId) {
          edges { node {
            id kind label hasDescendants
            metadata { ... on SitemapEntryMetadataDomain { isTls port } }
            request { method path response { statusCode } }
          } }
          count { value }
        }
      }`,
      { scopeId: scopeId ?? null },
    )) as { sitemapRootEntries: typeof data };
    data = result.sitemapRootEntries;
  }

  const allNodes = data.edges.map((e) => e.node) as Record<string, unknown>[];
  const totalCount = data.count?.value ?? 0;
  const skipCount = (page - 1) * pageSize;
  const pageNodes = allNodes.slice(skipCount, skipCount + pageSize);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return {
    entries: pageNodes.map(cleanSitemapNode),
    page,
    page_size: pageSize,
    total_pages: totalPages,
    total_count: totalCount,
    has_more: page < totalPages,
    showing: `${skipCount + 1}-${Math.min(skipCount + pageSize, totalCount)} of ${totalCount}`,
  };
}

/** Strip null/empty fields from sitemap nodes to save tokens. Matches Strix's cleaning. */
function cleanSitemapNode(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {
    id: node.id,
    kind: node.kind,
    label: node.label,
    hasDescendants: node.hasDescendants,
  };

  const meta = node.metadata as Record<string, unknown> | null;
  if (meta && (meta.isTls != null || meta.port != null)) {
    cleaned.metadata = meta;
  }

  const req = node.request as Record<string, unknown> | null;
  if (req) {
    const cleanReq: Record<string, unknown> = {};
    if (req.method) cleanReq.method = req.method;
    if (req.path) cleanReq.path = req.path;
    const resp = req.response as Record<string, unknown> | null;
    if (resp?.statusCode) cleanReq.status = resp.statusCode;
    if (Object.keys(cleanReq).length) cleaned.request = cleanReq;
  }

  return cleaned;
}

// ─── view_sitemap_entry ───────────────────────────────────────────────────────

export async function viewSitemapEntry(context: ToolContext, entryId: string) {
  const data = (await runGql(
    context,
    `query GetSitemapEntry($id: ID!) {
      sitemapEntry(id: $id) {
        id kind label hasDescendants
        metadata { ... on SitemapEntryMetadataDomain { isTls port } }
        request { method path response { statusCode length roundtripTime } }
        requests(first: 30, order: {by: CREATED_AT, ordering: DESC}) {
          edges { node { method path response { statusCode length } } }
          count { value }
        }
      }
    }`,
    { id: entryId },
  )) as { sitemapEntry: unknown };

  if (!data.sitemapEntry)
    return { error: `Sitemap entry ${entryId} not found` };

  const entry = data.sitemapEntry as Record<string, unknown>;
  const cleaned = cleanSitemapNode(entry);

  // Primary request with response details
  const req = entry.request as Record<string, unknown> | null;
  if (req) {
    const cleanReq: Record<string, unknown> = {};
    if (req.method) cleanReq.method = req.method;
    if (req.path) cleanReq.path = req.path;
    const resp = req.response as Record<string, unknown> | null;
    if (resp) {
      const cleanResp: Record<string, unknown> = {};
      if (resp.statusCode) cleanResp.status = resp.statusCode;
      if (resp.length) cleanResp.size = resp.length;
      if (resp.roundtripTime) cleanResp.time_ms = resp.roundtripTime;
      if (Object.keys(cleanResp).length) cleanReq.response = cleanResp;
    }
    if (Object.keys(cleanReq).length) cleaned.request = cleanReq;
  }

  // Related requests
  const requestsData = entry.requests as {
    edges: { node: Record<string, unknown> }[];
    count?: { value: number };
  } | null;
  if (requestsData) {
    const requestNodes = requestsData.edges
      .map((e) => {
        const n = e.node;
        const r: Record<string, unknown> = {};
        if (n.method) r.method = n.method;
        if (n.path) r.path = n.path;
        const resp = n.response as Record<string, unknown> | null;
        if (resp?.statusCode) r.status = resp.statusCode;
        if (resp?.length) r.size = resp.length;
        return r;
      })
      .filter((r) => Object.keys(r).length > 0);

    cleaned.related_requests = {
      requests: requestNodes,
      total_count: requestsData.count?.value ?? 0,
      showing: `Latest ${requestNodes.length} requests`,
    };
  }

  return { entry: cleaned };
}
