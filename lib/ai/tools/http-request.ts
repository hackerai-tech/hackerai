import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { ToolContext } from "@/types";
import { truncateContent } from "@/lib/token-utils";
import { waitForSandboxReady } from "./utils/sandbox-health";
import { sanitizeExternalResponse } from "@/lib/utils/prompt-injection-protection";
import {
  parseScopeExclusions,
  checkUrlScopeExclusion,
} from "./utils/scope-exclusions";

// Maximum response size in bytes before truncation
const MAX_RESPONSE_SIZE = 500_000; // 500KB

/**
 * Escape a string for safe use in shell single quotes.
 * Single quotes in shell cannot contain single quotes, so we close the quote,
 * add an escaped single quote, and reopen the quote.
 */
const shellEscape = (str: string): string => {
  return `'${str.replace(/'/g, "'\\''")}'`;
};

/**
 * Parse curl's verbose output to extract timing and other metadata.
 */
const parseCurlOutput = (
  stdout: string,
  stderr: string,
): {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  timing: { total: number; connect: number; ttfb: number } | null;
  finalUrl: string | null;
  error: string | null;
} => {
  const result: ReturnType<typeof parseCurlOutput> = {
    statusCode: null,
    headers: {},
    body: "",
    timing: null,
    finalUrl: null,
    error: null,
  };

  // Parse timing info from stderr (curl -w output goes to stderr when using -o)
  const timingMatch = stderr.match(
    /TIMING:(\d+\.?\d*):(\d+\.?\d*):(\d+\.?\d*)/,
  );
  if (timingMatch) {
    result.timing = {
      total: parseFloat(timingMatch[1]),
      connect: parseFloat(timingMatch[2]),
      ttfb: parseFloat(timingMatch[3]),
    };
  }

  // Parse final URL from stderr
  const urlMatch = stderr.match(/FINAL_URL:(.+)/);
  if (urlMatch) {
    result.finalUrl = urlMatch[1].trim();
  }

  // The stdout contains headers and body separated by \r\n\r\n
  const headerBodySplit = stdout.indexOf("\r\n\r\n");
  if (headerBodySplit === -1) {
    // Try with just \n\n
    const altSplit = stdout.indexOf("\n\n");
    if (altSplit === -1) {
      // No headers found, treat entire output as body
      result.body = stdout;
      return result;
    }
    const headersPart = stdout.slice(0, altSplit);
    result.body = stdout.slice(altSplit + 2);
    parseHeaders(headersPart, result);
  } else {
    const headersPart = stdout.slice(0, headerBodySplit);
    result.body = stdout.slice(headerBodySplit + 4);
    parseHeaders(headersPart, result);
  }

  // Check for curl errors in stderr
  if (stderr.includes("curl:")) {
    const errorMatch = stderr.match(/curl: \(\d+\) (.+)/);
    if (errorMatch) {
      result.error = errorMatch[1];
    }
  }

  return result;
};

/**
 * Parse HTTP headers from the response.
 */
const parseHeaders = (
  headersPart: string,
  result: { statusCode: number | null; headers: Record<string, string> },
): void => {
  const lines = headersPart.split(/\r?\n/);

  for (const line of lines) {
    // Parse status line (HTTP/1.1 200 OK)
    const statusMatch = line.match(/^HTTP\/[\d.]+\s+(\d+)/);
    if (statusMatch) {
      result.statusCode = parseInt(statusMatch[1], 10);
      continue;
    }

    // Parse header lines
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const name = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();
      result.headers[name] = value;
    }
  }
};

/**
 * Try to parse and format JSON.
 */
const tryParseJson = (
  text: string,
): { parsed: unknown; formatted: string } | null => {
  try {
    const parsed = JSON.parse(text);
    return { parsed, formatted: JSON.stringify(parsed, null, 2) };
  } catch {
    return null;
  }
};

export const createHttpRequest = (context: ToolContext) => {
  const { sandboxManager, writer, scopeExclusions } = context;
  const exclusionsList = parseScopeExclusions(scopeExclusions || "");

  return tool({
    description: `Make an HTTP request to a target URL for web application testing.
Executes in the sandbox environment using curl for network isolation and security.
Supports all HTTP methods, custom headers, cookies, request body, and redirect handling.
Use this for API testing, web reconnaissance, authentication testing, and manual exploitation.
Returns full response details including status code, headers, and body.

Key features:
- Supports GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS methods
- Custom headers and cookies
- JSON body, form data, or raw body content
- Configurable redirect following
- Timeout configuration (default: 30 seconds)
- SSL verification toggle (default: disabled for testing)
- Basic auth support
- Proxy support (e.g., for Burp Suite interception)

Common use cases:
- API endpoint testing and fuzzing
- Authentication bypass attempts
- CORS and header analysis
- Cookie manipulation testing
- Request/response analysis
- Traffic interception via proxy

Examples:
- Simple GET: { "url": "https://target.com/api/users", "method": "GET" }
- POST with JSON: { "url": "https://target.com/api/login", "method": "POST", "json_body": { "username": "admin", "password": "test" } }
- With custom headers: { "url": "https://target.com/admin", "method": "GET", "headers": { "Authorization": "Bearer token123" } }
- Through Burp proxy: { "url": "https://target.com/api", "method": "GET", "proxy": "http://127.0.0.1:8080" }`,
    inputSchema: z.object({
      url: z
        .string()
        .describe("Target URL (must include scheme, e.g., https://)"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
        .describe("HTTP method to use. Defaults to GET if not specified."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Custom HTTP headers as key-value pairs"),
      cookies: z
        .record(z.string(), z.string())
        .optional()
        .describe("Cookies to send with the request"),
      body: z
        .string()
        .optional()
        .describe(
          "Request body (for POST, PUT, PATCH). Can be raw string, JSON, or form data.",
        ),
      json_body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "JSON request body (automatically sets Content-Type to application/json)",
        ),
      form_data: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Form data to send (automatically sets Content-Type to application/x-www-form-urlencoded)",
        ),
      follow_redirects: z
        .boolean()
        .optional()
        .describe("Whether to follow HTTP redirects. Defaults to true."),
      timeout: z
        .number()
        .optional()
        .describe("Request timeout in seconds (1-300). Defaults to 30."),
      verify_ssl: z
        .boolean()
        .optional()
        .describe(
          "Whether to verify SSL certificates. Defaults to false for testing.",
        ),
      proxy: z
        .string()
        .optional()
        .describe(
          "Proxy URL (e.g., http://127.0.0.1:8080 for Burp Suite interception)",
        ),
      auth: z
        .object({
          username: z.string(),
          password: z.string(),
        })
        .optional()
        .describe("HTTP Basic Auth credentials"),
    }),
    execute: async (
      args: {
        url: string;
        method?:
          | "GET"
          | "POST"
          | "PUT"
          | "DELETE"
          | "PATCH"
          | "HEAD"
          | "OPTIONS";
        headers?: Record<string, string>;
        cookies?: Record<string, string>;
        body?: string;
        json_body?: Record<string, unknown>;
        form_data?: Record<string, string>;
        follow_redirects?: boolean;
        timeout?: number;
        verify_ssl?: boolean;
        proxy?: string;
        auth?: { username: string; password: string };
      },
      { toolCallId, abortSignal },
    ) => {
      // Apply defaults
      const url = args.url;
      const method = args.method ?? "GET";
      const headers = args.headers ?? {};
      const cookies = args.cookies;
      const body = args.body;
      const json_body = args.json_body;
      const form_data = args.form_data;
      const follow_redirects = args.follow_redirects ?? true;
      const timeout = Math.min(Math.max(args.timeout ?? 30, 1), 300);
      const verify_ssl = args.verify_ssl ?? false;
      const proxy = args.proxy;
      const auth = args.auth;

      // Validate body parameters - only one should be provided
      const bodyParamsProvided = [
        body !== undefined,
        json_body !== undefined,
        form_data !== undefined,
      ].filter(Boolean).length;
      if (bodyParamsProvided > 1) {
        return {
          success: false,
          output: "",
          error:
            "Only one of 'body', 'json_body', or 'form_data' can be provided at a time.",
        };
      }

      // Validate URL
      try {
        const parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return {
            success: false,
            output: "",
            error: `Invalid URL scheme: ${parsedUrl.protocol}. URL must use http:// or https://`,
          };
        }
      } catch {
        return {
          success: false,
          output: "",
          error: `Invalid URL: ${url}. URL must include scheme (http:// or https://)`,
        };
      }

      // Check scope exclusions
      const excludedPattern = checkUrlScopeExclusion(url, exclusionsList);
      if (excludedPattern) {
        return {
          success: false,
          output: "",
          error: `Target is out of scope. The URL matches the scope exclusion pattern: ${excludedPattern}. This target has been excluded from testing by the user's scope configuration.`,
        };
      }

      // Build curl command
      const curlArgs: string[] = ["curl", "-s", "-i"]; // Silent mode, include headers

      // Method
      curlArgs.push("-X", method);

      // Timeout
      curlArgs.push("--max-time", timeout.toString());
      curlArgs.push("--connect-timeout", Math.min(timeout, 10).toString());

      // SSL verification
      if (!verify_ssl) {
        curlArgs.push("-k"); // Insecure mode
      }

      // Follow redirects
      if (follow_redirects) {
        curlArgs.push("-L");
        curlArgs.push("--max-redirs", "10");
      }

      // Normalize headers to lowercase keys for case-insensitive checking
      const normalizedHeaders = new Map<string, string>();
      for (const [name, value] of Object.entries(headers)) {
        normalizedHeaders.set(name.toLowerCase(), value);
      }

      // Prepare headers to add, removing conflicts
      const headersToAdd: Record<string, string> = { ...headers };

      // Remove Content-Type if we'll set it automatically via json_body or form_data
      if (json_body || form_data) {
        for (const key of Object.keys(headersToAdd)) {
          if (key.toLowerCase() === "content-type") {
            delete headersToAdd[key];
          }
        }
      }

      // Remove Cookie header if cookies parameter is provided (prefer parameter)
      if (cookies && Object.keys(cookies).length > 0) {
        for (const key of Object.keys(headersToAdd)) {
          if (key.toLowerCase() === "cookie") {
            delete headersToAdd[key];
          }
        }
      }

      // Add default User-Agent if not provided (check case-insensitively)
      if (!normalizedHeaders.has("user-agent")) {
        headersToAdd["User-Agent"] = "HackerAI/1.0 (Security Assessment)";
      }

      // Add headers
      for (const [name, value] of Object.entries(headersToAdd)) {
        curlArgs.push("-H", `${name}: ${value}`);
      }

      // Add cookies (parameter takes precedence over header)
      if (cookies && Object.keys(cookies).length > 0) {
        const cookieString = Object.entries(cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
        curlArgs.push("-H", `Cookie: ${cookieString}`);
      }

      // Basic auth
      if (auth) {
        curlArgs.push("-u", `${auth.username}:${auth.password}`);
      }

      // Proxy
      if (proxy) {
        curlArgs.push("-x", proxy);
      }

      // Request body
      if (json_body) {
        curlArgs.push("-H", "Content-Type: application/json");
        curlArgs.push("-d", JSON.stringify(json_body));
      } else if (form_data) {
        curlArgs.push("-H", "Content-Type: application/x-www-form-urlencoded");
        const formString = new URLSearchParams(form_data).toString();
        curlArgs.push("-d", formString);
      } else if (body) {
        curlArgs.push("-d", body);
      }

      // Add timing and final URL output format
      // Use a custom format that we can parse from stderr
      curlArgs.push(
        "-w",
        "\\nTIMING:%{time_total}:%{time_connect}:%{time_starttransfer}\\nFINAL_URL:%{url_effective}",
      );

      // URL (must be last)
      curlArgs.push(url);

      // Build the command string with proper escaping
      const command = curlArgs
        .map((arg, index) => {
          // First argument (curl) doesn't need escaping
          if (index === 0) return arg;
          // Escape arguments that might contain special characters
          if (
            arg.includes(" ") ||
            arg.includes("'") ||
            arg.includes('"') ||
            arg.includes("$") ||
            arg.includes("`") ||
            arg.includes("\\") ||
            arg.includes("\n") ||
            arg.includes(";") ||
            arg.includes("&") ||
            arg.includes("|") ||
            arg.includes("<") ||
            arg.includes(">")
          ) {
            return shellEscape(arg);
          }
          return arg;
        })
        .join(" ");

      try {
        // Get sandbox and verify it's ready
        const { sandbox } = await sandboxManager.getSandbox();

        try {
          await waitForSandboxReady(sandbox);
        } catch (healthError) {
          console.warn(
            "[HTTP Request] Sandbox health check failed, recreating sandbox",
          );
          sandboxManager.setSandbox(null as any);
          const { sandbox: freshSandbox } = await sandboxManager.getSandbox();
          await waitForSandboxReady(freshSandbox);
          return executeInSandbox(freshSandbox);
        }

        return executeInSandbox(sandbox);

        async function executeInSandbox(sandboxInstance: typeof sandbox) {
          const terminalSessionId = `http-${randomUUID()}`;
          let outputCounter = 0;

          // Stream terminal output to frontend
          const createTerminalWriter = (output: string) => {
            writer.write({
              type: "data-terminal",
              id: `${terminalSessionId}-${++outputCounter}`,
              data: { terminal: output, toolCallId },
            });
          };

          return new Promise((resolve) => {
            let resolved = false;

            // Handle abort
            const onAbort = () => {
              if (resolved) return;
              resolved = true;
              resolve({
                success: false,
                output: "",
                error: "Request aborted by user",
                metadata: { url },
              });
            };

            if (abortSignal?.aborted) {
              return resolve({
                success: false,
                output: "",
                error: "Request aborted by user",
                metadata: { url },
              });
            }

            abortSignal?.addEventListener("abort", onAbort, { once: true });

            // Collect output
            let stdout = "";
            let stderr = "";

            // Execute curl command in sandbox
            sandboxInstance.commands
              .run(command, {
                timeoutMs: (timeout + 5) * 1000, // Add buffer for curl overhead
                user: "user" as const,
                onStdout: (data: string) => {
                  stdout += data;
                },
                onStderr: (data: string) => {
                  stderr += data;
                },
              })
              .then(
                (result: {
                  stdout: string;
                  stderr: string;
                  exitCode: number;
                }) => {
                  if (resolved) return;
                  resolved = true;
                  abortSignal?.removeEventListener("abort", onAbort);

                  // Parse curl output
                  const parsed = parseCurlOutput(stdout, stderr);

                  // Build output
                  const outputParts: string[] = [];

                  if (parsed.error) {
                    createTerminalWriter(`Error: ${parsed.error}\n`);
                    resolve({
                      success: false,
                      output: "",
                      error: parsed.error,
                      metadata: { url },
                    });
                    return;
                  }

                  // Status line
                  const statusText = getStatusText(parsed.statusCode || 0);
                  outputParts.push(
                    `Status: ${parsed.statusCode} ${statusText}`,
                  );

                  // URL (with redirect info)
                  if (parsed.finalUrl && parsed.finalUrl !== url) {
                    outputParts.push(
                      `URL: ${parsed.finalUrl} (redirected from ${url})`,
                    );
                  } else {
                    outputParts.push(`URL: ${url}`);
                  }

                  // Timing
                  if (parsed.timing) {
                    outputParts.push(
                      `Time: ${parsed.timing.total.toFixed(2)}s`,
                    );
                  }

                  outputParts.push("");
                  outputParts.push("Response Headers:");

                  // Format headers
                  for (const [name, value] of Object.entries(parsed.headers)) {
                    outputParts.push(`  ${name}: ${value}`);
                  }

                  outputParts.push("");

                  // Handle body
                  let responseBody = parsed.body;
                  let wasTruncated = false;
                  const originalSize = responseBody.length;

                  if (originalSize > MAX_RESPONSE_SIZE) {
                    wasTruncated = true;
                    responseBody = responseBody.slice(0, MAX_RESPONSE_SIZE);
                    outputParts.push(
                      `\nWARNING: Response truncated from ${originalSize.toLocaleString()} to ${MAX_RESPONSE_SIZE.toLocaleString()} bytes.`,
                    );
                  }

                  // Format body based on content type
                  const contentType = parsed.headers["content-type"] || "";

                  if (parsed.statusCode === 204 || method === "HEAD") {
                    outputParts.push("Body: (No Content)");
                  } else if (contentType.includes("application/json")) {
                    const jsonResult = tryParseJson(responseBody);
                    if (jsonResult) {
                      let formatted = jsonResult.formatted;
                      if (wasTruncated) {
                        formatted += "\n[TRUNCATED]";
                      }
                      outputParts.push(`Body (JSON):\n${formatted}`);
                    } else {
                      outputParts.push(`Body:\n${responseBody}`);
                    }
                  } else {
                    outputParts.push(`Body:\n${responseBody}`);
                  }

                  // Build metadata
                  const metadata: Record<string, unknown> = {
                    status_code: parsed.statusCode,
                    url: parsed.finalUrl || url,
                    content_type: contentType,
                    content_length: originalSize,
                    redirected: parsed.finalUrl !== url,
                    elapsed_time: parsed.timing?.total,
                    truncated: wasTruncated,
                    exit_code: result.exitCode,
                  };

                  // Detect security indicators
                  const securityIndicators: string[] = [];
                  const serverHeader = (
                    parsed.headers["server"] || ""
                  ).toLowerCase();

                  if (serverHeader.includes("cloudflare")) {
                    securityIndicators.push("Cloudflare detected");
                    metadata["waf_detected"] = "cloudflare";
                  }
                  if (
                    serverHeader.includes("akamai") ||
                    parsed.headers["x-akamai-request-id"]
                  ) {
                    securityIndicators.push("Akamai detected");
                    metadata["cdn_detected"] = "akamai";
                  }
                  if (parsed.headers["x-aws-waf-id"]) {
                    securityIndicators.push("AWS WAF detected");
                    metadata["waf_detected"] = "aws-waf";
                  }

                  // Check security headers
                  const securityHeaders = [
                    "content-security-policy",
                    "x-frame-options",
                    "x-content-type-options",
                    "strict-transport-security",
                    "x-xss-protection",
                  ];
                  const presentSecurityHeaders = securityHeaders.filter(
                    (h) => parsed.headers[h],
                  );
                  if (presentSecurityHeaders.length > 0) {
                    metadata["security_headers"] = presentSecurityHeaders;
                  }

                  if (securityIndicators.length > 0) {
                    outputParts.unshift(
                      `[Security] ${securityIndicators.join("; ")}`,
                    );
                  }

                  let output = outputParts.join("\n");

                  // Apply token-based truncation
                  output = truncateContent(output);

                  // Sanitize external response
                  output = sanitizeExternalResponse(
                    output,
                    `HTTP ${method} ${url}`,
                  );

                  // Show summary in terminal
                  createTerminalWriter(
                    `${parsed.statusCode} ${statusText} (${parsed.timing?.total.toFixed(2) || "?"}s)\n`,
                  );

                  resolve({
                    success: true,
                    output,
                    metadata,
                    http_success:
                      (parsed.statusCode || 0) >= 200 &&
                      (parsed.statusCode || 0) < 400,
                  });
                },
              )
              .catch((error: unknown) => {
                if (resolved) return;
                resolved = true;
                abortSignal?.removeEventListener("abort", onAbort);

                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                createTerminalWriter(`Error: ${errorMessage}\n`);

                resolve({
                  success: false,
                  output: "",
                  error: `HTTP request failed: ${errorMessage}`,
                  metadata: { url },
                });
              });
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          success: false,
          output: "",
          error: `Failed to execute HTTP request: ${errorMessage}`,
          metadata: { url },
        };
      }
    },
  });
};

/**
 * Get HTTP status text for common status codes.
 */
const getStatusText = (code: number): string => {
  const statusTexts: Record<number, string> = {
    100: "Continue",
    101: "Switching Protocols",
    200: "OK",
    201: "Created",
    202: "Accepted",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    304: "Not Modified",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    406: "Not Acceptable",
    408: "Request Timeout",
    409: "Conflict",
    410: "Gone",
    415: "Unsupported Media Type",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return statusTexts[code] || "";
};
