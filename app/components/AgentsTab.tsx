"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGlobalState } from "@/app/contexts/GlobalState";
import type { QueueBehavior } from "@/types/chat";
import { SandboxSelector } from "@/app/components/SandboxSelector";

const AgentsTab = () => {
  const {
    queueBehavior,
    setQueueBehavior,
    subscription,
    sandboxPreference,
    setSandboxPreference,
  } = useGlobalState();

  const queueBehaviorOptions: Array<{
    value: QueueBehavior;
    label: string;
  }> = [
    {
      value: "queue",
      label: "Queue after current message",
    },
    {
      value: "stop-and-send",
      label: "Stop & send right away",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Execution Environment - Available to all users */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
          <div className="flex-1">
            <div className="font-medium">Default execution environment</div>
            <div className="text-sm text-muted-foreground">
              Choose the default sandbox environment for Agent mode
            </div>
          </div>
          <div className="w-full sm:w-auto">
            <SandboxSelector
              value={sandboxPreference}
              onChange={setSandboxPreference}
              disabled={false}
              size="md"
            />
          </div>
        </div>
      </div>

      {/* Caido proxy temporarily disabled for all users.
          Kill switch lives in lib/api/chat-handler.ts (caidoEnabled forced false).
      {subscription !== "free" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b">
            <div className="flex-1 pr-4">
              <Label
                htmlFor="caido-proxy"
                className="font-medium cursor-pointer"
              >
                Caido Proxy
              </Label>
              <p className="text-sm text-muted-foreground">
                Intercept and inspect all HTTP/HTTPS traffic through Caido
              </p>
            </div>
            <Switch
              id="caido-proxy"
              checked={userCustomization?.caido_enabled ?? false}
              onCheckedChange={async (checked) => {
                try {
                  await saveCustomization({ caido_enabled: checked });
                  toast.success(
                    checked ? "Caido proxy enabled" : "Caido proxy disabled",
                  );
                } catch {
                  toast.error("Failed to update Caido setting");
                }
              }}
              aria-label="Toggle Caido proxy"
            />
          </div>
          {(userCustomization?.caido_enabled ?? false) && (
            <div className="flex items-center justify-between py-3 border-b pl-4">
              <div className="flex-1 pr-4">
                <Label
                  htmlFor="caido-port"
                  className="font-medium cursor-pointer"
                >
                  Custom Port
                </Label>
                <p className="text-sm text-muted-foreground">
                  Connect to your own Caido instance (local sandbox only). Leave
                  empty for default (48080).
                </p>
              </div>
              <input
                id="caido-port"
                type="number"
                min={1}
                max={65535}
                placeholder="48080"
                className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                defaultValue={userCustomization?.caido_port ?? ""}
                onBlur={async (e) => {
                  const raw = e.target.value.trim();
                  const port = raw ? Number(raw) : 0;
                  if (
                    raw &&
                    (isNaN(port) ||
                      !Number.isInteger(port) ||
                      port < 1 ||
                      port > 65535)
                  ) {
                    toast.error("Port must be an integer between 1 and 65535");
                    return;
                  }
                  try {
                    await saveCustomization({ caido_port: port || undefined });
                    toast.success(
                      port
                        ? `Caido port set to ${port}`
                        : "Caido port reset to default",
                    );
                  } catch {
                    toast.error("Failed to update Caido port");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
      */}

      {/* Queue Messages - Only show for Pro/Ultra/Team users */}
      {subscription !== "free" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
            <div className="flex-1">
              <div className="font-medium">Queue Messages</div>
              <div className="text-sm text-muted-foreground">
                Adjust the default behavior of sending a message while Agent is
                streaming
              </div>
            </div>
            <Select
              value={queueBehavior}
              onValueChange={(value) =>
                setQueueBehavior(value as QueueBehavior)
              }
            >
              <SelectTrigger className="w-full sm:w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {queueBehaviorOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
};

export { AgentsTab };
