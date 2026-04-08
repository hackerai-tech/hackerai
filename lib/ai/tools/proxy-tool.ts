import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import {
  listRequests,
  viewRequest,
  sendRequest,
  scopeRules,
  listSitemap,
  viewSitemapEntry,
} from "./utils/proxy-manager";

export const createListRequestsTool = (context: ToolContext) =>
  tool({
    description: `List and filter intercepted HTTP requests using HTTPQL with pagination.

HTTPQL filter syntax:
  Integer fields (port, code, roundtrip, id) - eq, gt, gte, lt, lte, ne:
    resp.code.eq:200, resp.code.gte:400, req.port.eq:443
  Text/byte fields (ext, host, method, path, query, raw) - regex (values MUST be in double quotes):
    req.method.regex:"POST", req.path.regex:"/api/.*", req.host.regex:"example.com"
  Date fields (created_at) - gt, lt with ISO formats:
    req.created_at.gt:"2024-01-01T00:00:00Z"
  Special: source:intercept, preset:"name"
  Combine with AND/OR: req.method.regex:"POST" AND req.path.regex:"/api/"`,
    inputSchema: z.object({
      httpql_filter: z.string().optional().describe("HTTPQL filter expression"),
      start_page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Starting page (1-based, default 1)"),
      end_page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Ending page (1-based, inclusive, default 1)"),
      page_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Requests per page (default 50)"),
      sort_by: z
        .enum([
          "timestamp",
          "host",
          "status_code",
          "response_time",
          "response_size",
        ])
        .optional()
        .describe("Sort field"),
      sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      scope_id: z
        .string()
        .optional()
        .describe(
          "Scope ID to filter requests (use scope_rules to manage scopes)",
        ),
      explanation: z.string().describe("Why this action is being taken"),
    }),
    execute: async ({
      httpql_filter,
      start_page,
      end_page,
      page_size,
      sort_by,
      sort_order,
      scope_id,
    }) => {
      try {
        const result = await listRequests(context, {
          httpqlFilter: httpql_filter,
          startPage: start_page,
          endPage: end_page,
          pageSize: page_size,
          sortBy: sort_by,
          sortOrder: sort_order,
          scopeId: scope_id,
        });
        return { result };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });

export const createViewRequestTool = (context: ToolContext) =>
  tool({
    description: `View full request/response data for a specific proxy request with optional search and pagination.

Use list_requests first to find request IDs. Default part is "request" — use part="response" to inspect server responses.

Search patterns (regex):
  API endpoints: /api/[a-zA-Z0-9._/-]+
  URLs: https?://[^\\s<>"']+
  Parameters: [?&][a-zA-Z0-9_]+=([^&\\s<>"']+)
  Reflections: search for input values in response content`,
    inputSchema: z.object({
      request_id: z.string().describe("Request ID to view"),
      part: z
        .enum(["request", "response"])
        .optional()
        .describe("Which part to return (default: request)"),
      search_pattern: z
        .string()
        .optional()
        .describe("Regex pattern to search within content"),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Page number for pagination"),
      page_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Lines per page"),
      explanation: z.string().describe("Why this action is being taken"),
    }),
    execute: async ({ request_id, part, search_pattern, page, page_size }) => {
      try {
        const result = await viewRequest(context, {
          requestId: request_id,
          part,
          searchPattern: search_pattern,
          page,
          pageSize: page_size,
        });
        return { result };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });

export const createSendRequestTool = (context: ToolContext) =>
  tool({
    description: `Send an HTTP request through the proxy. Traffic is captured automatically for replay/inspection.

Prefer this over curl in terminal.`,
    inputSchema: z.object({
      method: z.string().describe("HTTP method (GET, POST, PUT, DELETE, etc.)"),
      url: z.string().describe("Target URL"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Headers as {"key": "value"}'),
      body: z.string().optional().describe("Request body"),
      timeout: z
        .number()
        .optional()
        .describe("Request timeout in seconds (default 30)"),
      explanation: z.string().describe("Why this action is being taken"),
    }),
    execute: async ({ method, url, headers, body, timeout }) => {
      try {
        const result = await sendRequest(context, {
          method,
          url,
          headers,
          body,
          timeout,
        });
        return { result };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });

export const createScopeRulesTool = (context: ToolContext) =>
  tool({
    description: `Manage proxy scope rules for domain/path filtering.

Create a scope early to filter noise from irrelevant domains (static assets, CDNs, third-party scripts).

Actions: get (by ID), list (all), create, update (requires scope_id + scope_name), delete (requires scope_id).

Glob patterns: * (any), ? (single char), [abc] (one of), [a-z] (range), [^abc] (none of).
Empty allowlist = allow all. Denylist overrides allowlist.`,
    inputSchema: z.object({
      action: z
        .enum(["get", "list", "create", "update", "delete"])
        .describe("Scope operation"),
      allowlist: z
        .array(z.string())
        .optional()
        .describe('Domain patterns to include, e.g. ["*.example.com"]'),
      denylist: z
        .array(z.string())
        .optional()
        .describe(
          'Patterns to exclude, e.g. ["*.gif", "*.jpg", "*.png", "*.css", "*.js"]',
        ),
      scope_id: z
        .string()
        .optional()
        .describe("Scope ID (required for get, update, delete)"),
      scope_name: z
        .string()
        .optional()
        .describe("Scope name (required for create, update)"),
      explanation: z.string().describe("Why this action is being taken"),
    }),
    execute: async ({ action, allowlist, denylist, scope_id, scope_name }) => {
      try {
        const result = await scopeRules(context, {
          action,
          allowlist,
          denylist,
          scopeId: scope_id,
          scopeName: scope_name,
        });
        return { result };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });

export const createListSitemapTool = (context: ToolContext) =>
  tool({
    description: `Browse the hierarchical sitemap of discovered hosts and paths from proxied traffic.

Start with no parent_id for root domains, then drill into entries where hasDescendants=true.
Entry kinds: DOMAIN, DIRECTORY, REQUEST, REQUEST_BODY (POST variations), REQUEST_QUERY (GET parameter variations).`,
    inputSchema: z.object({
      scope_id: z.string().optional().describe("Scope ID to filter entries"),
      parent_id: z
        .string()
        .optional()
        .describe(
          "Parent entry ID to list descendants (omit for root domains)",
        ),
      depth: z
        .enum(["DIRECT", "ALL"])
        .optional()
        .describe(
          "DIRECT: immediate children, ALL: recursive (default DIRECT)",
        ),
      page: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Page number (30 entries per page)"),
      page_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Entries per page"),
      explanation: z.string().describe("Why this action is being taken"),
    }),
    execute: async ({ scope_id, parent_id, depth, page, page_size }) => {
      try {
        const result = await listSitemap(context, {
          scopeId: scope_id,
          parentId: parent_id,
          depth,
          page,
          pageSize: page_size,
        });
        return { result };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });

export const createViewSitemapEntryTool = (context: ToolContext) =>
  tool({
    description: `Get detailed information about a specific sitemap entry including all related requests and response codes.

Shows all HTTP methods and status codes for an endpoint — useful for finding hidden methods or parameter variations.`,
    inputSchema: z.object({
      entry_id: z.string().describe("Sitemap entry ID to examine"),
      explanation: z.string().describe("Why this action is being taken"),
    }),
    execute: async ({ entry_id }) => {
      try {
        const result = await viewSitemapEntry(context, entry_id);
        return { result };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });

export const createProxyTools = (context: ToolContext) => ({
  list_requests: createListRequestsTool(context),
  view_request: createViewRequestTool(context),
  send_request: createSendRequestTool(context),
  scope_rules: createScopeRulesTool(context),
  list_sitemap: createListSitemapTool(context),
  view_sitemap_entry: createViewSitemapEntryTool(context),
});
