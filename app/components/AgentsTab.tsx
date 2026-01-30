"use client";

import React, { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Save, ShieldAlert, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { useGlobalState } from "@/app/contexts/GlobalState";
import type { QueueBehavior } from "@/types/chat";
import { SandboxSelector } from "@/app/components/SandboxSelector";
import {
  type GuardrailConfigUI,
  getDefaultGuardrailsUI,
  parseAndMergeGuardrailsConfig,
  formatGuardrailsConfigForSave,
  hasGuardrailChanges,
} from "@/lib/ai/tools/utils/guardrails";

const severityColors: Record<GuardrailConfigUI["severity"], string> = {
  critical: "text-red-500",
  high: "text-orange-500",
  medium: "text-yellow-500",
  low: "text-blue-500",
};

const AgentsTab = () => {
  const {
    queueBehavior,
    setQueueBehavior,
    subscription,
    sandboxPreference,
    setSandboxPreference,
  } = useGlobalState();

  const [guardrails, setGuardrails] = useState<GuardrailConfigUI[]>(
    getDefaultGuardrailsUI(),
  );
  const [guardrailsExpanded, setGuardrailsExpanded] = useState(false);
  const [isSavingGuardrails, setIsSavingGuardrails] = useState(false);
  const [guardrailChanges, setGuardrailChanges] = useState(false);

  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
    {},
  );
  const saveCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );

  // Load guardrails config
  useEffect(() => {
    if (userCustomization?.guardrails_config !== undefined) {
      const mergedGuardrails = parseAndMergeGuardrailsConfig(
        userCustomization.guardrails_config,
      );
      setGuardrails(mergedGuardrails);
    }
  }, [userCustomization?.guardrails_config]);

  // Track changes for guardrails
  useEffect(() => {
    const hasChanges = hasGuardrailChanges(
      guardrails,
      userCustomization?.guardrails_config,
    );
    setGuardrailChanges(hasChanges);
  }, [guardrails, userCustomization?.guardrails_config]);

  const handleToggleGuardrail = (id: string) => {
    setGuardrails((prev) =>
      prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)),
    );
  };

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

  const handleSaveGuardrails = async () => {
    setIsSavingGuardrails(true);
    try {
      const guardrailsConfig = formatGuardrailsConfigForSave(guardrails);
      await saveCustomization({
        guardrails_config: guardrailsConfig || undefined,
      });
      toast.success("Guardrails saved successfully");
      setGuardrailChanges(false);
    } catch (error) {
      console.error("Failed to save guardrails:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to save guardrails"
          : error instanceof Error
            ? error.message
            : "Failed to save guardrails";
      toast.error(errorMessage);
    } finally {
      setIsSavingGuardrails(false);
    }
  };

  const handleResetGuardrails = () => {
    setGuardrails(getDefaultGuardrailsUI());
  };

  return (
    <div className="space-y-6">
      {/* Queue Messages Section - Only show for Pro/Ultra/Team users */}
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
      )}

      {/* Security Guardrails Section - Only show for Pro/Ultra/Team users */}
      {subscription !== "free" && (
        <div className="space-y-4 pt-2">
          <button
            onClick={() => setGuardrailsExpanded(!guardrailsExpanded)}
            className="flex items-center justify-between w-full border-b pb-3 hover:opacity-80 transition-opacity"
            type="button"
            aria-expanded={guardrailsExpanded}
            aria-label="Toggle security guardrails section"
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Security Guardrails</h3>
            </div>
            {guardrailsExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {guardrailsExpanded && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 bg-amber-500/10 rounded-lg text-xs">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="text-amber-800 dark:text-amber-200">
                  <span className="font-medium">
                    Security guardrails protect against dangerous commands.
                  </span>{" "}
                  <span className="text-amber-700 dark:text-amber-300">
                    These safeguards block destructive system commands, reverse
                    shells, and other malicious patterns. Disable at your own
                    risk.
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                {guardrails.map((guardrail) => (
                  <div
                    key={guardrail.id}
                    className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1 pr-4">
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={guardrail.id}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {guardrail.name}
                        </Label>
                        <span
                          className={`text-[10px] font-medium uppercase ${severityColors[guardrail.severity]}`}
                        >
                          {guardrail.severity}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {guardrail.description}
                      </p>
                    </div>
                    <Switch
                      id={guardrail.id}
                      checked={guardrail.enabled}
                      onCheckedChange={() =>
                        handleToggleGuardrail(guardrail.id)
                      }
                      aria-label={`Toggle ${guardrail.name}`}
                    />
                  </div>
                ))}
              </div>

              <div className="flex justify-between pt-2">
                <Button
                  variant="outline"
                  onClick={handleResetGuardrails}
                  size="sm"
                  type="button"
                >
                  Reset to Defaults
                </Button>
                <Button
                  onClick={handleSaveGuardrails}
                  disabled={isSavingGuardrails || !guardrailChanges}
                  size="sm"
                  type="button"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {isSavingGuardrails ? "Saving..." : "Save Guardrails"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export { AgentsTab };
