import React, { useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { Radar } from "lucide-react";
import type { ChatStatus, SidebarProxy } from "@/types/chat";
import { isSidebarProxy } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";

interface ProxyToolHandlerProps {
  part: any;
  status: ChatStatus;
  /** The tool name without "tool-" prefix, e.g. "list_requests" */
  toolName: string;
}

export const PROXY_ACTION_LABELS: Record<string, string> = {
  list_requests: "Listing requests",
  view_request: "Viewing request",
  send_request: "Sending request",
  scope_rules: "Managing scope rules",
  list_sitemap: "Listing sitemap",
  view_sitemap_entry: "Viewing sitemap entry",
};

export const PROXY_COMPLETED_LABELS: Record<string, string> = {
  list_requests: "Listed requests",
  view_request: "Viewed request",
  send_request: "Sent request",
  scope_rules: "Managed scope rules",
  list_sitemap: "Listed sitemap",
  view_sitemap_entry: "Viewed sitemap entry",
};

// ---------------------------------------------------------------------------
// Output formatters — produce clean plain text for the sidebar code block
// ---------------------------------------------------------------------------

function padRight(str: string, len: number): string {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}

function formatListRequests(r: any): string {
  const requests = r.requests ?? [];
  if (!requests.length) return "No requests captured.";

  const lines: string[] = [
    `${r.total_count} request${r.total_count !== 1 ? "s" : ""} (showing ${r.returned_count})`,
    "",
    `${"ID".padEnd(6)} ${"METHOD".padEnd(7)} ${"STATUS".padEnd(7)} ${"HOST".padEnd(30)} PATH`,
    `${"------"} ${"-------"} ${"------"} ${"------------------------------"} ----`,
  ];

  for (const req of requests) {
    const resp = req.response;
    const status = resp?.statusCode
      ? String(resp.statusCode).padEnd(7)
      : "---    ";
    const time = resp?.roundtripTime ? `${resp.roundtripTime}ms` : "";
    const id = String(req.id ?? "").padEnd(6);
    const method = padRight(req.method ?? "?", 7);
    const host = padRight(req.host ?? "", 30);
    const path = req.path ?? "/";
    lines.push(
      `${id} ${method} ${status} ${host} ${path}${time ? "  " + time : ""}`,
    );
  }

  return lines.join("\n");
}

function formatViewRequest(r: any): string {
  if (r.matches) {
    const lines: string[] = [
      `${r.total_matches} match${r.total_matches !== 1 ? "es" : ""} for "${r.search_pattern}"${r.truncated ? " (truncated)" : ""}`,
      "",
    ];
    for (const m of r.matches) {
      lines.push(`...${m.before}>>>${m.match}<<<${m.after}...`);
    }
    return lines.join("\n");
  }

  const header = r.has_more
    ? `[Lines ${r.showing_lines}, page ${r.page}/${r.total_pages}]\n\n`
    : "";
  return header + (r.content ?? "");
}

function formatSendRequest(r: any): string {
  const lines: string[] = [];

  const code = r.status_code ?? 0;
  lines.push(`HTTP ${code}  ${r.response_time_ms ?? 0}ms  ${r.url ?? ""}`);

  const headers = r.headers ?? {};
  if (Object.keys(headers).length) {
    lines.push("");
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`${k}: ${v}`);
    }
  }

  if (r.body) {
    lines.push("");
    lines.push(r.body);
    if (r.body_truncated) {
      lines.push(`\n(truncated -- ${r.body_size} bytes total)`);
    }
  }

  return lines.join("\n");
}

function formatScopeRules(r: any): string {
  if (r.scope) {
    const s = r.scope;
    const lines = [`${s.name}  (id:${s.id})`];
    if (s.allowlist?.length) lines.push(`  allow: ${s.allowlist.join(", ")}`);
    if (s.denylist?.length) lines.push(`  deny:  ${s.denylist.join(", ")}`);
    if (r.message) lines.push(`\n${r.message}`);
    return lines.join("\n");
  }

  if (r.scopes) {
    if (!r.scopes.length) return "No scopes defined.";
    const lines = [`${r.count} scope${r.count !== 1 ? "s" : ""}`, ""];
    for (const s of r.scopes) {
      const allow = s.allowlist?.length ? s.allowlist.join(", ") : "*";
      lines.push(`  ${s.name} (${s.id})  allow: ${allow}`);
    }
    return lines.join("\n");
  }

  if (r.message) return r.message;
  return JSON.stringify(r, null, 2);
}

function formatListSitemap(r: any): string {
  const entries = r.entries ?? [];
  if (!entries.length) return "No sitemap entries.";

  const lines: string[] = [
    `${r.total_count} entr${r.total_count !== 1 ? "ies" : "y"} (${r.showing})`,
    "",
  ];

  for (const e of entries) {
    const kind = e.kind === "DOMAIN" ? "[D]" : e.hasDescendants ? " > " : "   ";
    const status = e.request?.status ? `  ${e.request.status}` : "";
    const method = e.request?.method ? `${e.request.method} ` : "";
    const meta = e.metadata
      ? `  (${e.metadata.isTls ? "https" : "http"}:${e.metadata.port})`
      : "";
    lines.push(
      `${kind} ${String(e.id).padEnd(4)} ${method}${e.label}${meta}${status}`,
    );
  }

  return lines.join("\n");
}

function formatViewSitemapEntry(r: any): string {
  const e = r.entry;
  if (!e) return JSON.stringify(r, null, 2);

  const lines: string[] = [`${e.label}  ${e.kind} (id:${e.id})`];

  if (e.metadata) {
    lines.push(
      `  ${e.metadata.isTls ? "https" : "http"} port ${e.metadata.port}`,
    );
  }

  if (e.request) {
    const resp = e.request.response;
    const respInfo = resp
      ? ` -> ${resp.status}${resp.time_ms ? ` ${resp.time_ms}ms` : ""}${resp.size ? ` ${resp.size}B` : ""}`
      : "";
    lines.push(`  ${e.request.method} ${e.request.path ?? "/"}${respInfo}`);
  }

  const rel = e.related_requests;
  if (rel?.requests?.length) {
    lines.push(`\nRelated requests (${rel.total_count} total)`, "");
    for (const req of rel.requests) {
      const status = req.status ? `  ${req.status}` : "";
      const size = req.size ? `  ${req.size}B` : "";
      lines.push(
        `  ${padRight(req.method ?? "?", 7)} ${req.path ?? "/"}${status}${size}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatProxyOutput(toolName: string, result: any): string {
  try {
    switch (toolName) {
      case "list_requests":
        return formatListRequests(result);
      case "view_request":
        return formatViewRequest(result);
      case "send_request":
        return formatSendRequest(result);
      case "scope_rules":
        return formatScopeRules(result);
      case "list_sitemap":
        return formatListSitemap(result);
      case "view_sitemap_entry":
        return formatViewSitemapEntry(result);
      default:
        return JSON.stringify(result, null, 2);
    }
  } catch {
    return JSON.stringify(result, null, 2);
  }
}

export const ProxyToolHandler = ({
  part,
  status,
  toolName,
}: ProxyToolHandlerProps) => {
  const { toolCallId, state, input, output, errorText } = part;

  const displayTarget = useMemo(() => {
    if (!input) return "";
    switch (toolName) {
      case "send_request":
        return input.method && input.url ? `${input.method} ${input.url}` : "";
      case "view_request":
        return input.request_id ? `Request ${input.request_id}` : "";
      case "list_requests":
        return input.httpql_filter || "";
      case "scope_rules":
        return input.action || "";
      case "view_sitemap_entry":
        return input.entry_id ? `Entry ${input.entry_id}` : "";
      default:
        return input.explanation || "";
    }
  }, [input, toolName]);

  const displayCommand = useMemo(() => {
    const parts: string[] = [toolName];
    if (!input) return toolName;
    if (input.request_id) parts.push(`id:${input.request_id}`);
    if (input.method && input.url) parts.push(`${input.method} ${input.url}`);
    if (input.httpql_filter) parts.push(`filter:"${input.httpql_filter}"`);
    if (input.action) parts.push(input.action);
    if (input.entry_id) parts.push(`entry:${input.entry_id}`);
    return parts.join(" ");
  }, [input, toolName]);

  const finalOutput = useMemo(() => {
    if (errorText) return `Error: ${errorText}`;
    if (output?.result?.error) return `Error: ${output.result.error}`;
    if (output?.result) return formatProxyOutput(toolName, output.result);
    return "";
  }, [output, errorText, toolName]);

  const isExecuting = state === "input-available" && status === "streaming";

  const sidebarContent = useMemo((): SidebarProxy | null => {
    if (!input && !errorText && !output?.result?.error) return null;
    return {
      proxyAction: toolName,
      command: displayCommand,
      output: finalOutput,
      isExecuting,
      toolCallId,
    };
  }, [
    input,
    errorText,
    output?.result?.error,
    toolName,
    displayCommand,
    finalOutput,
    isExecuting,
    toolCallId,
  ]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarProxy,
  });

  const getActionText = (): string => {
    if (state === "input-streaming") return "Preparing proxy action";
    if (isExecuting) return PROXY_ACTION_LABELS[toolName] || "Proxying";
    if (output?.result?.error || errorText) return "Proxy action failed";
    return PROXY_COMPLETED_LABELS[toolName] || "Proxied";
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<Radar />}
          action={getActionText()}
          isShimmer={true}
        />
      ) : null;
    case "input-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Radar />}
          action={getActionText()}
          target={displayTarget}
          isShimmer={status === "streaming"}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Radar />}
          action={getActionText()}
          target={displayTarget}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Radar />}
          action="Proxy action failed"
          target={displayTarget}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
};
