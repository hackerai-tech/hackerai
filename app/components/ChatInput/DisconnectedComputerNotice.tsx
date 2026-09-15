"use client";

import { Button } from "@/components/ui/button";
import { SandboxSelector } from "../SandboxSelector";
import { useState } from "react";

export function DisconnectedComputerNotice({
  sandboxPreference,
  onSelect,
  onReconnect,
  reconnecting,
  reconnectInstructions,
}: {
  sandboxPreference: string;
  onSelect: (value: string) => void;
  onReconnect: () => void;
  reconnecting: boolean;
  reconnectInstructions?: string;
}) {
  const [showInstructions, setShowInstructions] = useState(false);
  return (
    <div
      role="status"
      className="mb-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
    >
      <p className="font-medium">Your computer is disconnected.</p>
      <p>Reconnect it to continue this task.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
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
        />
      </div>
      {showInstructions && reconnectInstructions && (
        <p className="mt-2">{reconnectInstructions}</p>
      )}
    </div>
  );
}
