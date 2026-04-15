"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

interface ByokStatus {
  hasKey: boolean;
  enabled: boolean;
  keyHint: string | null;
}

const ByokSection = () => {
  const [loading, setLoading] = useState(true);
  const [hasKey, setHasKey] = useState(false);
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/byok", { method: "GET" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as ByokStatus;
      setHasKey(!!data.hasKey);
      setKeyHint(data.keyHint ?? null);
      setEnabled(!!data.enabled);
    } catch {
      toast.error("Failed to load API key status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    if (toggling) return;
    if (next && !hasKey) {
      toast.error("Add an API key first");
      return;
    }
    setToggling(true);
    const prev = enabled;
    setEnabled(next);
    try {
      const res = await fetch("/api/byok", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update");
      }
    } catch (err) {
      setEnabled(prev);
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast.error("Enter an API key");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        toast.error(data.error || "Failed to save API key");
        setApiKey("");
        return;
      }
      toast.success(hasKey ? "API key updated" : "API key saved");
      setApiKey("");
      await refresh();
    } catch {
      toast.error("Failed to save API key");
      setApiKey("");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex items-center justify-center py-10 text-muted-foreground"
        role="status"
        aria-label="Loading API key status"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h4 className="text-sm font-medium">OpenRouter API Key</h4>
          <p className="text-sm text-muted-foreground">
            Put in{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              your OpenRouter key
            </a>{" "}
            to route LLM calls through your account. Sandbox and tools still
            bill to your HackerAI plan.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={toggling || !hasKey}
          onCheckedChange={handleToggle}
          aria-label="Use my OpenRouter API key"
          data-testid="byok-toggle"
        />
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            hasKey
              ? (keyHint ?? "Enter a new key to replace the saved one")
              : "Enter your OpenRouter API Key"
          }
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
          data-testid="byok-input"
        />
        <Button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          data-testid="byok-save-button"
        >
          {saving ? "Validating…" : "Save"}
        </Button>
      </div>
    </div>
  );
};

export { ByokSection };
