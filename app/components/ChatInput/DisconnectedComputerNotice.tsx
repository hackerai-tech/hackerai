"use client";

import { Button } from "@/components/ui/button";
import { SandboxSelector } from "../SandboxSelector";
import { useState } from "react";
import type { SetSandboxPreference } from "@/app/hooks/useSandboxPreference";

export function DisconnectedComputerNotice({
  isNewChat,
  sandboxPreference,
  onSelect,
  onReconnect,
  reconnecting,
  reconnectInstructions,
  confirmEnvironmentChange = false,
}: {
  isNewChat: boolean;
  sandboxPreference: string;
  onSelect: SetSandboxPreference;
  onReconnect: () => void;
  reconnecting: boolean;
  reconnectInstructions?: string;
  confirmEnvironmentChange?: boolean;
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  return (
    <div
      role="status"
      className="computer-reconnection-warning mb-2 flex flex-col gap-2 rounded-lg border border-amber-500/25 px-3 py-2 text-sm text-foreground sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">Your selected computer is disconnected.</p>
        <p className="text-muted-foreground">
          {isNewChat
            ? "Reconnect or choose another environment to start."
            : "Reconnect before sending more commands, or choose another environment."}
        </p>
        {!sandboxPreference.startsWith("desktop") &&
          sandboxPreference !== "e2b" && (
            <p className="mt-1 text-xs text-muted-foreground">
              Select the runner whose connection ID matches the one printed in
              your terminal. Older saved runner selections need to be
              reselected.
            </p>
          )}
        {showInstructions && reconnectInstructions && (
          <p className="mt-1">{reconnectInstructions}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (reconnectInstructions) setShowInstructions(true);
            else onReconnect();
          }}
          disabled={reconnecting}
        >
          {reconnecting ? "Reconnecting..." : "Reconnect"}
        </Button>
        <SandboxSelector
          value={sandboxPreference}
          onChange={onSelect}
          triggerLabel="Choose another environment"
          confirmEnvironmentChange={confirmEnvironmentChange}
          menuAlign="end"
        />
      </div>
    </div>
  );
}
