"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Circle,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  AlertTriangle,
  Terminal,
  Server,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

// Production Convex URL (must match @hackerai/local@latest package)
const PRODUCTION_CONVEX_URL = "https://convex.haiusercontent.com";

// Add --convex-url flag if running against non-production backend
const convexUrlFlag =
  process.env.NEXT_PUBLIC_CONVEX_URL &&
  process.env.NEXT_PUBLIC_CONVEX_URL !== PRODUCTION_CONVEX_URL
    ? ` --convex-url ${process.env.NEXT_PUBLIC_CONVEX_URL}`
    : "";

// Use local path in dev (next dev), npx in production/preview
const runCommand =
  process.env.NODE_ENV === "development"
    ? "node packages/local/dist/index.js"
    : "npx @hackerai/local@latest";

interface LocalConnection {
  connectionId: string;
  name: string;
  mode: "docker" | "dangerous";
  containerId?: string;
  osInfo?: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
  };
  lastSeen: number;
}

interface CommandBlockProps {
  label: string;
  command: string;
  onCopy: () => void;
  warning?: boolean;
}

const CommandBlock = ({
  label,
  command,
  onCopy,
  warning,
}: CommandBlockProps) => (
  <div className="space-y-1.5">
    <div
      className={`text-xs font-medium flex items-center gap-1.5 ${warning ? "text-yellow-700 dark:text-yellow-400" : ""}`}
    >
      {label}
      {warning && <AlertTriangle className="h-3 w-3" />}
    </div>
    <div className="flex gap-2">
      <code
        className={`flex-1 p-2.5 rounded-lg font-mono text-xs overflow-x-auto ${
          warning
            ? "bg-yellow-500/5 border border-yellow-500/20 text-yellow-900 dark:text-yellow-100"
            : "bg-zinc-900 dark:bg-zinc-950 text-zinc-300 dark:text-zinc-400"
        }`}
      >
        {command}
      </code>
      <Button
        variant="outline"
        size="icon"
        className="shrink-0 h-9 w-9"
        onClick={onCopy}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
    {warning && (
      <p className="text-xs text-yellow-600 dark:text-yellow-400">
        Commands run directly on host OS - no isolation
      </p>
    )}
  </div>
);

const LocalSandboxTab = () => {
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [isLoadingToken, setIsLoadingToken] = useState(false);

  const connections = useQuery(api.localSandbox.listConnections);
  const tokenResult = useMutation(api.localSandbox.getToken);
  const regenerateToken = useMutation(api.localSandbox.regenerateToken);

  const handleGetToken = async () => {
    setIsLoadingToken(true);
    try {
      const result = await tokenResult();
      setToken(result.token);
    } catch (error) {
      console.error("Failed to get token:", error);
      toast.error("Failed to get token");
    } finally {
      setIsLoadingToken(false);
    }
  };

  const handleRegenerateToken = async () => {
    try {
      const result = await regenerateToken();
      setToken(result.token);
      toast.success("Token regenerated successfully");
      setShowToken(false);
    } catch (error) {
      console.error("Failed to regenerate token:", error);
      toast.error("Failed to regenerate token");
    }
  };

  const handleCopyCommand = (command: string) => {
    navigator.clipboard.writeText(command);
    toast.success("Command copied to clipboard");
  };

  const handleCopyToken = () => {
    if (token) {
      navigator.clipboard.writeText(token);
      toast.success("Token copied to clipboard");
    }
  };

  return (
    <div className="space-y-5">
      {/* Section Header */}
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Local Sandbox</h3>
        </div>
        <a
          href="https://help.hackerai.co/en/articles/12961920-connecting-a-hackerai-agent-to-your-local-machine"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>Learn more</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Active Connections */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Connections
        </h4>
        {connections && connections.length > 0 ? (
          <div className="space-y-2">
            {connections.map((conn) => (
              <div
                key={conn.connectionId}
                className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg"
              >
                <div className="relative">
                  <Circle className="h-2.5 w-2.5 fill-green-500 text-green-500" />
                  <Circle className="h-2.5 w-2.5 fill-green-500 text-green-500 absolute inset-0 animate-ping opacity-75" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{conn.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {conn.mode === "docker"
                      ? `Docker: ${conn.containerId?.slice(0, 12) || "unknown"}`
                      : `${conn.osInfo?.platform || "unknown"} ${conn.osInfo?.arch || ""}`}
                  </div>
                </div>
                {conn.mode === "dangerous" && (
                  <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-100 dark:bg-yellow-900/30 px-2 py-0.5 rounded-full">
                    <AlertTriangle className="h-3 w-3" />
                    Dangerous
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 px-4 bg-muted/30 rounded-lg">
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center mb-2">
              <Server className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No active connections</p>
            <p className="text-xs text-muted-foreground">
              Connect using the commands below
            </p>
          </div>
        )}
      </div>

      {/* Token Management */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Auth Token
          </h4>
          {token && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleRegenerateToken}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Regenerate
            </Button>
          )}
        </div>

        {!token ? (
          <Button
            onClick={handleGetToken}
            disabled={isLoadingToken}
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
          >
            <Terminal className="h-3.5 w-3.5 mr-2" />
            {isLoadingToken ? "Loading..." : "Generate Token"}
          </Button>
        ) : (
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                readOnly
                className="font-mono text-xs pr-20 bg-muted/50 border-0"
              />
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={handleCopyToken}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Setup Commands */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Quick Start
        </h4>

        <div className="space-y-4">
          {/* Docker command */}
          <CommandBlock
            label="Basic (Docker)"
            command={`${runCommand} --token ${showToken && token ? token : "<token>"} --name "My Machine"${convexUrlFlag}`}
            onCopy={() =>
              handleCopyCommand(
                `${runCommand} --token ${token || "YOUR_TOKEN"} --name "My Machine"${convexUrlFlag}`,
              )
            }
          />

          {/* Dangerous mode */}
          <CommandBlock
            label="Dangerous Mode (No Docker)"
            warning
            command={`${runCommand} --token ${showToken && token ? token : "<token>"} --name "Host" --dangerous${convexUrlFlag}`}
            onCopy={() =>
              handleCopyCommand(
                `${runCommand} --token ${token || "YOUR_TOKEN"} --name "Host" --dangerous${convexUrlFlag}`,
              )
            }
          />
        </div>
      </div>

      {/* Security Notice - Compact */}
      <div className="flex items-start gap-2 p-3 bg-yellow-500/10 rounded-lg text-xs">
        <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
        <div className="text-yellow-800 dark:text-yellow-200 space-y-1">
          <span className="font-medium">Security:</span>{" "}
          <span className="text-yellow-700 dark:text-yellow-300">
            Docker mode runs in isolation. Dangerous mode has direct OS access.
            Stop anytime with Ctrl+C.
          </span>
        </div>
      </div>
    </div>
  );
};

export { LocalSandboxTab };
