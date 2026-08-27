"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Circle,
  Copy,
  RefreshCw,
  AlertTriangle,
  Terminal,
  Server,
  ExternalLink,
  LoaderCircle,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { runCommand, convexUrlFlag } from "@/lib/utils/sandbox-command";
import { useGlobalState } from "@/app/contexts/GlobalState";
import type {
  ChatMode,
  SandboxPreference,
  SelectedModel,
  SubscriptionTier,
} from "@/types/chat";

interface LocalConnection {
  connectionId: string;
  name: string;
  osInfo?: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
  };
  lastSeen: number;
  isDesktop: boolean;
}

interface UseAutoSelectNewRemoteConnectionArgs {
  connections: LocalConnection[] | undefined;
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  subscription: SubscriptionTier;
  sandboxPreference: SandboxPreference;
  setSandboxPreference: (preference: SandboxPreference) => void;
  selectedModel: SelectedModel;
  setSelectedModel: (model: SelectedModel) => void;
  onNewConnection?: () => void;
}

function useAutoSelectNewRemoteConnection({
  connections,
  chatMode,
  setChatMode,
  subscription,
  sandboxPreference,
  setSandboxPreference,
  selectedModel,
  setSelectedModel,
  onNewConnection,
}: UseAutoSelectNewRemoteConnectionArgs) {
  const previousRemoteConnectionIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (connections === undefined) return;

    const remoteConnections = connections.filter((conn) => !conn.isDesktop);
    const currentIds = new Set(
      remoteConnections.map((conn) => conn.connectionId),
    );
    const previousIds = previousRemoteConnectionIdsRef.current;
    previousRemoteConnectionIdsRef.current = currentIds;

    // Treat the first loaded query result as baseline so existing connections
    // do not hijack the user's saved mode on settings open or page load.
    if (previousIds === null) return;

    const newConnection = remoteConnections.find(
      (conn) => !previousIds.has(conn.connectionId),
    );
    if (!newConnection) return;

    onNewConnection?.();

    if (sandboxPreference !== newConnection.connectionId) {
      setSandboxPreference(newConnection.connectionId);
    }

    if (subscription === "free" && selectedModel !== "auto") {
      setSelectedModel("auto");
    }

    if (chatMode !== "agent") {
      setChatMode("agent");
      toast.success("Local sandbox connected. Switched to Agent mode.");
    } else {
      toast.success("Local sandbox connected.");
    }
  }, [
    chatMode,
    connections,
    onNewConnection,
    sandboxPreference,
    selectedModel,
    setChatMode,
    setSandboxPreference,
    setSelectedModel,
    subscription,
  ]);
}

const RemoteControlTab = () => {
  const [token, setToken] = useState<string | null>(null);
  const [isPreparingCommand, setIsPreparingCommand] = useState(false);
  const [isResettingToken, setIsResettingToken] = useState(false);
  const [isCommandCopied, setIsCommandCopied] = useState(false);
  const [showConnectSetup, setShowConnectSetup] = useState(false);
  const copiedResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const {
    chatMode,
    setChatMode,
    subscription,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
    localConnections: connections,
  } = useGlobalState();

  const tokenResult = useMutation(api.localSandbox.getToken);
  const regenerateToken = useMutation(api.localSandbox.regenerateToken);
  const hideConnectSetup = useCallback(() => setShowConnectSetup(false), []);

  useAutoSelectNewRemoteConnection({
    chatMode,
    connections,
    sandboxPreference,
    selectedModel,
    setChatMode,
    setSandboxPreference,
    setSelectedModel,
    subscription,
    onNewConnection: hideConnectSetup,
  });

  useEffect(
    () => () => {
      if (copiedResetTimeoutRef.current) {
        clearTimeout(copiedResetTimeoutRef.current);
      }
    },
    [],
  );

  const activeConnections = connections ?? [];

  const handleCopyConnectCommand = async () => {
    setIsPreparingCommand(true);

    try {
      const commandPromise = (async () => {
        let commandToken = token;

        if (!commandToken) {
          const result = await tokenResult();
          commandToken = result.token;
          setToken(commandToken);
        }

        return `${runCommand} --token ${commandToken}${convexUrlFlag}`;
      })();

      // Start the clipboard write during the click gesture. Safari can expire
      // clipboard permission while waiting for the token request to finish.
      if (
        typeof ClipboardItem !== "undefined" &&
        typeof navigator.clipboard.write === "function"
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": commandPromise.then(
              (command) => new Blob([command], { type: "text/plain" }),
            ),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(await commandPromise);
      }

      if (copiedResetTimeoutRef.current) {
        clearTimeout(copiedResetTimeoutRef.current);
      }
      setIsCommandCopied(true);
      copiedResetTimeoutRef.current = setTimeout(() => {
        setIsCommandCopied(false);
        copiedResetTimeoutRef.current = null;
      }, 2_000);
      toast.success("Connect command copied. Paste it into your terminal.");
    } catch (error) {
      console.error("Failed to prepare connect command:", error);
      toast.error("Failed to copy connect command");
    } finally {
      setIsPreparingCommand(false);
    }
  };

  const handleRegenerateToken = async () => {
    setIsResettingToken(true);

    try {
      const result = await regenerateToken();
      setToken(result.token);
      if (copiedResetTimeoutRef.current) {
        clearTimeout(copiedResetTimeoutRef.current);
        copiedResetTimeoutRef.current = null;
      }
      setIsCommandCopied(false);
      toast.success("Access token reset. Existing connections were stopped.");
    } catch (error) {
      console.error("Failed to regenerate token:", error);
      toast.error("Failed to reset access token");
    } finally {
      setIsResettingToken(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Section Header */}
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Remote Control</h3>
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
        {activeConnections.length > 0 ? (
          <div className="space-y-2">
            {activeConnections.map((conn) => (
              <div
                key={conn.connectionId}
                className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg"
              >
                <div className="relative">
                  <Circle className="h-2.5 w-2.5 fill-green-500 text-green-500" />
                  <Circle className="h-2.5 w-2.5 fill-green-500 text-green-500 absolute inset-0 animate-ping opacity-75" />
                </div>
                <Server className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">
                    {conn.osInfo?.hostname || conn.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {conn.isDesktop
                      ? "Desktop app connected"
                      : "Remote Control connected"}
                  </div>
                </div>
              </div>
            ))}
            {!showConnectSetup ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setShowConnectSetup(true)}
              >
                <Terminal className="mr-2 h-3.5 w-3.5" />
                Connect another machine
              </Button>
            ) : null}
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

      {/* Quick Connect */}
      {activeConnections.length === 0 || showConnectSetup ? (
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {activeConnections.length > 0
              ? "Connect Another Machine"
              : "Quick Start"}
          </h4>
          <div className="overflow-hidden rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2 p-2">
              <Terminal className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2 font-mono text-xs text-foreground">
                {`${runCommand} --token <token>${convexUrlFlag}`}
              </code>
              <Button
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={handleCopyConnectCommand}
                disabled={isPreparingCommand || isResettingToken}
                aria-label={
                  isPreparingCommand
                    ? "Preparing connect command"
                    : isCommandCopied
                      ? "Connect command copied"
                      : "Copy connect command"
                }
              >
                {isPreparingCommand ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : isCommandCopied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                <span aria-live="polite">
                  {isPreparingCommand
                    ? "Preparing..."
                    : isCommandCopied
                      ? "Copied"
                      : "Copy command"}
                </span>
              </Button>
            </div>
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              {isPreparingCommand
                ? "Preparing connect command..."
                : "Secure token included automatically when copied."}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Paste and run it in your terminal to connect this machine.
            </p>
            {token ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleRegenerateToken}
                disabled={isPreparingCommand || isResettingToken}
              >
                <RefreshCw
                  className={`mr-1 h-3 w-3 ${isResettingToken ? "animate-spin" : ""}`}
                />
                {isResettingToken ? "Resetting..." : "Reset token"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Security Notice - Compact */}
      <div className="flex items-start gap-2 p-3 bg-yellow-500/10 rounded-lg text-xs">
        <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
        <div className="text-yellow-800 dark:text-yellow-200 space-y-1">
          <span className="font-medium">Security:</span>{" "}
          <span className="text-yellow-700 dark:text-yellow-300">
            Commands run directly on your OS. Stop anytime with Ctrl+C.
          </span>
        </div>
      </div>
    </div>
  );
};

export { RemoteControlTab };
