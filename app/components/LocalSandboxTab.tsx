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
} from "lucide-react";
import { toast } from "sonner";

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
}

export function LocalSandboxTab() {
  const [showToken, setShowToken] = useState(false);

  
  const connections = useQuery(api.localSandbox.listConnections);
  
  const tokenResult = useMutation(api.localSandbox.getToken);
  
  const regenerateToken = useMutation(api.localSandbox.regenerateToken);

  const [token, setToken] = useState<string | null>(null);
  const [isLoadingToken, setIsLoadingToken] = useState(false);

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
    <div className="space-y-6">
      {/* Active Connections */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Server className="h-5 w-5" />
          <h3 className="font-semibold">Active Connections</h3>
        </div>
        {connections && connections.length > 0 ? (
          <div className="space-y-2">
            {(connections as LocalConnection[]).map((conn) => (
              <div
                key={conn.connectionId}
                className="flex items-center gap-3 p-3 border rounded-lg"
              >
                <Circle className="h-3 w-3 fill-green-500 text-green-500" />
                <div className="flex-1">
                  <div className="font-medium">{conn.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {conn.mode === "docker"
                      ? `Docker: ${conn.containerId?.slice(0, 12) || "unknown"}`
                      : `Dangerous: ${conn.osInfo?.platform || "unknown"} ${conn.osInfo?.arch || ""}`}
                  </div>
                </div>
                {conn.mode === "dangerous" && (
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 border rounded-lg text-center text-muted-foreground">
            <Circle className="h-4 w-4 fill-gray-400 text-gray-400 mx-auto mb-2" />
            <p className="font-medium">No active connections</p>
            <p className="text-sm">Run the command below to connect</p>
          </div>
        )}
      </div>

      {/* Token Management */}
      <div className="space-y-4 border-t pt-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          <h3 className="font-semibold">Authentication Token</h3>
        </div>

        {!token ? (
          <Button
            onClick={handleGetToken}
            disabled={isLoadingToken}
            variant="outline"
          >
            {isLoadingToken ? "Loading..." : "Get Token"}
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                readOnly
                className="font-mono text-sm"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
              <Button variant="outline" size="icon" onClick={handleCopyToken}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerateToken}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Regenerate Token
              </Button>
            </div>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          Keep this token secret. Regenerating will disconnect any running
          clients.
        </p>
      </div>

      {/* Setup Commands */}
      <div className="space-y-4 border-t pt-4">
        <h3 className="font-semibold">Setup Commands</h3>

        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium mb-1">Basic (Docker)</div>
            <div className="flex gap-2">
              <code className="text-xs bg-muted p-2 rounded flex-1 overflow-x-auto">
                pnpm local-sandbox --token{" "}
                {showToken && token ? token : "YOUR_TOKEN"} --name &quot;My
                Laptop&quot;
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  handleCopyCommand(
                    `pnpm local-sandbox --token ${token || "YOUR_TOKEN"} --name "My Laptop"`,
                  )
                }
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-1">
              Custom Image (Kali Linux)
            </div>
            <div className="flex gap-2">
              <code className="text-xs bg-muted p-2 rounded flex-1 overflow-x-auto">
                pnpm local-sandbox --token{" "}
                {showToken && token ? token : "YOUR_TOKEN"} --name &quot;Kali&quot;
                --image kalilinux/kali-rolling
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  handleCopyCommand(
                    `pnpm local-sandbox --token ${token || "YOUR_TOKEN"} --name "Kali" --image kalilinux/kali-rolling`,
                  )
                }
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-1 flex items-center gap-2">
              Dangerous Mode (No Docker)
              <AlertTriangle className="h-3 w-3 text-yellow-500" />
            </div>
            <div className="flex gap-2">
              <code className="text-xs bg-muted p-2 rounded flex-1 overflow-x-auto">
                pnpm local-sandbox --token{" "}
                {showToken && token ? token : "YOUR_TOKEN"} --name &quot;Work
                PC&quot; --dangerous
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  handleCopyCommand(
                    `pnpm local-sandbox --token ${token || "YOUR_TOKEN"} --name "Work PC" --dangerous`,
                  )
                }
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
              Commands run directly on host OS - no isolation
            </p>
          </div>
        </div>
      </div>

      {/* Security Warning */}
      <div className="p-4 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg">
        <div className="text-sm space-y-2">
          <div className="font-semibold text-yellow-900 dark:text-yellow-100">
            Security Notice
          </div>
          <ul className="list-disc list-inside space-y-1 text-yellow-800 dark:text-yellow-200">
            <li>The AI will have access to your local network</li>
            <li>Docker mode: Commands run in isolated container</li>
            <li>Dangerous mode: Commands run directly on your OS</li>
            <li>Stop anytime with Ctrl+C</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
