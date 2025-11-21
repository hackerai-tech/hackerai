"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Copy,
  Check,
  RefreshCw,
  Eye,
  EyeOff,
  Circle,
  CheckCircle2,
  XCircle,
  Terminal,
  Network,
  Shield,
  Zap,
} from "lucide-react";

const LocalSandboxTab = () => {
  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [lastPing, setLastPing] = useState<number | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(true);

  // Token state
  const [sandboxToken, setSandboxToken] = useState<string>("");
  const [showToken, setShowToken] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [loadingToken, setLoadingToken] = useState(true);

  // Fetch sandbox token on mount
  useEffect(() => {
    const fetchToken = async () => {
      try {
        const response = await fetch("/api/local-sandbox/token");
        if (response.ok) {
          const data = await response.json();
          setSandboxToken(data.token);
        }
      } catch (error) {
        console.error("Failed to fetch sandbox token:", error);
      } finally {
        setLoadingToken(false);
      }
    };
    fetchToken();
  }, []);

  // Poll connection status
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const response = await fetch("/api/local-sandbox");
        const data = await response.json();
        setIsConnected(data.connected);
        setLastPing(data.lastPing);
      } catch {
        setIsConnected(false);
        setLastPing(null);
      } finally {
        setCheckingConnection(false);
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 5000); // Poll every 5s

    return () => clearInterval(interval);
  }, []);

  const handleCopyToken = () => {
    navigator.clipboard.writeText(sandboxToken);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  };

  const handleRegenerateToken = async () => {
    setRegenerating(true);
    try {
      const response = await fetch("/api/local-sandbox/token", {
        method: "POST",
      });
      if (response.ok) {
        const data = await response.json();
        setSandboxToken(data.token);
      }
    } catch (error) {
      console.error("Failed to regenerate token:", error);
    } finally {
      setRegenerating(false);
    }
  };

  const handleCopyCommand = async () => {
    try {
      const command = `npm run local-sandbox -- --auth-token ${sandboxToken}`;
      await navigator.clipboard.writeText(command);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
    } catch (error) {
      console.error("Failed to copy command:", error);
    }
  };

  return (
    <div className="space-y-6 min-h-0">
      {/* Connection Status Section */}
      <div className="border-b pb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-medium text-lg">Connection Status</div>
            <div className="text-sm text-muted-foreground mt-1">
              Monitor your local sandbox connection
            </div>
          </div>
          {checkingConnection ? (
            <Badge variant="secondary" className="gap-1.5">
              <Circle className="h-3 w-3 animate-pulse" />
              Checking...
            </Badge>
          ) : isConnected ? (
            <Badge variant="default" className="gap-1.5 bg-green-600">
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1.5">
              <XCircle className="h-3 w-3" />
              Disconnected
            </Badge>
          )}
        </div>

        {isConnected ? (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold text-sm text-green-900 dark:text-green-100">
                    Local sandbox is active
                  </h4>
                  <Badge variant="default" className="text-xs">
                    🐳 Docker
                  </Badge>
                </div>
                <p className="text-xs text-green-700 dark:text-green-300 mt-1">
                  Commands execute in isolated Docker container with full network access.
                </p>
                {lastPing && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-2">
                    Last ping: {new Date(lastPing).toLocaleTimeString()}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-muted/50 border rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Terminal className="h-5 w-5 text-muted-foreground mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-sm">
                  Using cloud sandbox (E2B)
                </h4>
                <p className="text-xs text-muted-foreground mt-1">
                  Commands are running in the cloud. Start the local client to use your machine.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Features Comparison */}
      <div className="border-b pb-6">
        <h3 className="font-medium mb-3">Why Use Local Mode?</h3>
        <div className="grid gap-3">
          <div className="flex items-start gap-3">
            <Network className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-sm">Full Network Access</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Scan your local network (192.168.x.x), access localhost services
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-sm">Docker Isolated</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Runs in isolated container, protected from host system
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Auth Token Section */}
      <div className="border-b pb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-medium">Authentication Token</div>
            <div className="text-sm text-muted-foreground mt-1">
              Use this token to authenticate your local client
            </div>
          </div>
        </div>

        {loadingToken ? (
          <div className="flex items-center justify-center py-8">
            <Circle className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : sandboxToken ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <input
                  type={showToken ? "text" : "password"}
                  value={sandboxToken}
                  readOnly
                  className="w-full px-3 py-2 pr-10 text-sm bg-muted rounded-md font-mono"
                />
                <button
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-background rounded"
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyToken}
                className="shrink-0"
              >
                {copiedToken ? (
                  <>
                    <Check className="h-4 w-4 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerateToken}
                disabled={regenerating}
                className="shrink-0"
              >
                <RefreshCw
                  className={`h-4 w-4 mr-1 ${regenerating ? "animate-spin" : ""}`}
                />
                {regenerating ? "Regenerating..." : "Regenerate"}
              </Button>
            </div>

            <div className="text-xs text-muted-foreground">
              Keep this token secure. Regenerating will invalidate the old token.
            </div>
          </div>
        ) : (
          <div className="text-sm text-destructive">
            Failed to load token. Please refresh the page.
          </div>
        )}
      </div>

      {/* Setup Instructions */}
      <div>
        <h3 className="font-medium mb-3">Quick Start</h3>
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium mb-2">1. Prerequisites</div>
            <div className="text-xs text-muted-foreground">
              Install and run Docker Desktop
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-2">2. Run the client</div>
            <div className="bg-muted/50 border rounded-md p-3">
              <code className="block text-xs font-mono break-all">
                npm run local-sandbox -- --auth-token {sandboxToken.substring(0, 20)}
                {sandboxToken.length > 20 ? "..." : ""}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyCommand}
                className="mt-2 h-7 text-xs"
              >
                {copiedCommand ? (
                  <>
                    <Check className="h-3 w-3 mr-1" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3 mr-1" />
                    Copy full command
                  </>
                )}
              </Button>
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-2">3. Wait for confirmation</div>
            <div className="text-xs text-muted-foreground">
              You'll see "Local sandbox is ready!" when connected. The status badge above will
              turn green.
            </div>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md p-3">
            <h4 className="font-semibold text-sm mb-1">🐳 Docker Isolation</h4>
            <p className="text-xs text-muted-foreground">
              Commands run in an isolated Docker container with host networking.
              The filesystem is isolated, protecting your host machine from unwanted file modifications.
              Network access is shared with your host for local network scanning.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Press Ctrl+C in the terminal to stop the client anytime. The Docker container will be automatically removed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export { LocalSandboxTab };
