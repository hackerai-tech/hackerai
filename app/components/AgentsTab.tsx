"use client";

import { CloudNetworkSettings } from "./CloudNetworkSettings";

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
import { AgentPermissionSelector } from "@/app/components/AgentPermissionSelector";
import { AgentInputNotificationSetting } from "@/app/components/AgentInputNotificationSetting";

const AgentsTab = () => {
  const {
    queueBehavior,
    setQueueBehavior,
    agentSteeringEnabled,
    subscription,
    sandboxPreference,
    setSandboxPreference,
  } = useGlobalState();

  const queueBehaviorOptions: Array<{
    value: QueueBehavior;
    label: string;
  }> = [
    ...(agentSteeringEnabled
      ? [{ value: "steer" as const, label: "Steer the current run" }]
      : []),
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

      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
          <div className="flex-1">
            <div className="font-medium">Default agent permissions</div>
            <div className="text-sm text-muted-foreground">
              Commands and file edits
            </div>
          </div>
          <div className="w-full sm:w-auto">
            <AgentPermissionSelector size="md" analyticsSurface="agents_tab" />
          </div>
        </div>
      </div>

      <AgentInputNotificationSetting />

      {subscription !== "free" && <CloudNetworkSettings />}

      {/* Queue Messages - Only show for Pro/Ultra/Team users */}
      {subscription !== "free" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
            <div className="flex-1">
              <div className="font-medium">
                {agentSteeringEnabled ? "Follow-up Messages" : "Queue Messages"}
              </div>
              <div className="text-sm text-muted-foreground">
                {agentSteeringEnabled
                  ? "What sending does while Agent is working. Steering adds your message before its next step. Press ⌘/Ctrl+Enter to queue instead of steer, or steer instead of queue."
                  : "Adjust the default behavior of sending a message while Agent is streaming"}
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
