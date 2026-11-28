"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Switch } from "@/components/ui/switch";

/** Settings > Agents row, saved to the account so it applies on every computer. */
export function DesktopManualResumeSetting() {
  const required = useQuery(
    api.agentLocalAutoContinues.getManualResumePreference,
    {},
  );
  const save = useMutation(
    api.agentLocalAutoContinues.setManualResumePreference,
  );
  const [pending, setPending] = useState<boolean | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Hidden while loading and when the account cannot read the preference.
  if (typeof required !== "boolean") return null;

  const handleCheckedChange = async (next: boolean) => {
    setPending(next);
    try {
      await save({ required: next });
    } catch {
      toast.error("Could not save this setting. Try again.");
    } finally {
      // Fall back to the persisted value, which is unchanged after a failure.
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between py-3 border-b gap-3">
        <div className="flex-1 min-w-0">
          <div id={titleId} className="font-medium">
            Require manual Resume
          </div>
          <div id={descriptionId} className="text-sm text-muted-foreground">
            After Desktop reconnects, the run waits for you to click Resume.
          </div>
        </div>
        <Switch
          className="mt-1 shrink-0"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          checked={pending ?? required}
          disabled={pending !== null}
          onCheckedChange={(next) => void handleCheckedChange(next)}
        />
      </div>
    </div>
  );
}
