"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { isTauriEnvironment } from "@/app/hooks/useTauri";

async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

// GNOME's own automatic suspend ignores the idle inhibitor Desktop holds.
const isLinux = () =>
  typeof navigator !== "undefined" &&
  /Linux/i.test(navigator.userAgent) &&
  !/Android/i.test(navigator.userAgent);

/**
 * Settings > Agents row, saved on this computer only. Hidden outside Desktop
 * and on Desktop builds that predate the setting.
 */
export function KeepAwakeSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let current = true;
    invokeDesktop<unknown>("get_keep_awake_enabled")
      .then((value) => {
        if (current && typeof value === "boolean") setEnabled(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  if (enabled === null) return null;

  const handleCheckedChange = async (next: boolean) => {
    setSaving(true);
    try {
      const applied = await invokeDesktop<unknown>("set_keep_awake_enabled", {
        enabled: next,
      });
      if (typeof applied === "boolean") setEnabled(applied);
    } catch {
      toast.error("Could not save this setting. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between py-3 border-b gap-3">
        <div className="flex-1 min-w-0">
          <div id={titleId} className="font-medium">
            Keep awake while Agent works
          </div>
          <div id={descriptionId} className="text-sm text-muted-foreground">
            Stop this computer from going to sleep while Agent works on it, and
            let it sleep a few minutes after Agent finishes. The display can
            still turn off, and closing a laptop lid still puts it to sleep.
            {isLinux() &&
              " Some Linux desktops' automatic suspend may ignore this."}
          </div>
        </div>
        <Switch
          className="mt-1 shrink-0"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          checked={enabled}
          disabled={saving}
          onCheckedChange={(next) => void handleCheckedChange(next)}
        />
      </div>
    </div>
  );
}
